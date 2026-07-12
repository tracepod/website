---
title: Installation overview
description: How to install the Tracepod sensor and controller on Kubernetes.
---

> **Note:** This page is a placeholder. Full content is being written separately.

## Prerequisites

- Kubernetes 1.27+
- Kernel 6.8+ with eBPF enabled (standard on AKS, GKE, EKS with Amazon Linux 2023)
- Helm 3.x
- `kubectl` access with cluster-admin or equivalent

## Install via Helm

```bash
helm repo add tracepod https://charts.tracepod.co.uk
helm repo update

helm install tracepod tracepod/tracepod \
  --namespace tracepod \
  --create-namespace
```

## Install the CLI

Download a static binary from the [GitHub Releases page](https://github.com/tracepod/tracepod/releases):

```bash
curl -fsSL \
  https://github.com/tracepod/tracepod/releases/latest/download/tracepod_linux_amd64.tar.gz \
  | tar xz -C /usr/local/bin tracepod

tracepod version
```

## Next steps

- [Quickstart guide](/docs/quickstart/guide/) — profile and harden your first workload
- [Helm chart reference](/docs/kubernetes/helm/) — full values documentation
