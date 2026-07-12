---
title: How it works
description: Architecture, the observation-source model, and confidence scoring in Tracepod.
---

> **Note:** This page is a placeholder. Full content is being written separately.

## Core data flow

1. **eBPF sensor** — A CO-RE kprobe on `openat()` captures file-open events inside each container, filtered by cgroup/namespace. Events are shipped via a ring buffer to the aggregation controller.

2. **Manifest aggregation** — Paths are deduplicated into a `path → {first_seen, last_seen, count, observation_source}` manifest. No raw event data leaves the cluster.

3. **ELF dependency resolver** — Before building the hardened image, the builder recursively resolves every ELF binary's shared-library dependencies via `readelf` and `ld.so.conf`. This is the single biggest correctness risk: a minimised image without its `.so` dependencies will crash.

4. **Language-runtime companion rules** — Python bytecode (`__pycache__/*.pyc`) implies the sibling `.py` source. The interpreter stats these without issuing `openat()` events, so they would otherwise be silently omitted.

5. **Output factory** — A single profiling run produces: minimised OCI image, seccomp JSON, AppArmor profile, CycloneDX SBOM, SPDX SBOM (both signed by cosign).

## Observation sources

Every file in the manifest carries an `observation_source` tag:

| Source | Meaning |
|--------|---------|
| `direct` | File path observed directly by the eBPF sensor |
| `inferred-elf` | ELF shared-library dependency resolved by the builder |
| `inferred-runtime` | Language-runtime companion (e.g. CPython `.py` sibling) |
| `directory-inclusion` | Safe-mode directory expansion |
| `manual` | User-added path override |

This distinction is load-bearing. It is the foundation of confidence scoring and the reason a Tracepod-hardened image is trustworthy.

## Confidence scoring

Each file receives a confidence score in `[0, 1]` based on observation source and frequency:

- `direct` files with high `count` score close to 1.0
- `inferred-elf` files score slightly lower (dependent on resolver correctness)
- `inferred-runtime` and `directory-inclusion` files score lower still

The platform dashboard surfaces confidence scores per build, letting operators make informed decisions about preset expansions and manual overrides.
