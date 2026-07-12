---
title: Quickstart guide
description: Profile and harden your first Kubernetes workload with Tracepod in under ten minutes.
---

> **Note:** This page is a placeholder. Full content is being written separately.

## 1. Install Tracepod

See the [Installation overview](/docs/installation/overview/) for prerequisites and install options.

## 2. Profile a workload

```bash
tracepod profile \
  --workload nginx/my-app \
  --duration 60s
```

Let the workload run its normal traffic for the profiling window. Tracepod's eBPF sensor captures every file opened by the container.

## 3. Inspect the manifest

```bash
tracepod manifest --workload nginx/my-app
```

Each file in the manifest carries an `observation_source` tag (`direct`, `inferred-elf`, `inferred-runtime`, `directory-inclusion`, or `manual`) and a confidence score.

## 4. Harden the image

```bash
tracepod harden \
  --workload nginx/my-app \
  --push registry.example.com/my-app:hardened
```

Tracepod builds a new OCI image containing only the observed files, generates a seccomp allowlist and AppArmor profile, produces and signs CycloneDX and SPDX SBOMs, and pushes everything to your registry.

## 5. Verify the output

```
Image size:  248 MB → 31 MB  (87% reduction)
CVEs:        142 → 9         (grype, CRITICAL/HIGH)
Syscalls:    386 → 58        (seccomp allowlist)
SBOM:        signed + pushed (cosign)
```

## Next steps

- [How it works](/docs/concepts/how-it-works/) — understand confidence scoring and observation sources
- [Kubernetes deployment](/docs/kubernetes/helm/) — run the sensor at fleet scale
