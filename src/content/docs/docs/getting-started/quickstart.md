---
title: Quickstart
description: Profile a running container with the eBPF sensor and build your first hardened image.
---

This is the shortest real path from a running container to a hardened image. It follows the Kubernetes route; a standalone single-host variant is at the end.

## Before you start

- NRI is enabled in containerd on every node — see [Installation](/docs/getting-started/installation/#enable-nri-in-containerd)
- The `harden` binary is installed locally
- `skopeo` (or `crane`) is available for importing the result

:::note
Once installed, the sensor profiles **every** container kubelet/containerd creates on the node — including `kube-system`. There is no per-pod opt-in (no label, annotation, or namespace selector). You filter downstream by mapping container IDs back to pods (step 3 below). In standalone mode (the default), every stopped container produces a manifest.
:::

## 1. Install the sensor DaemonSet

```bash
helm install tracepod ./helm/tracepod \
  --namespace tracepod \
  --create-namespace
```

## 2. Exercise your workload

The sensor profiles containers while they run. Send real or synthetic traffic to your workload — hit every endpoint and content type you care about. The profile is written when the container **stops** (for example, when you scale the deployment down or roll a pod), to `/var/lib/tracepod/profiles/<container-id>/files.json` on the node.

The longer and more representative the run, the higher your [confidence score](/docs/concepts/observation-sources/). The recommended minimum profiling window is 10 minutes.

## 3. Retrieve the manifest

```bash
kubectl exec -n tracepod daemonset/tracepod-sensor -- \
  cat /profiles/<container-id>/files.json > manifest.json
```

Map container IDs to pod names:

```bash
kubectl get pods -A -o jsonpath=\
'{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[*].containerID}{"\n"}{end}' \
  | sed 's|containerd://||g'
```

## 4. Build the hardened image

```bash
harden build \
  --manifest manifest.json \
  --source nginx:1.25-alpine \
  --output /tmp/hardened-nginx
```

`--source` must be the same image reference the profile was recorded against. Add `--platform linux/arm64` if your deployment target is not `linux/amd64`.

## 5. Validate and import

```bash
skopeo copy oci:/tmp/hardened-nginx docker-daemon:myapp:hardened
docker run --rm myapp:hardened nginx -t   # replace with your app's smoke test
```

Or push directly to a registry during the build:

```bash
harden build \
  --manifest manifest.json \
  --source nginx:1.25-alpine \
  --output /tmp/hardened-nginx \
  --push myregistry.com/myapp:hardened
```

## What a successful build looks like

```
Source:      nginx:1.25-alpine (sha256:fac2017f...)
Auth:        anonymous
Registry:    docker.io
Files:       312 (289 direct, 23 inferred-elf, 0 manual/scratch-compat)
Confidence:  88/100 (High)
Layer:       8.3 MB (sha256:...)
OCI layout:  /tmp/hardened-nginx
Next:        skopeo copy oci:/tmp/hardened-nginx docker-daemon:myapp:hardened
Warning:     /etc/resolv.conf not found in image layers (bind-mounted at runtime — OK)
```

Key things to check:

- **Confidence** should be 70+ for a production build; see [Observation sources & confidence](/docs/concepts/observation-sources/) for what lowers the score.
- **Files** count should be non-zero — 0 direct observations means the sensor was not active or profiling captured no file-opens.
- `resolv.conf` absent is **expected** — the container runtime bind-mounts it; exit code 2 is returned only for other missing scratch-compat files.
- If `harden build` exits 0 but the hardened image fails to start, run with `--verbose` and use `--include` to add missing directories. The [runtime presets](/docs/reference/presets/) cover known gaps for common runtimes (nginx, Python, Java, Postgres, and more).

## Standalone (single Linux host, no Kubernetes)

The sensor can run directly on a Linux host and profile containers started via `crictl`:

```bash
# 1. Enable NRI in containerd (see Installation)

# 2. Run the sensor binary (Linux only, requires root)
sudo ./sensor \
  --profile-dir /tmp/tracepod-profiles \
  --verbose

# 3. Start a container via crictl (not docker run)
sudo crictl run container.json sandbox.json

# 4. Stop the container — this triggers the manifest write
sudo crictl stop <container-id>

# 5. Build from the manifest
harden build \
  --manifest /tmp/tracepod-profiles/<container-id>/files.json \
  --source nginx:1.25-alpine \
  --output /tmp/hardened-nginx
```

## Troubleshooting: no profiles appear

1. **Is NRI enabled?** `grep disable /etc/containerd/config.toml | grep nri` should print `disable = false` (or nothing). Restart containerd after changing it.
2. **Is the sensor connected?** `kubectl logs -n tracepod daemonset/tracepod-sensor | tail -20` — look for `NRI connected`.
3. **Was the container started via the CRI?** Only kubelet or `crictl` containers are profiled — not `docker run`, `nerdctl run`, or `docker-compose`.
4. **Did the container stop?** Profiles are written on container stop, not while running.
5. **Is the sensor tracking the container?** `kubectl logs -n tracepod daemonset/tracepod-sensor | grep tracking`

## Next steps

- [How profiling works](/docs/concepts/how-profiling-works/) — the eBPF machinery under the hood
- [Kubernetes deployment](/docs/guides/kubernetes/) — chart values and profile retrieval in depth
- [GitHub Action](/docs/guides/github-action/) — harden images in CI
