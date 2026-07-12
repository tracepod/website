---
title: Helm chart
description: Deploy Tracepod to Kubernetes using the official Helm chart.
---

> **Note:** This page is a placeholder. Full content is being written separately.

## Chart overview

The `tracepod/tracepod` Helm chart deploys:

- **DaemonSet** (`tracepod-sensor`) — one eBPF sensor pod per node
- **Deployment** (`tracepod-controller`) — aggregation controller with SQLite state, HTTP API, and web dashboard
- **ClusterRole + ServiceAccount** — RBAC for namespace creation, pod lifecycle, pod/log, secrets, configmaps, and tokenreviews
- **ConfigMap** (`tracepod-rbac`) — role assignments for the dashboard RBAC

## Quick install

```bash
helm repo add tracepod https://charts.tracepod.co.uk
helm repo update
helm install tracepod tracepod/tracepod \
  --namespace tracepod \
  --create-namespace
```

## Key values

| Value | Default | Description |
|-------|---------|-------------|
| `controller.authDisabled` | `false` | Set `true` to skip TokenReview (local dev only) |
| `controller.image.repository` | `ghcr.io/tracepod/controller` | Controller image |
| `sensor.image.repository` | `ghcr.io/tracepod/sensor` | Sensor image |
| `controller.service.port` | `9090` | Dashboard HTTP port |

## RBAC

The controller's `default` ServiceAccount requires a ClusterRole covering:

```yaml
rules:
  - apiGroups: [""]
    resources: [namespaces, pods, pods/log, pods/exec, secrets, configmaps]
    verbs: [get, list, watch, create, update, delete]
  - apiGroups: [authentication.k8s.io]
    resources: [tokenreviews]
    verbs: [create]
```

See `helm/tracepod/templates/rbac.yaml` in the repository for the full definition.

## Upgrading

```bash
helm repo update
helm upgrade tracepod tracepod/tracepod \
  --namespace tracepod \
  --reuse-values
```
