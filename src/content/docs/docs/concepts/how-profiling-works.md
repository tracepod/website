---
title: How profiling works
description: The eBPF sensor architecture — kprobes, ring buffer, container scoping via cgroup, and the NRI lifecycle.
---

The Tracepod sensor is a userspace daemon (deployed as a Kubernetes DaemonSet, or run standalone on a Linux host) that attaches eBPF kprobes to the kernel using [cilium/ebpf](https://github.com/cilium/ebpf) with CO-RE (Compile Once, Run Everywhere) BPF objects. Events flow from the kernel through a BPF ring buffer to a single userspace consumer, which aggregates them into a per-container **profile** (also called a manifest).

## The kprobes

The sensor attaches three kprobes (plus an optional fourth):

| Kprobe | Fires on | What it captures |
|--------|----------|------------------|
| `do_sys_openat2` | Every file open | The raw userspace path string. Absolute paths pass through directly; relative paths are resolved to absolute paths in userspace via CWD resolution. |
| `security_bprm_check` | Every `execve`, after `linux_binprm` is populated | Both the binary path and the shebang interpreter path (e.g. `/usr/bin/python3` for a `#!/usr/bin/python3` script). |
| `security_mmap_file` | Every file-backed `mmap(2)` with `PROT_EXEC` | The basename only (e.g. `libc.so.6`) — `bpf_d_path` is unavailable in kprobe context. Userspace correlates the basename against full paths already recorded by the openat probe, since the dynamic linker always opens a file before mapping it. |
| `vfs_fstatat` (optional, `--trace-stat`) | Stat-family existence checks | Records access mode `s` (profile schema v4). Higher event volume — the `event_loss` counters surface any resulting ring-buffer pressure. |

The `mmap` probe is what makes `dlopen()`-loaded libraries visible: when a library is loaded at runtime, it is mapped executable, and the sensor records it as a `direct` observation with access mode `m` — something no static analyzer can do reliably.

## Container scoping

Every event is filtered **in-kernel** by cgroup ID: only events from tracked containers reach userspace. The sensor learns which cgroups to track from the containerd **NRI** (Node Resource Interface) lifecycle hooks:

- `CreateContainer` / `StartContainer` — the container's cgroup is registered in the eBPF allowlist and event recording begins.
- `StopContainer` — the sensor flushes the aggregated observations as a complete profile: written to disk in standalone mode, or POSTed to the controller in controller mode.

This is why **only CRI-managed containers are profiled**: NRI events fire only for containers launched through the containerd CRI plugin (kubelet or `crictl`). `docker run`, `nerdctl run`, and `ctr run` bypass NRI entirely, so those containers are silently invisible to the sensor. See [Known limitations](/docs/concepts/known-limitations/).

It is also why there is a **startup race**: the NRI `StartContainer` hook fires after the container's init process has already exec'd, so files opened during the very first moments of startup (entrypoint scripts, pid files, log files) are missed. As of profile schema v2 the sensor emits a `coverage.process_start_observed` marker so this gap is machine-detectable per container. The [known limitations page](/docs/concepts/known-limitations/#the-nri-startup-race) covers the workarounds.

## The profile document

The profile is a JSON document, one per container profiling window. In standalone mode it is written to `profiles/<container-id>/files.json`; in controller mode it is POSTed to the controller at container stop. The core of it is a map of file paths to observations:

```json
{
  "files": {
    "/usr/sbin/nginx": {
      "source": "direct",
      "first_seen": "2026-01-01T00:00:00Z",
      "last_seen": "2026-01-01T01:00:00Z",
      "count": 42
    },
    "/lib/libssl.so.3": {
      "source": "inferred-elf"
    }
  }
}
```

Each entry records how the file was discovered (its [observation source](/docs/concepts/observation-sources/)), when it was first and last seen, and how many times.

The profile carries a `schema_version` (currently 4) and, since schema v3, a top-level `event_loss` block that counts events dropped at every audited drop point — ring-buffer overflow, decode failures, and start/stop races. A window with `event_loss.total: 0` is a positive claim that nothing was lost on the hard paths. The formal JSON Schemas live in the repository at [`docs/profile-schema/`](https://github.com/tracepod/tracepod/tree/main/docs/profile-schema).

## Sensor flags

The sensor binary accepts the following flags (verified against `cmd/sensor`):

| Flag | Default | Description |
|------|---------|-------------|
| `--profile-dir <dir>` | `profiles` | Directory for manifest output (standalone mode) |
| `--controller-url <url>` | — | Tracepod controller URL for Kubernetes mode; when set, profiles are POSTed instead of written to disk |
| `--node-name <name>` | — | Node name (set via the Downward API in the DaemonSet) |
| `--trace-stat` | `false` | Additionally trace stat-family existence checks (access mode `s`, schema v4). Higher event volume |
| `--ringbuf-bytes <n>` | `0` (256 KB) | Override the events ring-buffer size in bytes (power of two, page-multiple). Primarily a test knob, but accepts larger values for bursty workloads |
| `--post-unowned-pods-namespace <ns>` | — | POST profiles for pods with no tracked workload owner in this one namespace (used by the controller's sandbox validation) |
| `--cgroup-path <path>` | — | Manually allow a cgroup path (debug) |
| `--verbose` | `false` | Print every file-open event to stderr (noisy; for debugging) |
| `--version` | — | Print version and exit |

The sensor requires root with `privileged: true` and `hostPID: true` when containerized — kprobe attachment and cgroup ID resolution need elevated privileges.

## From profile to image

The `harden` CLI consumes the profile:

1. **Pull** the source image (via go-containerregistry).
2. **Resolve ELF dependencies** — recursively walk each observed binary's shared-library requirements (`DT_NEEDED`, `RPATH`, `RUNPATH`, `ld.so.conf`), adding entries as `inferred-elf`.
3. **Apply runtime companion rules** — e.g. every observed CPython `__pycache__/*.pyc` adds its sibling `.py` source (`inferred-runtime`), because the interpreter stats sources without opening them.
4. **Build a single deterministic layer** — sorted paths, zero mtime, scratch base — preserving the original image config (`Entrypoint`, `Cmd`, `Env`, `User`, `WorkingDir`, `ExposedPorts`, `Healthcheck`) and adding `com.tracepod.*` provenance labels.
5. **Write the OCI layout** to disk; optionally push.

See [Outputs](/docs/concepts/outputs/) for everything a build produces.
