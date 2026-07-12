---
title: Installation
description: Install the Tracepod sensor, harden CLI, and tracepod CLI from releases, source, or the Helm chart.
---

Tracepod ships three binaries. Install only what you need:

| Binary | Platform | You need it when |
|--------|----------|------------------|
| `sensor` | Linux (amd64/arm64) | Profiling containers — deployed as a DaemonSet via Helm, or run directly on a Linux host |
| `harden` | Linux + macOS (amd64/arm64) | Building minimized images from a profile — runs anywhere, no kernel dependency |
| `tracepod` | Linux + macOS (amd64/arm64) | Talking to the Tracepod controller (optional component, not in the OSS repo) |

## Prerequisites

For **profiling** (the sensor):

- Kubernetes cluster with containerd 1.7+ as the runtime (for the Kubernetes path)
- NRI enabled in containerd — see below
- cgroupv2 on nodes (default on Ubuntu 22.04+ and most modern distributions)
- The cluster must allow `privileged: true` DaemonSet pods
- Helm 3 (for the Kubernetes deployment path)

For **hardening** (the CLI): no special prerequisites. `skopeo` or `crane` is useful for importing the hardened image into a Docker daemon, and `syft` is required if you pass `--sbom`.

### Enable NRI in containerd

The sensor integrates with containerd through NRI (Node Resource Interface). NRI must be enabled **before** installing the sensor — without it the sensor connects but no containers are ever profiled:

```toml
# /etc/containerd/config.toml on each node
[plugins."io.containerd.nri.v1.nri"]
  disable = false
```

Then restart containerd:

```bash
sudo systemctl restart containerd
```

Verify:

```bash
grep -E "^\s*disable\s*=" /etc/containerd/config.toml | grep nri
# Should print:   disable = false
# (or be absent — NRI is enabled by default in containerd 2.x)
```

:::caution
Only containers managed by Kubernetes (kubelet → containerd) or started via `crictl` are profiled. Containers started with `docker run`, `nerdctl run`, or `docker-compose` are silently ignored, because they do not go through the containerd NRI interface. See [Known limitations](/docs/concepts/known-limitations/).
:::

## Install from GitHub releases

Pre-built binaries are published on the [Releases page](https://github.com/tracepod/tracepod/releases). Each binary ships in its own archive, named `tracepod_<binary>_<version>_<os>_<arch>.tar.gz`:

```bash
# Example: install harden v0.1.2 on Linux amd64
curl -fsSL \
  https://github.com/tracepod/tracepod/releases/download/v0.1.2/tracepod_harden_0.1.2_linux_amd64.tar.gz \
  | tar -xz harden
sudo install harden /usr/local/bin/harden

harden version
```

Substitute `harden` with `sensor` or `tracepod`, and adjust `<os>` (`linux`, `darwin`) and `<arch>` (`amd64`, `arm64`) as needed. A `checksums.txt` is published with every release.

## Install the sensor via Helm (Kubernetes)

The sensor DaemonSet is deployed with the Helm chart from the repository checkout:

```bash
git clone https://github.com/tracepod/tracepod.git
cd tracepod

helm install tracepod ./helm/tracepod \
  --namespace tracepod \
  --create-namespace
```

The chart uses the sensor container image from GHCR (`ghcr.io/tracepod/tracepod-sensor`). See the [Kubernetes deployment guide](/docs/guides/kubernetes/) for chart values, verification steps, and troubleshooting.

## Build from source

The hardener and CLI build on macOS or Linux with Go 1.26+ and no cgo:

```bash
git clone https://github.com/tracepod/tracepod.git
cd tracepod
CGO_ENABLED=0 go build ./cmd/harden/
CGO_ENABLED=0 go build ./cmd/tracepod/
```

The **sensor** requires a Linux kernel (6.8+) with eBPF support, clang-18, and bpftool to build. macOS contributors can use the Lima VM configuration shipped in the repo — see [CONTRIBUTING.md](https://github.com/tracepod/tracepod/blob/main/CONTRIBUTING.md).

## Next steps

- [Quickstart](/docs/getting-started/quickstart/) — profile and harden your first container
- [Kubernetes deployment](/docs/guides/kubernetes/) — full Helm chart reference
