---
title: Platform overview
description: What the Tracepod Platform is, what it installs in your cluster, what Free and Pro include, and how to get access.
sidebar:
  label: Overview
---

The Tracepod Platform is a dashboard and an API that run in your own cluster, next to the open-source sensor. It takes the profiles the sensor records, builds hardened images from them, and tests each image against the workload it was built for before it becomes the image you deploy.

The open-source tools already do the hardening itself: the sensor records what a container uses, and the `harden` CLI builds the minimised image. The Platform is for the two things a CLI cannot do well: keeping track of many workloads at once, and answering "will the workload still run on this image?" with evidence from the running pods.

:::note[Private beta]
The Platform is in private beta. The sensor is public; the controller image and the Helm chart are not. When you [request access](/contact?plan=free), we send you a registry token and the chart location. Everything else you need is on these pages, including the install guides for [EKS](/docs/platform/install-eks/) and [AKS](/docs/platform/install-aks/), so you can read how it works before you ask.
:::

## What gets installed

One Helm chart installs everything, into one namespace.

| Component | What it is | What it does |
|---|---|---|
| **Sensor** | A DaemonSet: one privileged pod per node. The same open-source sensor described in [How profiling works](/docs/concepts/how-profiling-works/) | Records which files each container opens, executes and maps, and posts a profile per container to the controller |
| **Controller** | A Deployment with one replica and a volume | Serves the dashboard and the API, builds hardened images, runs the validation pipeline. Its database and build output live on the volume |
| **Admission webhook** | A `MutatingWebhookConfiguration`, served by the controller | Used by Pro canary and rollout to swap the image on new pods. It only sees pods in namespaces you label, does nothing until you turn it on, and fails open |
| **RBAC** | Two ServiceAccounts, two ClusterRoles, one namespaced Role | Read access for the sensor and a read-mostly role for the controller. The full list is on [Architecture and security](/docs/platform/architecture-and-security/) |

Nothing runs outside your cluster. There is no Tracepod-hosted service, and no account to create.

## How it works

1. **Profile.** The sensor profiles every Deployment and StatefulSet pod on the nodes it runs on, from container start. Each workload appears in the dashboard with its file list and a coverage score.
2. **Build.** From a workload's page you build a hardened image: a copy of the source image that keeps the files the workload used, their shared-library dependencies and any paths you include. Each build gets CycloneDX and SPDX SBOMs.
3. **Validate.** You start a pipeline for the build. The controller pushes the hardened image to a staging tag in your registry, then compares what the running pods access with what the hardened image contains. A file the hardened image would be missing is reported as a *would-break* and blocks the pipeline until a rebuild includes it. With Pro, the pipeline then swaps the image on one pod, then on more pods in steps, and rolls back by itself if they become unhealthy.
4. **Promote.** After an Admin approves, the controller pushes the tested image to a production tag. Your CD deploys that tag. Tracepod never edits your Deployment or StatefulSet.

[The validation pipeline](/docs/platform/pipeline/) describes each stage, its gate and what happens when it fails.

![The pipeline page for a workload blocked in shadow: stage stepper, the gate, and two would-breaks with the pods that hit them](/screenshots/mock-pipeline-detail.png)

*The pipeline page. Data is illustrative.*

## Free and Pro

Both tiers are the same chart and the same image. The tier is one Helm value.

| | Free | Pro |
|---|---|---|
| Dashboard, API, roles, audit log | Yes | Yes |
| Hardened builds with SBOMs | Yes | Yes |
| Pipeline stages | build → publish → shadow → promote | build → publish → shadow → canary → rollout → promote |
| What changes on live pods | Nothing. Tracepod watches the running pods, then publishes a tag for your CD | The webhook swaps the image on one pod, then on more, and rolls back if they fail |
| Auto-fix for missing files | Proposes the rebuild; an Operator starts it | Rebuilds unattended, up to three rounds by default |
| CVE delta per build | No | Yes |
| OpenVEX export | No | Yes |
| Fleet policy and compliance | No | Yes |
| Outbound webhooks, rebuild when the source image changes | No | Yes |

Promote needs an Admin's approval in both tiers. A Pro feature called on a Free install returns HTTP 403 with a message that names the capability.

## What you need

- Kubernetes 1.25 or later, with nodes that run containerd with NRI enabled, cgroup v2 and a kernel with BTF. The [requirements page](/docs/getting-started/requirements/) has the details and a read-only probe script that checks a node for you.
- Permission to run privileged pods in the Tracepod namespace. The sensor needs `privileged: true` and `hostPID: true`. Fargate, GKE Autopilot and other platforms that forbid privileged pods are not supported.
- A StorageClass for one ReadWriteOnce volume (10Gi by default).
- A container registry the controller can push to, and outbound access from the controller pod to it.
- Workloads that are Deployments or StatefulSets. Bare pods, Jobs and DaemonSets are not profiled as workloads and cannot run a pipeline.

Two things to know before you plan a pilot:

- **One Tracepod release per cluster.** The webhook configuration is a cluster-wide object.
- **The controller builds images for its own CPU architecture.** On a cluster with both amd64 and arm64 nodes, pin the controller to the architecture of the workloads you harden.

## Where to go next

| If you want to | Read |
|---|---|
| Take this to a security review | [Architecture and security](/docs/platform/architecture-and-security/) |
| Install it | [Install on EKS](/docs/platform/install-eks/) or [Install on AKS](/docs/platform/install-aks/) |
| Connect a registry | [Registries](/docs/platform/registries/) |
| Understand the stages, gates and rollback | [The validation pipeline](/docs/platform/pipeline/) |
| Give people access | [Roles and sign-in](/docs/platform/roles-and-sign-in/) |
| Fix something | [Troubleshooting](/docs/platform/troubleshooting/) |
