---
title: Troubleshooting
description: Draft outline - what to check when the Tracepod Platform install, sign-in, builds, registry pushes or pipelines do not work.
---

:::caution[Draft outline]
This page is an outline. Each section will become a table of symptom, cause and fix before publishing. One row per section is shown so you can judge the format.
:::

Start with the two logs and the pipeline's timeline: the controller log, the sensor log on the node where the workload runs, and the **Timeline** on the pipeline page, which records every stage change, pause reason and rollback.

## Install

Controller image pull failures, a volume that stays Pending, sensor pods that crash-loop, sensor pods missing from tainted nodes, and Pod Security rejections.

| Symptom | Cause | Fix |
|---|---|---|
| Sensor pods in `CrashLoopBackOff` | NRI is off on that node, or the kernel has no BTF | Run the [discovery probe](/docs/getting-started/requirements/) on the node. Use a node image with containerd 2.x |

## Sign-in and API

Missing or expired tokens, and "insufficient permissions" when your identity is not in the role list. See [Roles and sign-in](/docs/platform/roles-and-sign-in/).

| Symptom | Cause | Fix |
|---|---|---|
| Sent back to **Sign in** with "Your token was refused or has expired" | The token expired, or it is not a token for this cluster | Create a new token and sign in again |

## No workloads appear

The sensor is not on the workload's node, the workload started before the sensor, or it is not a Deployment or StatefulSet.

| Check | Fix |
|---|---|
| The workload started after the sensor | Restart it once (`kubectl rollout restart`). A running container is reported every 5 minutes by default, and when it stops |

## Builds

Source image pull errors, a full volume, and mixed CPU architectures.

| Symptom | Cause | Fix |
|---|---|---|
| The hardened image does not start: `exec format error` | The controller runs on a different CPU architecture from the workload | Pin the controller to the workloads' architecture with its node selector, then rebuild |

## Registry

Push failures in the publish and promote stages, repositories that do not exist, and pull credentials missing before a canary. See [Registries](/docs/platform/registries/).

| Symptom | Cause | Fix |
|---|---|---|
| Pipeline paused in publish with `NAME_UNKNOWN` | The registry does not create repositories on push (ECR) | Create `<repository path>/<image name>` first, then resume |

## Pipeline

Every pause reason and what to do about it. The table is already on [The validation pipeline](/docs/platform/pipeline/#when-a-pipeline-stops).

## Webhook (Pro)

Replacement pods that come back unchanged, and control planes that cannot reach the webhook port. The webhook fails open, so a broken webhook shows up as a paused pipeline, never as pods that fail to start.

## Licence messages

A Pro feature called on a Free install returns HTTP 403 and a message that names the capability. The API calls the Free tier "Lite" in these messages.
