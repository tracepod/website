---
title: The validation pipeline
description: How the Tracepod Platform tests a hardened image against the running workload - stages, gates, would-breaks, auto-fix, health checks, rollback and promote.
---

A hardened image is only useful if the workload still runs on it. The pipeline checks that before the hardened image becomes the one you deploy. It does the check in the workload's own namespace, with its own service account, secrets, config, network policies and traffic, so the image is the only thing that changes.

It works in two steps:

1. **Watch.** While the original pods keep running, Tracepod compares what they access with what the hardened image contains, and reports any file the hardened image would be missing. Each one is a *would-break*. Nothing in the cluster changes during this step.
2. **Swap (Pro).** Tracepod replaces the image on one pod (the canary), then on a growing share of pods, watches their health, and rolls back by itself if they fail.

Promote then pushes the tested image to a production tag for your CD to deploy. Tracepod never edits the workload's pod template.

## Stages

```
build → publish → shadow → canary → rollout → promote → done
```

Free runs `build → publish → shadow → promote → done`. Pro adds `canary` and `rollout`.

| Stage | What happens | Gate to move on (defaults) | If it fails |
|---|---|---|---|
| **Build** | Checks that the build finished and has a file inventory of the source image | Inventory recorded | The pipeline ends `failed` |
| **Publish** | Pushes the hardened image to a staging tag, `<source-tag>-tp-<build-id>`, in your registry, pinned by digest | Push succeeded | `paused` with the reason. Resume retries |
| **Shadow** | The original pods keep running. Sensor snapshots are compared with the file inventory to find would-breaks | 24 hours since shadow started, at least one container start that the sensor saw from the beginning, and no open would-breaks | `blocked`. Auto-fix can rebuild |
| **Canary** (Pro) | The controller evicts one pod; the admission webhook swaps the image on its replacement | Canary Ready within 5 minutes, then healthy for 30 minutes | Automatic rollback |
| **Rollout** (Pro) | The share of hardened pods rises in steps: 25%, 50%, 100%. Pods are evicted one at a time | Each step healthy for 15 minutes | Automatic rollback |
| **Promote** | Waits for an Admin's approval, then copies the hardened image to the production tag | Approval, push succeeded, and the pushed digest equals the tested digest | `paused` with the reason. Resume retries |
| **Done** | Waits until the workload's pod template uses the promoted image, which means your CD deployed it | Template on the promoted image | Ends `superseded` if the template moves to another image |

A workload has one active pipeline at a time. A pipeline is in one of these states: `running`, `waiting_approval`, `blocked`, `paused`, `rolling_back`, or one of the final states `completed`, `rolled_back`, `failed`, `superseded`, `cancelled`. Only errors that a retry cannot fix (the build failed, the workload was deleted, there is no file inventory) end in `failed`; everything else pauses with a reason and waits for you.

:::caution[Shadow needs one container start]
The shadow gate needs a container that the sensor watched from its start. If no container of the workload has started since the pipeline began, the gate does not pass. Restart the workload once (`kubectl rollout restart`).
:::

## Starting a pipeline

Nothing runs until you start a pipeline for a build: **Start pipeline** on the build page, or `POST /api/v1/builds/{id}/pipeline`. This needs the Operator role. The workload must be a Deployment or a StatefulSet, and there must be a [registry](/docs/platform/registries/) to publish to.

In Free, that is all. Free never changes a pod.

For canary and rollout (Pro), two more things are needed, and both are done by a person:

1. **Label the namespace.** The controller never labels namespaces. Do not label the Tracepod namespace or `kube-system`.

   ```bash
   kubectl label namespace <namespace> tracepod.io/pipeline=enabled
   ```

   A pod that carries the label `tracepod.io/pipeline-skip` is never changed, even in a labelled namespace.

2. **Set the webhook mode** in **Settings → Pipeline → Admission webhook mode**. It is `off` by default.

   | Mode | What the webhook does |
   |---|---|
   | `off` | Nothing |
   | `observe` | Records what it would have changed on the pipeline's timeline. Changes nothing |
   | `enforce` (Pro) | Swaps the image on new pods of a workload that is in canary, rollout or promote |

   Start with `observe`, read the timeline of one pipeline, then switch to `enforce`. Canary needs `enforce`.

The webhook fails open. If the controller is down or slow (2-second timeout), pods are created unchanged.

