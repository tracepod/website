---
title: Known limitations
description: An honest account of what the Tracepod sensor cannot observe, the risk of each gap, and the workarounds.
---

Tracepod is a runtime observer, not a static analyzer. Its output is only as complete as the workload it observed. This page summarizes the known sensor gaps; the canonical, fully detailed version lives in the repository at [`docs/KNOWN-LIMITATIONS.md`](https://github.com/tracepod/tracepod/blob/main/docs/KNOWN-LIMITATIONS.md).

## Summary

| Gap | Security risk | Image breakage risk |
|-----|--------------|---------------------|
| CRI-only profiling (silent miss for docker/nerdctl targets) | None | N/A — no manifest written |
| NRI startup race (entrypoint + init phase) | None | High (startup failure) — loud, caught before serving traffic |
| Static content not served during profiling | None | Low (404s, not a crash) |
| `dlopen()` on uninvoked code paths | Low | Low |
| Event loss under buffer pressure | None | Low (fail-safe) — but taints "not loaded" claims |
| Stat-only existence checks (interpreter source files) | None | Was high for Python; closed by the runtime companion resolver |

## The sensor requires privileged access

Attaching BPF kprobes and reading cgroup IDs requires `privileged: true` and `hostPID: true`. Environments that block privileged DaemonSets cannot run the sensor:

- **GKE Autopilot** — blocks privileged pods at admission
- **AWS Fargate** — no node access; DaemonSets unsupported
- **OpenShift** — needs a custom SecurityContextConstraint
- Clusters enforcing PodSecurity `restricted`

The Helm chart sets the required fields automatically. Long term, fine-grained capabilities (`CAP_BPF`, `CAP_SYS_ADMIN`, `CAP_PERFMON`) may replace full privilege on kernels ≥ 5.8.

## Only CRI-managed containers are profiled

NRI events fire only for containers launched through the containerd CRI plugin — i.e. via kubelet or `crictl`. Containers started with `docker run`, `nerdctl run`, or `ctr run` use the native containerd API and never trigger NRI events.

The result is a **silent miss**: the sensor looks healthy, the container runs normally, and no manifest is written. This is the most common initial user error. Always start profiling targets through Kubernetes or `crictl`.

## The NRI startup race

The NRI `StartContainer` hook fires *after* the container's init process has exec'd. Everything the application opens before that moment — the entrypoint interpreter, entrypoint scripts and the tools they call, pid files, log files, cache directories — is invisible to the sensor, no matter how long you profile.

**Risk: broken image, not a security gap.** The missed paths are typically empty directories and a pid file. A hardened image missing them fails to start loudly and immediately — it does not silently degrade.

Since profile schema v2 the race is machine-detectable: the sensor emits a `coverage.process_start_observed` marker that is `true` only when it verifiably attached before the workload's first exec. Any uncertainty resolves to `false`.

**Workarounds:**

1. Trigger a process reload during profiling (e.g. `nginx -s reload`) so the binary is observed via `execve`.
2. Use `--include` to cover the entrypoint phase — for nginx, typically `--include /bin --include /sbin --include /docker-entrypoint.sh --include /docker-entrypoint.d`. Directory-inclusion entries carry no confidence penalty.
3. For empty directories the app creates at runtime (`/var/cache/nginx`, `/var/run`), `--include` cannot help (it skips empty dirs) — use `harden build --mkdir`, a [runtime preset](/docs/reference/presets/), or a tmpfs mount at run time.
4. Alternatively, add manual entries with `included_because: "startup-race: ..."` — penalized, but fully auditable.

## Static content not accessed during profiling

Files served over HTTP are only observed if a request arrives for them during the profiling window. This is expected behavior, not a bug — the whole premise is that the image contains what the workload actually needed. Either send synthetic requests to every endpoint during profiling, or force-include the content directory:

```bash
harden build ... --include /usr/share/nginx/html
```

## `dlopen()` on uninvoked code paths

`dlopen()`-loaded libraries do not appear in ELF `DT_NEEDED` metadata, so no static resolver can find them. The sensor handles the common case *better* than static analysis: a `dlopen()` call maps the library with `PROT_EXEC`, the `mmap` kprobe captures it, and it lands in the manifest as `direct`.

The residual risk is a `dlopen()` that only fires on a code path not exercised during profiling — an error handler, a quarterly batch step, a disaster-recovery module. Exercise those paths during profiling, or `--include` the plugin directory.

:::caution
`.so` files added via `--include` do **not** get a second ELF resolution pass — their own `DT_NEEDED` dependencies are not automatically resolved. Include the library's dependency directory too, or add the dependencies explicitly.
:::

## Event loss under buffer pressure

Under a high enough event rate the BPF ring buffer fills and the kernel drops events. A dropped open is invisible: a busy, lossy window looks like a quiet one. A drop never adds a wrong file (fail-safe for minimization), but it can poison downstream reasoning from *absence* — "not observed" only implies "not loaded" when nothing was dropped.

Since profile schema v3 the sensor counts loss at every audited drop point and reports it in the profile's `event_loss` block. `event_loss.total: 0` is a positive claim; any nonzero value means the window was lossy and absence-based conclusions (such as `not_loaded` classifications in [CVE reporting](/docs/guides/cve-reporting/)) should not be drawn from it.

Mitigations: profile under representative rather than worst-case load; for known-bursty workloads, raise the ring buffer with the sensor's `--ringbuf-bytes` flag (default 256 KB).

## Loss on ungraceful sensor exit

The sensor flushes all in-flight profiles on `SIGTERM`/`SIGINT`. If it is `SIGKILL`ed (OOM-kill, force delete, node power loss) it cannot flush, and observations accumulated since the last successful flush are lost — producing a *truncated* profile, not a wrong one. Give the sensor DaemonSet a non-trivial `terminationGracePeriodSeconds`, and treat profiles spanning a sensor SIGKILL as truncated.

## Stat-only existence checks

The sensor traces `openat`, `exec`, and `mmap` — it cannot see files a process merely `stat(2)`s. CPython is the acute case: with a warm bytecode cache the interpreter *stats* `module.py` and *opens* only the `__pycache__` pyc — yet refuses the pyc at runtime if the sibling source is missing.

This is mitigated for the known Python case: the hardener's **runtime companion resolver** deterministically adds each pyc's sibling `.py` (`source: inferred-runtime`), and the [Python runtime presets](/docs/reference/presets/) cover `encodings/` and `lib-dynload/`. The general stat-blindness remains for other existence-probe patterns; the sensor's optional `--trace-stat` flag adds stat-family tracing (access mode `s`, schema v4) at the cost of higher event volume.

## The underlying pattern

Most gaps are instances of a single problem: **incomplete profiling-window coverage**. The [confidence score](/docs/concepts/observation-sources/) quantifies it — short windows, manual entries, and startup-race markers all subtract points, while `--include` and automatic scratch-compat additions do not. Profile your application under the load pattern it will see in production and the gaps close themselves.
