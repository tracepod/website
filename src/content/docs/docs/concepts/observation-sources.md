---
title: Observation sources & confidence
description: How Tracepod records why each file is in the manifest, and how the confidence score quantifies profiling coverage.
---

Every file in a Tracepod profile carries an **observation source** recording how it was discovered. This distinction is the foundation of confidence scoring and audit trails — it is never flattened into a plain file list.

## The five observation sources

| Source | Meaning |
|--------|---------|
| `direct` | Observed by an eBPF kprobe — the file was opened, exec'd, or mapped executable during profiling. |
| `inferred-elf` | An ELF shared-library dependency resolved from a `direct` binary by the hardener's ELF resolver. |
| `inferred-runtime` | Added by a language-runtime companion rule at build time — e.g. a CPython `__pycache__` pyc implies its sibling `.py` source, which the interpreter stats but never opens. |
| `directory-inclusion` | Added via `harden build --include <dir>` — every regular file and file symlink under that directory in the source image layers. |
| `manual` | Added explicitly to the manifest by an operator (with an `included_because` justification). |

The source propagates through the build: the `Files:` summary line breaks the counts down by source, and manual entries' `included_because` values are carried into the SBOM output for audit traceability.

## The confidence score

`harden build` prints a confidence score for every image it produces:

```
Confidence:  76/100 (Medium) — 3 manual entries indicate paths not observed during profiling; profile duration 6s is below the recommended minimum of 10m0s
```

The score is a **coverage signal, not a quality grade**. It answers the question: *how representative was my profiling session?* A score of 100 means every known sensor coverage gap was actively mitigated — the window was long enough, startup-phase paths were captured, and every path was directly observed rather than manually added. A score below 100 does not mean the image is broken; it tells you exactly which gaps remain and what would close them.

### Score levels

| Score | Level | In practice |
|-------|-------|-------------|
| 80–100 | **High** | Profiling window was representative; all common gaps mitigated. Safe to promote to production with normal change management. |
| 60–79 | **Medium** | One or two gaps remain. Review the penalty reasons. Acceptable for staging; review before production. |
| 40–59 | **Low** | Several gaps open, or many manual entries. Verify the image starts and serves traffic before promoting. |
| 0–39 | **Very Low** | The profile is incomplete or nearly empty; the hardener emits an extra `Warning:` line. Do not promote without a new profiling run. |

### Signals and penalties

The score starts at 100 and penalties are subtracted per detected signal:

| Signal | Penalty | Trigger |
|--------|---------|---------|
| Empty profile | −60 | Zero `direct` entries — the sensor was not running, or the container was idle |
| Zero-duration profile | −20 | `profile_start` equals `profile_end` |
| Short profile window | −4 to −20 | Actual duration below the recommended minimum (default 10 minutes); scales with the shortfall |
| Manual entries | −5 per entry, cap −25 | `source: "manual"` entries not added by the hardener itself |
| Startup-race entries | −3 per entry, cap −12 | Manual entries whose `included_because` contains `startup-race` (stacks with the manual penalty) |
| Undocumented manual entries | −3 per entry, cap −9 | Manual entries with an empty `included_because` |

:::note
The penalty weights are v1 defaults, calibrated against the `nginx:1.25-alpine` reference profile, and may change before GA. Do not hard-code score thresholds in external automation.
:::

Two things are deliberately **not** penalized:

- **Scratch-compat entries** (`/etc/passwd`, `/etc/group`, the dynamic linker, TLS certs) that the hardener adds automatically — structural necessities, not coverage gaps.
- **`directory-inclusion` entries** from `--include` — an explicit operator choice, not a sensor gap.

### Short windows in CI

If your test harness intentionally uses a short profiling window (say, a 30-second smoke run), pass `--min-profile-duration 30s` so confidence is evaluated relative to the test budget rather than the production recommendation. Clean images scored against their own window show 100/100; images requiring manual entries still score lower regardless of window length.

## How to reach 100/100

1. **Profile for at least 10 minutes** (or your `--min-profile-duration` if longer).
2. **Trigger a process reload** during profiling for process-model servers (nginx, Apache) — this captures the binary via `execve` despite the [NRI startup race](/docs/concepts/known-limitations/#the-nri-startup-race).
3. **Send HTTP requests** to every content type and endpoint — this captures static files that are only opened on request.
4. **Exercise all `dlopen()` code paths** — the sensor captures `mmap(PROT_EXEC)` events, so dynamically loaded libraries appear as `direct`.
5. **Prefer better profiling over manual entries**, and use `--include` (unpenalized) rather than `manual` where an operator decision is unavoidable.
6. **Document every manual entry** with an `included_because` value:

```json
"/run/nginx.pid": {
  "source": "manual",
  "access_modes": ["w"],
  "included_because": "startup-race: pid file written by nginx master before cgroup registration"
}
```

## When to ship below 100

A lower score is not a blocker if you understand which gaps remain and have verified the image works. An nginx image scoring 76/100 with three documented startup-race entries and an 8-minute window, that passes `nginx -t` and serves traffic in a test, is a safe deployment. The score exists to surface gaps, not to block deployments.

## `--verbose` output

Pass `--verbose` to see the full penalty breakdown and ELF audit notes:

```
Confidence:  76/100 (Medium) — 3 manual entries indicate paths not observed during profiling; ...
             Penalty breakdown:
               manual-entries (-15): 3 manual entries indicate paths not observed during profiling
               startup-race (-9): 3 startup-race entries — NRI hook fired after application opened files the sensor could not observe
             Audit: 2 inferred-elf entries whose parent binary has no direct entry (expected if dynamic linker opened the library):
               /lib/ld-musl-aarch64.so.1
               /lib/libpcre.so.1
```

The audit note (orphan inferred-elf) is informational only and does not affect the score — it is expected when the dynamic linker, rather than the application, opened the library.

## Related pages

- [Known limitations](/docs/concepts/known-limitations/) — the sensor gaps behind each penalty
- [CLI reference](/docs/reference/cli/) — `--include`, `--mkdir`, `--touch`, `--min-profile-duration`