## Would-breaks

A would-break is an access that the hardened image would not satisfy: the workload opened, stat'ed or executed a path that exists in the source image but not in the hardened one, or followed a kept symlink whose target was removed.

Paths that do not exist in the source image are ignored, because they fail the same way on both images. So are `/proc`, `/sys` and `/dev`.

![A pipeline blocked in shadow with two open would-breaks, and an auto-fix proposal that lists the two missing paths](/screenshots/mock-pipeline-detail.png)

*A pipeline blocked in shadow by two would-breaks. Data is illustrative.*

- **Phase.** A would-break from an original pod has phase `shadow`: it is a prediction, and nothing broke. A would-break from a hardened pod (phase `canary` or `rollout`) is a real failure, and it triggers a rollback.
- **Where to see them.** On the pipeline page, and in the Shadow verification panel on the build page. Each row has the path, the kind of access, the phase, the pod, a count, and when it was last seen.
- **What to do.** Open would-breaks block the shadow stage. Rebuild with the missing paths included: run auto-fix (next section), or build again with your own includes and start a new pipeline. When a later build keeps the path, the would-break is marked resolved by that build.

### Test builds

To see a rollback before you rely on one, an Admin can create a deliberately broken build by listing paths to exclude. The build is labelled **Test build**. Would-breaks on the excluded paths are recorded as expected and do not block shadow, so the build reaches canary and fails there. A test build can never be promoted or auto-fixed.

## Auto-fix

Auto-fix turns would-breaks into a rebuild. The setting is `pipeline_autofix`:

| Value | Behaviour |
|---|---|
| `off` | Nothing happens automatically |
| `suggest` (default) | When shadow is blocked, or a canary rolled back on a would-break, the pipeline shows a proposal with the exact paths. An Operator starts it with **Auto-fix** |
| `auto` (Pro) | The rebuild starts by itself |

A round builds a new image from the first build's includes plus every missing path found so far, cancels the old pipeline with the reason `superseded-by-autofix`, and starts a new pipeline on the same registry. Auto-fix only copies files that exist in the source image. It never invents a file.

It stops after three rounds (`pipeline_autofix_max_rounds`), or when a round finds no new path.

## Approvals

| What | Who | When |
|---|---|---|
| Start, pause, resume, roll back, cancel, run auto-fix | Operator | Any time the state allows it |
| Approve a single-replica canary | Admin | A workload with one replica waits for approval before its only pod is replaced (Pro) |
| Approve promote | Admin | Every pipeline, in both tiers |

Before it accepts a promote approval, the controller checks the destination tag. It refuses a test build, and it refuses a destination that is the source image. In that case the pipeline stays where it was.

## Health checks and rollback

During canary and rollout, and while a pipeline waits for promote approval, the controller compares the hardened pods with the original ones every few seconds. The first matching row decides:

| Signal on the hardened pods | Result |
|---|---|
| A hardened pod hit a would-break | Roll back (`would-break:<path>`) |
| `CrashLoopBackOff` or `CreateContainerError` | Roll back (`crashloop`) |
| Image pull failing for more than 2 minutes | Roll back (`image-pull-failed`) |
| `OOMKilled`, unless the original pods were OOM-killed too | Roll back (`oom`) |
| The original pods are restarting or not Ready | Pause (`baseline-unhealthy`). Resumes by itself when they recover |
| More restarts than the original pods | Roll back (`restarts`) |
| Not Ready within 5 minutes | Roll back (`not-ready`) |

Health is judged from pod status: restarts, waiting reasons, OOM kills and readiness. A workload without a readiness probe is Ready as soon as it starts, so give the workload a readiness probe that means something before you rely on the canary.

A rollback also starts when an Operator asks for one, when a pipeline is cancelled during canary, rollout or promote, when the source-image watcher sees the source image change under the pipeline, and when a Pro licence is removed during canary or rollout.

**What a rollback does.** It first saves the logs of every hardened pod on the pipeline's timeline (the last 500 lines per container, including the previous terminated one, up to 64 KiB), so the evidence survives the pods. It then evicts the hardened pods one at a time through the Kubernetes Eviction API, so PodDisruptionBudgets are respected. The ReplicaSet or StatefulSet recreates each pod from its unchanged template, on the original image. The pipeline ends `rolled_back`, or `cancelled` after a cancel.

