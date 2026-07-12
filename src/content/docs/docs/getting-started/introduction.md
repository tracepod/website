---
title: Introduction
description: What Tracepod is and how eBPF runtime profiling produces minimized, lower-CVE container images.
---

Tracepod is an eBPF-based container hardening tool for Kubernetes. It observes what a running container actually uses at runtime — files, binaries, shared libraries — via eBPF kernel tracing, then builds a minimized OCI image containing only those components. The result is a smaller attack surface: fewer files, fewer packages, fewer CVEs.

## The pipeline

```
┌─────────────────────────────────────────────────────────┐
│                     Kubernetes cluster                   │
│                                                          │
│  eBPF sensor                                             │
│  (DaemonSet)    ──openat() kprobe──►  file manifest      │
│                                            │             │
│                                            ▼             │
│                                       harden CLI         │
│                                            │             │
│                                    minimized OCI image   │
└─────────────────────────────────────────────────────────┘
```

1. **Profile** — the sensor attaches eBPF kprobes to `openat()`, `execve`, and `mmap` and records every file a container opens, filtered by cgroup to the target container only.
2. **Harden** — the `harden` CLI reads the resulting manifest and builds a new `FROM scratch` OCI image containing only the observed files, their recursively resolved ELF dependencies, and any explicitly included paths.
3. **Validate** — run the hardened image (for example with `harden build --smoke-test`, or your own smoke test) to confirm it behaves correctly.
4. **Publish** — push the hardened image to your registry with `--push`.

## What you get

Every successful `harden build` produces:

- A **minimized OCI image** — a single deterministic layer on a scratch base, preserving the original image config (entrypoint, env, user, ports).
- A **confidence score** (0–100) telling you how representative the profiling window was.
- A **removal manifest** — the exact set of OS packages removed from the source image, with the file evidence for each removal.
- Optionally, **CycloneDX and SPDX SBOMs** (via syft), signable with cosign.

See [Outputs](/docs/concepts/outputs/) for details on each artifact.

## Components

| Binary | Platform | Description |
|--------|----------|-------------|
| `sensor` | Linux only | eBPF DaemonSet — profiles running containers |
| `harden` | Linux + macOS | Builds minimized OCI images from manifests |
| `tracepod` | Linux + macOS | CLI client for the Tracepod controller API |

:::note
The `tracepod` CLI connects to a separate server-side controller component that is not part of the open-source repository. You do not need it for standalone or Helm-based usage — manifests can be retrieved directly from the sensor pod with `kubectl exec`. The controller is required only for multi-node aggregation, the reachability/CVE report backend, and the managed UI.
:::

## Design philosophy

Tracepod is not a static analyzer. It is a **runtime observer**: its output is only as complete as the workload it observed. Profile your application under the same load pattern it will see in production, and your hardened image will be correct. Profile it while it sits idle and you will need to fill gaps manually — which the [confidence score](/docs/concepts/observation-sources/) surfaces explicitly rather than hiding.

Every file in the manifest carries an observation source (`direct`, `inferred-elf`, `inferred-runtime`, `directory-inclusion`, `manual`), so you can always audit *why* a file ended up in the hardened image.

## Next steps

- [Installation](/docs/getting-started/installation/) — install the sensor and CLI
- [Quickstart](/docs/getting-started/quickstart/) — harden your first container
- [Known limitations](/docs/concepts/known-limitations/) — what the sensor cannot observe, and how to work around it

Tracepod is open source under the AGPL-3.0 license. Source: [github.com/tracepod/tracepod](https://github.com/tracepod/tracepod).
