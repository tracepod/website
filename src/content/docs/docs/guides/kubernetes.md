---
title: Kubernetes deployment
description: Deploy the Tracepod eBPF sensor DaemonSet with Helm — values, modes, profile retrieval, and troubleshooting.
---

The Helm chart at [`helm/tracepod`](https://github.com/tracepod/tracepod/tree/main/helm/tracepod) deploys the Tracepod eBPF sensor as a DaemonSet. The sensor attaches kprobes to `openat`, `execve`, and `mmap` and records every file a container touches at runtime, producing the JSON manifest the `harden` CLI consumes.

## Prerequisites

- Kubernetes ≥ 1.25
- Helm 3
- containerd runtime with **NRI enabled** (see [Installation](/docs/getting-started/installation/#enable-nri-in-containerd) — required, and a silent no-op if missing)
- cgroupv2 on nodes (default on Ubuntu 22.04+ and most modern distributions)
- The cluster must allow `privileged: true` DaemonSet pods (blocked by GKE Autopilot, Fargate, and PodSecurity `restricted`)

## Modes

| Mode | When | How profiles are stored |
|------|------|------------------------|
| **Standalone** (default) | `sensor.controllerURL` is empty | Written to each node's disk via hostPath at `sensor.profileHostPath` |
| **Controller** | `sensor.controllerURL` points to a Tracepod controller | POSTed to the controller API at container stop |

Standalone mode needs no extra infrastructure — profiles land at `/var/lib/tracepod/profiles/<container-id>/files.json` on each node. The controller is a separate component, not part of the open-source repository; in controller mode, pods without a Deployment/StatefulSet owner are dropped before upload.

## Install

```bash
helm install tracepod ./helm/tracepod \
  --namespace tracepod \
  --create-namespace

kubectl -n tracepod rollout status daemonset/tracepod-sensor
```

Verify the sensor connected to NRI:

```bash
kubectl -n tracepod logs daemonset/tracepod-sensor | grep -E "NRI|tracking"
# Expected: "NRI connected" on startup, then "tracking  container=..." per profiled container
```

## Values

| Value | Default | Description |
|-------|---------|-------------|
| `sensor.image.repository` | `ghcr.io/tracepod/tracepod-sensor` | Sensor container image |
| `sensor.image.tag` | `latest` | Image tag — pin to a release tag in production |
| `sensor.image.pullPolicy` | `IfNotPresent` | Image pull policy |
| `sensor.controllerURL` | `""` | Tracepod controller URL; empty = standalone mode |
| `sensor.profileHostPath` | `/var/lib/tracepod/profiles` | Node-local path for profile output (standalone only) |
| `sensor.traceStat` | `false` | Also record stat-family existence checks (schema v4 access mode `s`). Higher event volume |
| `sensor.postUnownedPodsNamespace` | `""` | POST bare-pod profiles from this one namespace (used for controller sandbox validation) |
| `sensor.ringbufBytes` | `0` | Override the BPF ring-buffer size in bytes (0 = default 256 KB). Test-only knob — do not set in production |
| `sensor.resources` | `{}` | Container resource requests/limits — set limits for production |
| `sensor.nodeSelector` | `{}` | Node selector for the DaemonSet |
| `sensor.tolerations` | `[]` | Tolerations — add entries to profile tainted nodes |
| `sensor.affinity` | `{}` | Affinity rules |

## Retrieving profiles (standalone mode)

Profiles are written when a container **stops**, on the node where the pod ran.

### Map container IDs to pod names

The sensor uses containerd's 64-character container ID as the directory name:

```bash
kubectl get pods -A \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[*].containerID}{"\n"}{end}' \
  | sed 's|containerd://||g'
```

Or check the sensor logs — each tracked container is logged on start:

```bash
kubectl -n tracepod logs daemonset/tracepod-sensor | grep tracking
```

### Copy the manifest

```bash
# Find the sensor pod on the node where your pod ran:
NODE=$(kubectl get pod <your-pod> -o jsonpath='{.spec.nodeName}')
SENSOR=$(kubectl -n tracepod get pod \
  -l app.kubernetes.io/name=tracepod-sensor \
  --field-selector spec.nodeName=$NODE \
  -o jsonpath='{.items[0].metadata.name}')

# List available profiles:
kubectl -n tracepod exec $SENSOR -- ls /profiles/

# Copy a profile locally:
kubectl -n tracepod exec $SENSOR -- \
  cat /profiles/<container-id>/files.json > manifest.json
```

Paths inside the sensor pod use `/profiles/`; the same data is on the node at `/var/lib/tracepod/profiles/<container-id>/files.json`.

Then build as usual — see the [Quickstart](/docs/getting-started/quickstart/#4-build-the-hardened-image).

## RBAC

The chart creates a ClusterRole and ClusterRoleBinding for the sensor's ServiceAccount with the minimum permissions to resolve the pod → ReplicaSet → Deployment owner chain (used when posting to the controller; present but unused in standalone mode):

| API group | Resource | Verbs |
|-----------|----------|-------|
| `""` (core) | `pods` | `get` |
| `apps` | `replicasets` | `get` |

## Upgrade and uninstall

```bash
helm upgrade tracepod ./helm/tracepod --namespace tracepod

helm uninstall tracepod --namespace tracepod
kubectl delete namespace tracepod
```

Profile data on node disks is **not** removed automatically — clean up with `sudo rm -rf /var/lib/tracepod/profiles` on each node.

## Known constraints

| Constraint | Detail |
|------------|--------|
| `privileged: true` required | BPF kprobe attachment needs elevated privileges. Blocked by GKE Autopilot, Fargate, PodSecurity `restricted` |
| containerd + NRI only | CRI-O and standalone Docker are not supported |
| cgroupv2 required | `bpf_get_current_cgroup_id()` returns cgroupv2 inodes |
| CRI containers only | `docker run` / `nerdctl run` containers are never profiled |
| Profile data is per-node | Cross-node aggregation requires the controller |

## Troubleshooting

Sensor starts but no profiles appear:

1. **NRI enabled?** (most common cause) — `grep -E "^\s*disable\s*=" /etc/containerd/config.toml | grep nri` must print `disable = false` or nothing.
2. **Sensor connected?** — `kubectl -n tracepod logs daemonset/tracepod-sensor | head -20`; a missing `NRI connected` line means registration failed.
3. **Container started via Kubernetes?** — only kubelet-created pods are profiled.
4. **Container stopped yet?** — profiles are written on stop, not while running.
5. **Sensor tracking it?** — `kubectl -n tracepod logs daemonset/tracepod-sensor | grep tracking`; if your container ID is absent, the sensor missed the start event.

See [Known limitations](/docs/concepts/known-limitations/) for the full sensor gap analysis.