Because Tracepod never edited the pod template, there is nothing to revert. Rollback is "stop swapping, and replace the swapped pods".

## Promote and the handoff to your CD

The production tag is, in order of precedence: the `pipeline_promote_tag_template` setting, then the registry's tag strategy, then `<source-tag>-hardened`. The controller never pushes to the source tag.

After approval, the controller copies the staging image to the production tag by digest, reads the digest back from the registry and checks it matches the tested one, and records the promoted reference (`<repository>:<tag>@<digest>`). From here the image is yours to deploy with whatever you already use: Argo CD, Flux, a CI pipeline, `kubectl`. With Pro, the webhook keeps new pods on the hardened image until your CD has caught up.

The pipeline ends `completed` when the workload's pod template references the promoted image. If a promoted image is still not deployed after 7 days, the dashboard lists it under **Needs attention**.

Staging tags of finished pipelines are deleted after 24 hours. A digest that is promoted, used by a running pipeline or a pod, or also tagged elsewhere is never deleted. Set `pipeline_staging_cleanup` to `keep` to turn the cleanup off.

## If the controller restarts

Pipeline state is in the controller's database, so a pipeline continues from where it was when the controller comes back. While the controller is down the webhook fails open: new pods are created on the image in their template, unchanged.

## Settings

Change these on the dashboard's **Settings** page (Admin). Durations are in seconds.

| Setting | Default | Meaning |
|---|---|---|
| `pipeline_webhook_mode` | `off` | `off`, `observe` or `enforce` (Pro) |
| `pipeline_shadow_min_seconds` | `86400` | Minimum time in shadow |
| `pipeline_shadow_min_starts` | `1` | Container starts the sensor must see during shadow |
| `pipeline_canary_ready_timeout_seconds` | `300` | How long a hardened pod may take to become Ready |
| `pipeline_canary_min_seconds` | `1800` | How long the canary must stay healthy |
| `pipeline_rollout_steps` | `25,50,100` | Rollout steps, in percent. Must increase and end at 100 |
| `pipeline_step_min_seconds` | `900` | How long each rollout step must stay healthy |
| `pipeline_restart_tolerance` | `0` | Extra restarts allowed over the original pods |
| `pipeline_eviction_pace_seconds` | `30` | Minimum time between two evictions |
| `pipeline_eviction_timeout_seconds` | `600` | How long to wait for an eviction before pausing |
| `pipeline_image_pull_grace_seconds` | `120` | How long an image pull may fail before rollback |
| `pipeline_promote_tag_template` | empty | Production tag template. Empty uses the registry's tag strategy |
| `pipeline_handoff_attention_seconds` | `604800` | When an undeployed promoted image appears under Needs attention |
| `pipeline_autofix` | `suggest` | `off`, `suggest` or `auto` (Pro) |
| `pipeline_autofix_max_rounds` | `3` | Auto-fix rounds per workload (1 to 10) |
| `pipeline_staging_cleanup` | `delete` | `delete` or `keep` |
| `pipeline_staging_cleanup_grace_seconds` | `86400` | How long a finished pipeline's staging tag is kept |

## When a pipeline stops

| What you see | What to check |
|---|---|
| Shadow never passes | No container start was seen since shadow started. Restart the workload once |
| Blocked in shadow | Open would-breaks. See [Would-breaks](#would-breaks) and [Auto-fix](#auto-fix) |
| Paused: `namespace not opted in` | Add the label `tracepod.io/pipeline=enabled` to the namespace, then resume |
| Paused: `webhook-not-enforcing` | Set the webhook mode to `enforce` (Pro) |
| Paused: `mutation-not-applied` | The replacement pod came back unchanged. Check the namespace label, that the pod has no `tracepod.io/pipeline-skip` label, and that the API server can reach the controller on the webhook port |
| Paused: `eviction-timeout` | A PodDisruptionBudget or a stuck pod blocks the eviction. Resume when the budget allows one disruption |
| Paused: `pull-credentials-missing:<host>` | The workload cannot pull from the staging registry. See [Registries](/docs/platform/registries/) |
| Paused: `baseline-unhealthy` | The original pods are unhealthy too, so the image is not the cause. Fix the workload; the pipeline resumes by itself |
| Paused: `promote push: …` | The production push failed. Fix the registry credentials and resume |

More cases are on the [Troubleshooting](/docs/platform/troubleshooting/) page.
