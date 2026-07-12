---
title: Outputs
description: What a Tracepod harden build produces — the minimized OCI image, SBOMs, cosign signatures, and the removal manifest.
---

A successful `harden build` writes everything into the `--output` directory. This page describes each artifact.

## Minimized OCI image

The primary output: an [OCI image layout](https://github.com/opencontainers/image-spec/blob/main/image-layout.md) containing a `FROM scratch` image with a **single deterministic layer** — sorted paths, zero mtimes — holding only:

- files directly observed at runtime (`direct`),
- their recursively resolved ELF shared-library dependencies (`inferred-elf`),
- runtime companion files (`inferred-runtime`, e.g. Python `.py` sources implied by observed `.pyc` files),
- operator-included paths (`directory-inclusion`, `manual`), and
- scratch-compatibility files the hardener adds automatically (`/etc/passwd`, `/etc/group`, the dynamic linker, TLS certificates).

The original image config is preserved — `Entrypoint`, `Cmd`, `Env`, `User`, `WorkingDir`, `ExposedPorts`, `Healthcheck` — and `com.tracepod.*` provenance labels are added.

Use the layout directly with any OCI-aware tool:

```bash
# Import into a local Docker daemon:
skopeo copy oci:/tmp/hardened docker-daemon:myapp:hardened

# Or push during the build:
harden build ... --push myregistry.com/myapp:hardened
```

Deterministic layer construction means rebuilding from the same manifest and source image produces the same layer digest.

## Removal manifest

Written to `<output-dir>/removal-manifest.json` on **every** successful build. It is a set-difference fact: every OS package (dpkg/apk/rpm) present in the source image whose owned files are **entirely absent** from the hardened image, with the file paths that drove each removal.

Key properties:

- **Facts only** — no reachability, justification, or VEX vocabulary; the consumer decides what a removal means.
- **Partial retention is not removal** — a package with *any* retained file is absent from the manifest; multi-owner files keep every owning package "retained."
- **No scanner involved** — the hardener runs no vulnerability scanner; CVE association is a downstream concern.

The build summary reports it as `Removed pkgs: <n> (<path>)`. A source-scan failure is non-fatal (warning only). The formal schema is at [`docs/removal-manifest-schema/`](https://github.com/tracepod/tracepod/tree/main/docs/removal-manifest-schema) in the repository.

## SBOMs (CycloneDX + SPDX)

Pass `--sbom` to generate both formats via a [syft](https://github.com/anchore/syft) subprocess run against the hardened OCI layout:

```
<output-dir>/sbom.cyclonedx.json
<output-dir>/sbom.spdx.json
```

Both formats are produced because enterprise toolchains typically require one or the other. `syft` must be on `PATH`; SBOM failure is non-fatal (a warning, not a build error).

Because the SBOM is generated from the *hardened* image, it reflects only the packages that actually ship — and `included_because` justifications from manual manifest entries propagate into it, giving auditors traceability for every operator-added path.

### Cosign signing

Pass `--sbom-sign-key <path-to-cosign-private-key>` (requires `--sbom`) to sign both SBOM files with [cosign](https://github.com/sigstore/cosign). Each SBOM gets a `.sig` sidecar in the output directory. `cosign` must be on `PATH`.

```bash
harden build \
  --manifest manifest.json \
  --source myapp:1.0 \
  --output /tmp/hardened \
  --sbom \
  --sbom-sign-key cosign.key
```

## Build summary and confidence

The build prints a summary — source digest, auth source, file counts by observation source, the [confidence score](/docs/concepts/observation-sources/), layer size and digest — plus warnings for missing scratch-compat files, missing `--include` paths, and Very Low confidence.

Exit codes:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Fatal error — missing required flags, pull failure, unresolved ELF (`DT_NEEDED`) dependencies, or a failed smoke test |
| `2` | Non-fatal warning: a scratch-compat file other than `resolv.conf` was absent from the source image layers (`resolv.conf` absence is expected — the container runtime bind-mounts it) |

## Smoke test

Pass `--smoke-test` to load the built image into the local Docker daemon and run it briefly (`--smoke-window`, default 5s). The build fails (exit 1) if the minimized image cannot boot. This is the fastest signal that the profile was complete enough.

:::note
Seccomp and AppArmor profile generation are on the Tracepod roadmap but are **not** part of the current open-source toolchain. Today's outputs are the minimized image, the removal manifest, and the SBOMs described above.
:::
