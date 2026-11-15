---
title: Troubleshooting
description: What to check when the Tracepod Platform install, sign-in, builds, registry pushes, pipelines or the admission webhook do not work.
---

Commands assume the variables from the install guide (`NS`, `API`, `AUTH`, `APP_NS`) and the release name `tracepod`.

Start with the two logs and the pipeline's timeline:

```bash
kubectl -n "$NS" logs deploy/tracepod-controller --tail=200
kubectl -n "$NS" logs ds/tracepod-sensor --tail=200          # one pod; use -l app.kubernetes.io/name=tracepod-sensor for all
curl -s -H "$AUTH" "$API/pipelines/<id>/events?limit=500" | jq '.events[] | {ts, kind, detail}'
```

The **Timeline** on the pipeline page shows the same events.

## Install

| Symptom | Cause | Fix |
|---|---|---|
| Controller pod `ImagePullBackOff`, `401 Unauthorized` or `denied` | The pull Secret is missing, in another namespace, has another name than `imagePullSecrets` in your values file, or holds the wrong token | `kubectl -n "$NS" get secret`; recreate the Secret with the registry host, user name and token that came with beta access |
| Controller pod `Pending`, PVC `Pending` | No StorageClass, or (EKS) the EBS CSI driver add-on is missing | `kubectl -n "$NS" describe pvc`; set `controller.pvc.storageClassName` or install the driver |
| Sensor pods `CrashLoopBackOff` | NRI is off on that node, or the kernel has no BTF | Run the discovery probe on that node (install guide, step 1). Use node images with containerd 2.x |
| Sensor pods not scheduled on some nodes, workloads there never appear | The nodes are tainted | Add `sensor.tolerations` (for example `[{operator: Exists}]`) and `helm upgrade` |
| Sensor or controller pods rejected with a Pod Security error | The namespace enforces `baseline` or `restricted` | `kubectl label namespace "$NS" pod-security.kubernetes.io/enforce=privileged` |

## Sign-in and API

See [Roles and sign-in](/docs/platform/roles-and-sign-in/).

| Symptom | Cause | Fix |
|---|---|---|
| `401 missing authorization header` | No token sent | Dashboard: sign in on the **Sign in** page. curl: add `-H "$AUTH"` |
| Sent back to **Sign in** with "Your token was refused or has expired", or `401 invalid token` | The token expired or is not a Kubernetes token for this cluster | `TOKEN=$(kubectl -n "$NS" create token tracepod-admin --duration=24h)` and sign in again |
| Signed in, but `403 insufficient permissions` | Your role does not allow the action | `curl -s -H "$AUTH" "$API/auth/me"` shows your user name and role. Add or change your line in the ConfigMap `tracepod-rbac`, key `roles`, in the release namespace |
| Port 9090 refused | The port-forward stopped. It ends when the controller pod is replaced | Run `kubectl -n "$NS" port-forward svc/tracepod-controller 9090:8080` again |

## No workloads appear

| Check | Command or fix |
|---|---|
| A sensor runs on the workload's node | `kubectl -n "$NS" get pods -o wide`; compare with `kubectl -n "$APP_NS" get pods -o wide` |
| The sensor reaches the controller | The sensor log has no `connection refused` or POST errors to `<release>-controller.<namespace>.svc:8080` |
| The workload started after the sensor | `kubectl -n "$APP_NS" rollout restart deploy/<name>` |
| It is a Deployment or StatefulSet | Bare pods, Jobs and DaemonSets are not profiled as workloads |
| Enough time has passed | A running container is posted every `sensor.snapshotInterval` (5 minutes by default), and when it stops |
| The workload is listed but a build fails with `profile has no source image` | Restart the workload so the sensor records the image |
| A build fails with `coverage N is below the configured minimum` | Profile for longer, or confirm the build anyway |

## Builds

| Symptom | Cause | Fix |
|---|---|---|
| Build `failed`, the error mentions `UNAUTHORIZED`, `401` or `denied` on the source image | No registry in Tracepod matches the source image's host, so the pull is anonymous | Add a registry for that host with its credentials. See [Source image pulls](/docs/platform/registries/#source-image-pulls) |
| Build `failed` with `source registry <name> credentials: …` | The matching registry's Secret cannot be read, or its ECR role fails | Fix the Secret or the role. The build does not fall back to an anonymous pull |
| Build `failed`, `no space left on device` | The controller's volume is full of build output | Delete old builds, or resize the claim with `kubectl` if its StorageClass allows expansion. `controller.pvc.size` (10Gi by default) only applies to new installs: an existing claim keeps its size on upgrade |
| The hardened image does not start: `exec format error` | Mixed CPU architectures. Builds use the controller node's architecture | Set `controller.nodeSelector` (`kubernetes.io/arch: amd64` or `arm64`) to the workloads' architecture, `helm upgrade`, and rebuild |

## Registry

See [Registries](/docs/platform/registries/).

