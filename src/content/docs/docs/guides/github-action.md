---
title: GitHub Action
description: Harden a container image in CI with the tracepod/tracepod composite action — build, smoke-test, SBOM, and push.
---

The repository root ships a composite GitHub Action (`tracepod/tracepod@v0`) that hardens an image in CI from a recorded profile: it installs the `harden` binary and syft, runs `harden build` with `--sbom`, optionally smoke-tests the result in the runner's Docker daemon, and optionally pushes to a registry.

Profile your app during CI e2e tests (or commit a recorded profile), then harden as part of the release pipeline.

## Usage

```yaml
- uses: tracepod/tracepod@v0
  with:
    manifest: profiles/app/files.json
    source: ghcr.io/acme/app:${{ github.sha }}
    push: ghcr.io/acme/app:${{ github.sha }}-hardened
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `manifest` | yes | — | Path to the Tracepod profile JSON (sensor output, `files.json`) |
| `source` | yes | — | Source image reference the profile was recorded against |
| `output` | no | `hardened-oci` | Directory for the hardened OCI layout |
| `push` | no | `''` | Registry reference to push the hardened image to (empty = build only) |
| `platform` | no | `linux/amd64` | Target platform |
| `include` | no | `''` | Newline-separated extra include paths (each becomes a `--include`) |
| `smoke-test` | no | `true` | Run the built image in the runner's Docker daemon and fail if it cannot boot |
| `version` | no | `latest` | Tracepod release version to install |

## Outputs

| Output | Description |
|--------|-------------|
| `oci-path` | Path of the hardened OCI layout (equals the `output` input) |
| `sbom-cyclonedx` | Path of the CycloneDX SBOM (`<output>/sbom.cyclonedx.json`) |
| `sbom-spdx` | Path of the SPDX SBOM (`<output>/sbom.spdx.json`) |

The SBOMs are always generated (the action passes `--sbom` and installs syft). Use the outputs for follow-up steps — cosign attach, release upload, registry scan.

## Example: full release step

```yaml
jobs:
  harden:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Harden image
        id: harden
        uses: tracepod/tracepod@v0
        with:
          manifest: profiles/app/files.json
          source: ghcr.io/acme/app:${{ github.sha }}
          push: ghcr.io/acme/app:${{ github.sha }}-hardened
          include: |
            /usr/share/nginx/html
            /docker-entrypoint.d

      - name: Upload SBOMs
        uses: actions/upload-artifact@v4
        with:
          name: sboms
          path: |
            ${{ steps.harden.outputs.sbom-cyclonedx }}
            ${{ steps.harden.outputs.sbom-spdx }}
```

## Notes

- The action runs on **Linux runners** (it uses `sudo` and, for the smoke test, the runner's Docker daemon — both present on `ubuntu-latest`).
- Registry authentication for `push` uses the standard Docker credential chain — run a `docker/login-action` step first.
- The smoke test loads the OCI layout into the local daemon and requires the container to survive a short window; disable it with `smoke-test: 'false'` for images that need external services to boot.
- `include` paths follow the same semantics as `harden build --include` — see the [CLI reference](/docs/reference/cli/) and [Known limitations](/docs/concepts/known-limitations/#the-nri-startup-race) for when to use them.
