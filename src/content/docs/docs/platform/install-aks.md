---
title: Install on AKS
description: Draft outline - installing the Tracepod Platform on Azure Kubernetes Service, from node check to first sign-in.
---

:::caution[Draft outline]
This page is an outline. The headings are the final structure; each section will get its full commands before publishing. The Azure-specific steps have not yet been run end to end on a real AKS cluster.
:::

You need the registry token and the Helm chart we send you when you [request access](/contact?plan=free), plus `kubectl`, `helm` 3.8 or later, `jq` and the `az` CLI. Read the [overview](/docs/platform/overview/) first for what gets installed.

## 1. Check the nodes

Ubuntu 24.04 and Azure Linux 3.0 node pools run containerd 2.x with NRI on. **Ubuntu 22.04 node pools run containerd 1.7, where NRI may be off**, and the sensor cannot start on such nodes. If 22.04 is all you have, add an Ubuntu 24.04 pool for the pilot. Either way, run the read-only [discovery probe](/docs/getting-started/requirements/) on one node of each pool through `kubectl debug`.

## 2. Storage

The controller needs one ReadWriteOnce volume, 10Gi by default. The built-in Azure Disk StorageClasses work; the example values file names one.

## 3. Namespace and pull Secret

Create the namespace, then a `docker-registry` Secret that holds the token we sent you, so the cluster can pull the controller image. The sensor image is public. If the cluster enforces Pod Security Admission, label the namespace `pod-security.kubernetes.io/enforce=privileged`.

## 4. Install the chart

One `helm install` with the AKS example values file. Expect one controller pod and one sensor pod per node. Restart the workloads you want to profile afterwards, so the sensor sees them start.

## 5. Sign in

Port-forward the controller Service and sign in with a Kubernetes token. [Roles and sign-in](/docs/platform/roles-and-sign-in/) has the steps.

## 6. Connect Azure Container Registry

The controller pushes to ACR with credentials in a Secret: a service principal with `AcrPush` (and `AcrDelete`, so finished staging tags can be cleaned up), or a repository-scoped token. Nodes pull through the cluster's kubelet identity once the ACR is attached to the cluster, so you tick **Nodes can pull this registry** and need no pull Secret in the workload namespaces. This section will carry the `az` commands for both options.

## 7. Opt a namespace in (Pro)

Free never changes a pod and needs no label. For Pro canary and rollout, label each workload namespace and set the webhook mode, first to `observe`, then to `enforce`.

## 8. Uninstall

`helm uninstall` removes the workloads and the webhook configuration and keeps the controller's volume by default. The full removal steps are on [Architecture and security](/docs/platform/architecture-and-security/#uninstall), plus the Azure objects to delete: the service principal or token, and the repositories.