| Symptom | Cause | Fix |
|---|---|---|
| Pipeline `paused` in publish with `staging push failed: … 401` or `UNAUTHORIZED` | Wrong credentials, or the Secret has no entry for the registry host | Recreate the Secret with `--docker-server=<registry host>`, then **Test connection** on the registry. ECR: check the role and its [trust policy](/docs/platform/registries/#amazon-ecr-with-an-iam-role) |
| ECR **Test connection** fails after adding the IRSA annotation | The controller pod is older than the annotation. IRSA injects credentials only when a pod is admitted, and an annotation-only `helm upgrade` does not restart it | `kubectl -n "$NS" rollout restart deployment/tracepod-controller` and wait for `rollout status` |
| `… 403` or `denied` | The credential cannot push to that repository | GHCR: `write:packages`. ACR: `AcrPush`, or a token with `content/write`. Harbor: a robot account with push on the project |
| `… NAME_UNKNOWN`, or the repository does not exist | The registry does not create repositories on push (ECR) | Create `<repository path>/<image name>` first, or add an ECR repository creation template |
| `cannot read registry credentials Secret` | The Secret is not in the release namespace | Create it there |
| Paused with `pull-credentials-missing:<host>` before canary (Pro) | The workload's ServiceAccount or pod template has no pull Secret for the staging host, and the registry neither uses an ECR IAM role nor is marked **Nodes can pull this registry** | Add a pull Secret, or check **Nodes can pull this registry** if the nodes pull without one. See [Let the nodes pull the hardened images](/docs/platform/registries/#4-let-the-nodes-pull-the-hardened-images). Then **Resume** |
| Hardened pods in `ImagePullBackOff` (Pro) | The pull Secret is wrong, the nodes cannot in fact pull, or the nodes cannot reach the registry | The pipeline rolls back as `image-pull-failed` after `pipeline_image_pull_grace_seconds`. Fix the Secret and start a new pipeline |
| Promote `paused` with `promote push: …` | The production push failed | Fix the credentials and **Resume** |

## Pipeline

The pause reasons are also listed on [The validation pipeline](/docs/platform/pipeline/#when-a-pipeline-stops).

| Symptom | Cause | Fix |
|---|---|---|
| Stays in shadow | No container start seen since shadow started, or `pipeline_shadow_min_seconds` (24 hours by default) has not elapsed | `kubectl rollout restart` the workload; check the gates on the pipeline page |
| Shadow, `blocked` | Open would-breaks | Read them, then run **Auto-fix**. See [Auto-fix](/docs/platform/pipeline/#auto-fix) |
| Would-breaks appear late | They arrive with the next sensor snapshot | Lower `sensor.snapshotInterval` (for example `20s`) |
| **Start pipeline** returns 409 | The workload already has an active pipeline, or the build is not `built` or `pushed` | Open the active pipeline (the response has `active_pipeline_id`), or cancel it |
| **Start pipeline** returns 422 | No default registry, or the workload is not a Deployment or StatefulSet | Add a registry and check **Use as default registry** |

## Webhook (Pro)

| Symptom | Cause | Fix |
|---|---|---|
| Paused at canary entry: `namespace not opted in` | The namespace has no label | `kubectl label ns "$APP_NS" tracepod.io/pipeline=enabled` |
| Paused: `webhook-not-enforcing` | `pipeline_webhook_mode` is `off` or `observe` | Set it to `enforce` (**Settings** → **Pipeline** → **Admission webhook mode**) |
| Paused: `mutation-not-applied`. The replacement pod came back on the original image | The API server cannot reach the webhook, or the webhook configuration has no CA bundle | `kubectl get mutatingwebhookconfiguration tracepod-pipeline -o jsonpath='{.webhooks[0].clientConfig.caBundle}' \| wc -c` must be greater than 0. The controller log has a line per admission with `reason=` and `took=`. On EKS allow TCP 9443 from the cluster security group to the nodes. The pod must not have the label `tracepod.io/pipeline-skip`. To regenerate the certificate: `kubectl -n "$NS" delete secret tracepod-webhook-tls` and restart the controller |
| Paused: `eviction-timeout` | A PodDisruptionBudget blocks the eviction | `kubectl -n "$APP_NS" get pdb`; resume when one disruption is allowed |
| Paused: `baseline-unhealthy` | The original pods are unhealthy too | Fix the workload. The pipeline resumes by itself when they recover |

The webhook fails open (`failurePolicy: Ignore`): if the controller is down, pods are created unchanged.

## Licence messages (403)

A Pro feature called on a Free install returns HTTP 403. The API calls the Free tier "Lite", so the message contains `is a Pro capability — this controller is running in Lite mode`.

| Action on Free | Message starts with |
|---|---|
| `pipeline_webhook_mode=enforce`, approving a canary | `In-place canary and rollout are a Pro capability` |
| `pipeline_autofix=auto` | `Unattended auto-fix (pipeline_autofix=auto) is a Pro capability` |
| CVE delta | `CVE delta is a Pro capability` |
| Policies, compliance | `Fleet policies and compliance are a Pro capability` |
| `webhook_url` | `Outbound webhooks (webhook_url) are a Pro capability` |
| `watch_auto_rebuild` | `Auto-rebuild on source-image change (watch_auto_rebuild) is a Pro capability` |
| VEX downloads | `VEX export is a Pro capability` |

If you expected Pro, check the controller's environment:

```bash
kubectl -n "$NS" get deploy tracepod-controller -o jsonpath='{.spec.template.spec.containers[0].env}' | jq
```

`TRACEPOD_LICENSE_MODE` must be `pro`. Unknown values fall back to Free. Set it with:

```bash
helm upgrade tracepod "$CHART" --version "$CHART_VERSION" -n "$NS" --reuse-values --set controller.licenseMode=pro
```
