---
title: Amazon EKS
description: Profile and harden a real workload on Amazon EKS — node checks, sensor install, profiling, build, and validation, pinned to v0.2.3.
---

This guide walks through running Tracepod's OSS standalone flow (sensor DaemonSet via the Helm chart + the `harden` CLI — no controller, no dashboard) against a real workload on Amazon EKS.

This guide covers Tracepod v0.2.3 on EKS managed node groups running Amazon Linux 2023. It has not been run end-to-end against a live EKS cluster yet — treat it as a close reading of the v0.2.3 source and docs rather than a verified walkthrough, and expect to hit rough edges. AL2023 kernels 6.1, 6.12, and 6.18 (x86_64) are the versions exercised in CI; see [Requirements](/docs/getting-started/requirements/#which-kernels).

Budget roughly 60–90 minutes once the cluster and the application you're profiling already exist.

## Before you start

### Pick the application

Use one real application you ship, not a placeholder. `nginx` is a reasonable control if later steps behave strangely and you want to rule out an app-specific cause, but it isn't a substitute for profiling your actual workload.

### Clone the tagged chart and scripts

You'll need `hack/discovery-probe.sh` (step 1) and the Helm chart (step 2) from the exact tag. The probe steps below fetch the script via `curl` from `raw.githubusercontent.com`, which requires egress from wherever you run them — your workstation, an SSM session, or a debug pod. On a fully private node with no outbound internet, that `curl` will fail; copy the script out of this local clone instead (for example `kubectl cp` into the debug pod, or paste the script contents over the SSM session).

```bash
git clone --branch v0.2.3 https://github.com/tracepod/tracepod.git /tmp/tracepod-v0.2.3
```

### Set variables once

```bash
export CLUSTER=<your-eks-cluster-name>
export REGION=<your-aws-region>                 # e.g. eu-west-1
export NS_APP=<namespace-of-your-app>
export APP_DEPLOY=<deployment-name-of-your-app>
export APP_CONTAINER=<main-container-name-in-that-pod>   # not [0] — see step 3, "Capture identifiers"
export NODE=                                     # filled in during step 1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_MIRROR_REPO=tracepod-sensor-mirror     # only if egress is blocked
export ECR_HARDENED_REPO=${APP_DEPLOY}-hardened
export TRACEPOD_NS=tracepod
```

### Check for disqualifiers

| Check | Command | If true |
|---|---|---|
| Fargate-only cluster/namespace | `kubectl get nodes` (empty, or `aws eks describe-fargate-profile`) | Stop. DaemonSets cannot run on Fargate — there is no node to run the sensor on. |
| EKS Auto Mode | `aws eks describe-cluster --name $CLUSTER --query 'cluster.computeConfig.enabled'` | Not yet verified — use a managed node group or self-managed nodes instead. |
| Node OS / containerd version | `kubectl get nodes -o wide` (check the `OS-IMAGE` and `CONTAINER-RUNTIME` columns) | See the node OS table below. |

:::caution
Auto Mode's managed nodes have an unconfirmed privileged/`hostPID` admission policy. Don't use Auto Mode for your first run on this guide — use a managed node group or self-managed nodes instead.
:::

### Choose a node OS

Per [Known limitations](/docs/concepts/known-limitations/) and the [KNOWN-LIMITATIONS.md §0.6](https://github.com/tracepod/tracepod/blob/v0.2.3/docs/KNOWN-LIMITATIONS.md#06-nri-must-be-enabled-in-containerd-off-by-default-before-containerd-20) table at v0.2.3:

| Node image | containerd | NRI default | Use for your first run? |
|---|---|---|---|
| EKS AL2023 (current AMI) | 2.2.7 | On | Yes — use this. |
| EKS AL2 (older/EOL path) | 1.x | Off | No — NRI off by default, and containerd 1.x is EOL. |
| Bottlerocket `aws-k8s-1.33`+ | 2.x | Expected on (maintainer statement) | Not yet verified — Bottlerocket's SELinux interaction with the sensor's privileged pod (those pods run as `control_t`) is unconfirmed. Avoid until confirmed separately. |

Use a managed node group on the current AL2023 AMI. Confirm the actual containerd version on your nodes rather than relying on the table — run the probe in step 1.

### Pod Security Admission and policy engines

The sensor needs `privileged: true` and `hostPID: true` — a hard requirement, see [Known limitations](/docs/concepts/known-limitations/). If your cluster enforces restricted or baseline Pod Security Admission on new namespaces, label the Tracepod namespace before installing:

```bash
kubectl create namespace $TRACEPOD_NS --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace $TRACEPOD_NS \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/audit=privileged \
  pod-security.kubernetes.io/warn=privileged --overwrite
```

:::note
If Kyverno or Gatekeeper is installed, check for policies that block `privileged`/`hostPID` pods or require non-root — this varies per cluster. Run `kubectl get clusterpolicy,constraints -A 2>/dev/null` as a first look, and exempt the `tracepod` namespace if something blocks it.
:::

### Node egress for the sensor image

The sensor image is public: `ghcr.io/tracepod/tracepod-sensor:v0.2.3`. If your nodes have no NAT/internet egress (a fully private cluster), mirror it to ECR first:

```bash
aws ecr create-repository --repository-name $ECR_MIRROR_REPO --region $REGION || true
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

# crane (handles the multi-arch index correctly)
crane copy ghcr.io/tracepod/tracepod-sensor:v0.2.3 \
  $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_MIRROR_REPO:v0.2.3

# or skopeo — pass --all, or you only copy the arch of the host running the command
skopeo copy --all \
  docker://ghcr.io/tracepod/tracepod-sensor:v0.2.3 \
  docker://$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_MIRROR_REPO:v0.2.3
```

Then override at install time (values keys confirmed from `helm/tracepod/values.yaml` at v0.2.3 — `sensor.image.repository` / `sensor.image.tag`):

```bash
# add to the helm install command in step 2:
--set sensor.image.repository=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_MIRROR_REPO \
--set sensor.image.tag=v0.2.3
```

## 1. Check your nodes

Run this on every distinct node group/AMI you'll use for the application, if the app and sensor could land on different node groups.

### Route A: SSM Session Manager onto the node

```bash
# map node name -> instance ID
NODE=<a-node-in-the-target-nodegroup>
INSTANCE_ID=$(kubectl get node "$NODE" -o jsonpath='{.spec.providerID}' | awk -F/ '{print $NF}')
aws ssm start-session --target "$INSTANCE_ID" --region "$REGION"
```

:::note
This route needs the node IAM role to have `AmazonSSMManagedInstanceCore` attached and the SSM agent running on the AMI (standard on current EKS-optimized AL2023 AMIs, but not guaranteed on every custom AMI), plus the Session Manager plugin installed in your local AWS CLI. Confirm both before relying on this route.
:::

Once in the session (as root or via `sudo`), install `socat` first. Without it, the probe can only check that the NRI socket exists, not that it accepts connections:

```bash
sudo dnf install -y socat
curl -fsSLO https://raw.githubusercontent.com/tracepod/tracepod/v0.2.3/hack/discovery-probe.sh
sudo bash discovery-probe.sh
```

:::note
Confirm the exact package name and availability of `socat` on your AL2023 AMI — it may differ on a custom AMI.
:::

### Route B: `kubectl debug node` (no SSH/SSM access needed)

```bash
kubectl debug node/$NODE -it --image=ubuntu:24.04 -- bash
# inside the debug pod — the host filesystem is bind-mounted at /host, not /:
apt-get update -qq && apt-get install -y -qq curl socat
curl -fsSLO https://raw.githubusercontent.com/tracepod/tracepod/v0.2.3/hack/discovery-probe.sh
HOST_ROOT=/host bash discovery-probe.sh
```

The debug pod runs `ubuntu:24.04` regardless of the underlying node OS, so `apt-get install socat` works here even against an AL2023 node — this route doesn't have Route A's `socat` problem. Both the debug pod itself and the probe download need node egress to reach the container registry and GitHub respectively.

The debug pod itself will get profiled once the sensor is up — harmless, ignore it in the profile you care about later.

Exit codes (from the script's own header):
- `0` — NRI reachable and cgroup v2 present; the sensor will work on this node
- `1` — NRI unreachable, or the node isn't on cgroup v2; the sensor would trace nothing (remediation text printed)
- `2` — the probe itself couldn't run (non-Linux host)

✅ **Continue when** the probe prints `This node can run the Tracepod sensor.` and exits 0 on the node group you'll use for the app.
❌ **Stop if** it exits 1. Don't install yet — fix NRI first (custom launch template bootstrap userdata enabling `[plugins."io.containerd.nri.v1.nri"] disable = false`, or move to a node image where NRI defaults on) and re-run the probe.

## 2. Install the sensor

```bash
cd /tmp/tracepod-v0.2.3   # cloned above

helm install tracepod ./helm/tracepod \
  --namespace $TRACEPOD_NS --create-namespace
  # If you mirrored the sensor image to ECR, add before running:
  #   --set sensor.image.repository=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_MIRROR_REPO \
  #   --set sensor.image.tag=v0.2.3
  # If your node group is tainted (the chart sets no tolerations by default), add:
  #   --set-json 'sensor.tolerations=[{"key":"...","operator":"Exists","effect":"NoSchedule"}]'
```

`kubectl rollout status daemonset/...` is not a reliable check here: `rollout status` returns success vacuously if the DaemonSet has zero desired pods — for example because it never scheduled on your node due to a taint. Check explicitly instead:

```bash
kubectl -n $TRACEPOD_NS get pods -l app.kubernetes.io/name=tracepod-sensor -o wide
# confirm a Ready pod exists on $NODE specifically (the node the app will run on):
kubectl -n $TRACEPOD_NS get pods -l app.kubernetes.io/name=tracepod-sensor \
  --field-selector spec.nodeName=$NODE

SENSOR_POD=$(kubectl -n $TRACEPOD_NS get pods -l app.kubernetes.io/name=tracepod-sensor \
  --field-selector spec.nodeName=$NODE -o jsonpath='{.items[0].metadata.name}')
kubectl -n $TRACEPOD_NS logs "$SENSOR_POD" | tail -20
```

Expect the literal line (from `cmd/sensor/main.go`):

```
NRI connected — waiting for containers.
```

If instead the pod is `CrashLoopBackOff` and logs show (exact text from `cmd/sensor/main.go`):

```
fatal: NRI unavailable (...) — refusing to run: no containers would be traced. Enable NRI in containerd (docs/KNOWN-LIMITATIONS.md §0.6) or run hack/discovery-probe.sh on this node.
```

this is v0.2.3's deliberate behavior — before v0.2.3 the sensor warned and kept running quietly while tracing nothing; now it refuses to run instead. It self-heals once NRI is fixed on the node (kubelet backoff, up to ~5 minutes between restarts), with no other intervention needed.

`values.yaml` sets `sensor.resources: {}` (unbounded) by default — no resource overhead to account for unless you explicitly set limits.

✅ **Continue when** a Ready sensor pod exists on `$NODE`, with `NRI connected — waiting for containers.` in its logs.
❌ **Stop if** it's `CrashLoopBackOff` with the `fatal: NRI unavailable` message (fix NRI — step 1 was wrong, or the node changed), or no pod is scheduled on `$NODE` at all (check taints/tolerations/nodeSelector).

## 3. Profile your application

### Pin the app to one node

So you know in advance which sensor pod holds the profile:

```bash
HOSTNAME_LABEL=$(kubectl get node "$NODE" -o jsonpath='{.metadata.labels.kubernetes\.io/hostname}')

# capture the original replica count now — cleanup restores it later
ORIG_REPLICAS=$(kubectl -n $NS_APP get deployment "$APP_DEPLOY" -o jsonpath='{.spec.replicas}')

kubectl -n $NS_APP patch deployment "$APP_DEPLOY" --type=merge -p \
  '{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/hostname":"'"$HOSTNAME_LABEL"'"}}}}}'
```

:::caution
If Argo CD or Flux manages `$APP_DEPLOY` with auto-sync on, this patch will be reverted on the next sync. Pause auto-sync for this one Deployment, or do this on a non-prod cluster/namespace where no GitOps controller fights you. Also check for an HPA or KEDA `ScaledObject` on this Deployment — it can scale replicas back up concurrently with the "scale to 0" step below.
:::

✅ **Continue when** the Deployment's pods land only on `$NODE` after a rollout.
❌ **Stop if** GitOps or an HPA reverts it faster than you can work — resolve that first (pause sync, pause the HPA) rather than fighting it mid-run.

### Why order matters (the NRI startup race)

The NRI `StartContainer` hook is a synchronous barrier — containerd blocks on it, so for a container the sensor discovers via this hook (`adoption_mode: nri-start`), the sensor's cgroup registration happens before the workload execs, and attach-before-exec is guaranteed, not probabilistic. But if the container was already running when the sensor started, the sensor instead adopts it later via NRI's `Synchronize` hook (`adoption_mode: nri-sync`) — the container's early opens are gone, dropped before the sensor ever attached. See [Known limitations](/docs/concepts/known-limitations/) for the full explanation.

So the sensor must already be `Ready` (step 2) before you trigger a fresh rollout of the app. Do a rollout restart now, after the sensor is up, so the new pod's container start is caught by `nri-start`, not `nri-sync`.

```bash
kubectl -n $NS_APP rollout restart deployment/$APP_DEPLOY
kubectl -n $NS_APP rollout status deployment/$APP_DEPLOY
```

### Capture identifiers immediately

Once you scale to 0 later, the old pod (and its node/container ID) is gone. Capture these now, and be explicit about which container in the pod — real apps have sidecars/init containers, so don't trust index `[0]`. Build the selector from the Deployment's own `matchLabels` rather than guessing it, and restrict to `Running` so a still-terminating pod from the restart isn't picked instead:

```bash
SELECTOR=$(kubectl -n $NS_APP get deployment "$APP_DEPLOY" \
  -o jsonpath='{range $k,$v := .spec.selector.matchLabels}{$k}={$v},{end}' | sed 's/,$//')

APP_POD=$(kubectl -n $NS_APP get pods -l "$SELECTOR" \
  --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')

NODE=$(kubectl -n $NS_APP get pod "$APP_POD" -o jsonpath='{.spec.nodeName}')

CONTAINER_ID=$(kubectl -n $NS_APP get pod "$APP_POD" -o jsonpath=\
  "{.status.containerStatuses[?(@.name=='$APP_CONTAINER')].containerID}" | sed 's|containerd://||')

IMAGE_ID=$(kubectl -n $NS_APP get pod "$APP_POD" -o jsonpath=\
  "{.status.containerStatuses[?(@.name=='$APP_CONTAINER')].imageID}")

echo "NODE=$NODE  CONTAINER_ID=$CONTAINER_ID  IMAGE_ID=$IMAGE_ID"
```

`IMAGE_ID` is the digest-pinned source reference — use it (not a mutable tag) for `harden build --source` in step 4, so you harden exactly the bits that were profiled.

### Exercise the app for real

Confidence scoring ([Observation sources & confidence](/docs/concepts/observation-sources/)) defaults `--min-profile-duration` to 10 minutes — plan for at least that window:

- Hit the app's real routes/endpoints, not just `/healthz`. Static content, error pages, and rarely-hit code paths are only captured if a request actually arrives during the window.
- Run any real background jobs/cron paths the app has, if feasible in the window.
- If the app is a process-model server (forks/reloads workers, like nginx), trigger a reload or second-request pass during the window. This generates a fresh `execve` for the main binary while the cgroup is registered, so the binary gets observed with `source: "direct"` instead of relying only on ELF-dependency inference. This does not by itself reduce the `startup-race` penalty — that penalty is specific to `manual` entries whose `included_because` contains `"startup-race"`, i.e. paths you add by hand for the pre-NRI-hook phase; see `--include` in step 4. Run the reload against the live pod, e.g.:
  `kubectl exec -n $NS_APP $APP_POD -c $APP_CONTAINER -- <your app's reload command>`.

### Scale to 0 to flush

```bash
kubectl -n $NS_APP scale deployment/$APP_DEPLOY --replicas=0
```

The manifest is written to disk on the sensor's node when the container stops (not when the Deployment is edited) — give it a few seconds, then fetch.

### Fetch the profile

```bash
SENSOR=$(kubectl -n $TRACEPOD_NS get pod \
  -l app.kubernetes.io/name=tracepod-sensor \
  --field-selector spec.nodeName=$NODE \
  -o jsonpath='{.items[0].metadata.name}')

kubectl -n $TRACEPOD_NS exec "$SENSOR" -- ls "/profiles/$CONTAINER_ID/"
kubectl -n $TRACEPOD_NS exec "$SENSOR" -- cat "/profiles/$CONTAINER_ID/files.json" > files.json
```

(The sensor image is `ubuntu:24.04`-based, so `cat`/`ls` inside it work fine — this isn't a distroless image.)

### Check the profile before trusting it

Field names below are taken directly from `manifest/manifest.go` at v0.2.3 — use these exact `jq` paths, not guesses:

```bash
jq '{
  schema_version,
  profile_terminal,
  direct_count: ([.files[] | select(.source=="direct")] | length),
  total_files: (.files | length),
  adoption_mode: .coverage.adoption_mode,
  process_start_observed: .coverage.process_start_observed,
  event_loss_total: .event_loss.total,
  event_loss_by_stage: .event_loss.by_stage,
  event_loss_tolerated: .event_loss.tolerated,
  event_loss_not_instrumented: .event_loss.not_instrumented
}' files.json
```

What to require before moving on:

| Field | Want | Why |
|---|---|---|
| `schema_version` | `5` | Confirms you're reading a v0.2.3 sensor's output with `adoption_mode`/`profile_terminal` present — both are v5 additions and absent/meaningless on an older profile. |
| `direct_count` | non-zero | 0 direct entries means `harden build` will refuse (exit 3) unless you pass `--allow-empty`, which you should not for a production image. |
| `coverage.adoption_mode` | `"nri-start"` | Confirms the rollout-restart ordering above actually worked — attach-before-exec, not an adopted-already-running container. If you see `"nri-sync"`, the window is truncated by construction; redo the rollout restart above rather than proceeding. |
| `profile_terminal` | `true` | Confirms this manifest closed because the container actually stopped, not a mid-life snapshot with fewer-than-real file entries. |
| `event_loss.total` | `0` | Nonzero means events were dropped under buffer pressure during this window — the manifest may be missing paths with no indication which ones. Re-profile if nonzero, especially for a bursty app. |
| `event_loss.not_instrumented` | `[]` (empty) | A non-empty list names a drop point that could not be counted — a gap in the loss accounting itself, not just a loss. Treat as informational for v0.2.3; it should be empty in practice. |

If you see `adoption_mode: "nri-start"` together with `process_start_observed: false`, the sensor did win the attach-before-exec race but didn't observe the first exec cleanly — treat the entrypoint phase (shell, entrypoint script, pre-fork opens) as likely still missing, and expect to need `--include` for it in step 4, same as the `nri-sync` case.

✅ **Continue when** `direct_count` > 0, `adoption_mode == "nri-start"`, `profile_terminal == true`, `event_loss.total == 0`.
❌ **Stop if** any of the above fails — fix the specific cause (`nri-sync` → redo the restart-then-profile order; `event_loss` nonzero → reduce load or re-profile; `direct_count` 0 → sensor wasn't actually attached, redo steps 1–2) before building.

## 4. Build the hardened image

### Where to run `harden`

`harden` ships for Linux and macOS (goreleaser assets for v0.2.3: `tracepod_harden_0.2.3_{darwin,linux}_{amd64,arm64}.tar.gz`). Run it on whichever workstation you have Docker on — Docker is required if you also want `--smoke-test` (it shells out to `docker`), or want to `skopeo copy` into a local daemon afterward.

```bash
curl -fsSLO https://github.com/tracepod/tracepod/releases/download/v0.2.3/tracepod_harden_0.2.3_<os>_<arch>.tar.gz
tar xzf tracepod_harden_0.2.3_<os>_<arch>.tar.gz
./harden version
```

### ECR authentication for `harden`

`hardener/keychain.go` in the OSS source routes any `*.dkr.ecr.*.amazonaws.com` host to the AWS ECR credential helper (`ecr.NewECRHelper()`, driven by the AWS SDK's own credential chain — env vars, `~/.aws/credentials`, `AWS_PROFILE`, SSO cache, instance role). It does not read `~/.docker/config.json` for ECR hosts at all. `docker login` / `aws ecr get-login-password | docker login` has zero effect on `harden`'s pull or `--push` to ECR — only on `docker`/`skopeo` commands you run yourself.

What you actually need: working AWS credentials in the same shell you run `harden` from.

```bash
aws sso login --profile <your-profile>       # or however you normally authenticate
export AWS_PROFILE=<your-profile>
aws sts get-caller-identity                   # confirms credentials are live — this is the real check
```

:::note
Whether the AWS ECR credential helper's SDK chain picks up an SSO cache the same way the `aws` CLI does on your machine is worth confirming independently. `aws sts get-caller-identity` with the same environment is the closest proxy check, but the helper is a separate code path from the CLI.
:::

`harden build` prints an `Auth:` line (`docker-config` / `ecr-credential-helper` / `acr-credential-helper` / `explicit` / `anonymous`) showing which keychain path it selected based on hostname — this does not confirm the credentials actually resolve, only that routing happened. A bad or expired AWS credential still shows `Auth: ecr-credential-helper` and then fails later at the actual pull/push with a credential error.

If your source image is in ECR (your real app image, not just the sensor), the same mechanism applies to `--source`.

### Pick the platform flag correctly

`--platform` defaults to `linux/amd64` in `harden build`. If your node group (and `$NODE` specifically) is Graviton/arm64, you must set it explicitly, or the hardened image will be built for the wrong architecture and silently fail to boot on arm64 nodes:

```bash
ARCH=$(kubectl get node "$NODE" -o jsonpath='{.status.nodeInfo.architecture}')
# arch comes back as "amd64" or "arm64" — map to the --platform value:
PLATFORM=linux/$ARCH
```

### Create the ECR repo first

ECR does not auto-create a repository on push:

```bash
aws ecr create-repository --repository-name $ECR_HARDENED_REPO --region $REGION || true
```

### Build and push in one run

Use a single build that both writes the OCI layout to `--output` and pushes via `--push` — don't run `harden build` twice into the same `--output` dir (the OCI layout writer isn't designed to be appended to a second time; if you ever need to rebuild, use a fresh `--output` directory per round, as below with `-r1`/`-r2`):

```bash
export HARDENED_DIR=/tmp/${APP_DEPLOY}-hardened-r1

./harden build \
  --manifest files.json \
  --source   "$IMAGE_ID" \
  --output   "$HARDENED_DIR" \
  --platform "$PLATFORM" \
  --push     "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_HARDENED_REPO:r1" \
  --sbom \
  --verbose
```

`--sbom` requires `syft` on `PATH` — if it's missing, SBOM generation fails non-fatally (a warning; the build still succeeds).

Exit codes (from `cmd/harden/build.go` / the README):
- `0` — success
- `1` — fatal: missing required flags, pull failed, unresolved `DT_NEEDED` entries, or `--smoke-test` failure
- `2` — non-fatal: a scratch-compat file (other than `/etc/resolv.conf`, which is expected-absent) was missing from the source image layers
- `3` — manifest has zero `direct` entries (refused by design — pass `--allow-empty` to override, which you should not do for a production image)

Confidence output ([Observation sources & confidence](/docs/concepts/observation-sources/)): 80–100 High, 60–79 Medium, 40–59 Low, 0–39 Very Low (an extra `Warning:` line is printed at Very Low). A score below 100 is not itself a stop condition — read the penalty breakdown (`--verbose`) and decide whether the specific gaps matter for your app.

If `harden build` reports unresolved `DT_NEEDED` entries or missing files you expect, fix with `--include <path>` (repeatable; adds every regular file/symlink under that in-image directory with `source: "directory-inclusion"`, which isn't confidence-penalized) and rebuild into a fresh `--output` dir with a fresh `--push` tag (`-r2`, `-r3`, ...) rather than reusing either.

:::caution
The push happens inside `hardener.BuildImage`, which runs before `harden build`'s own checks for unresolved `DT_NEEDED` entries and before `--smoke-test` runs. That means a `Pushed: ...` line can appear in the output even on a run that ultimately exits 1 (unresolved deps, or smoke-test failure, both checked after the push already happened). Treat the process exit code as authoritative, not the presence of a `Pushed:` line. Use a fresh tag per round (`r1`, `r2`, ...) — besides tracking rounds, this also sidesteps ECR tag-immutability settings if your repo has that enabled.
:::

### What the hardened image keeps from source

Per `hardener/builder.go`, the hardened (scratch-based) image adopts the full runtime config from the source image — `Entrypoint`, `Cmd`, `Env`, `WorkingDir`, `User`, `Labels` (merged with `com.tracepod.*` provenance labels; Tracepod labels win on conflict). You don't need to re-specify `command`/`args` for the throwaway Deployment below — the image boots the same way the source image did. You do still need to supply any Secret/ConfigMap-backed env vars and volumes your app expects, same as any normal Deployment — those are pod-level, not image-level.

## 5. Run and validate it

`--smoke-test` (if you used it) only runs `docker run -d <image>` with no env, no config, no secrets, for a short grace window — it proves the image can execute its entrypoint, nothing about whether your app's actual runtime dependencies are present. Don't treat a `--smoke-test` pass as sufficient for a stateful/config-dependent real app. The in-cluster throwaway below, with the app's real env/config, is the actual check.

### Throwaway Deployment: namespace choice matters

:::caution
IRSA and EKS Pod Identity are both scoped to namespace + ServiceAccount name. A throwaway Deployment in a brand-new namespace will not inherit the app's IAM role unless you recreate the same ServiceAccount (with the same IRSA annotation / Pod Identity association) in that namespace too. The same applies to any `NetworkPolicy` scoped by namespace, and to PVCs (which don't move between namespaces at all).

The simpler alternative that avoids all of this: deploy the throwaway in the same namespace (`$NS_APP`) under a different name/labels, so it doesn't match any existing Service selector, and reuse the same ServiceAccount, Secrets, and ConfigMaps the real app already uses there.
:::

```bash
export THROWAWAY_NAME=${APP_DEPLOY}-tracepod-smoke
export NS_THROWAWAY=tracepod-smoke   # only if going the separate-namespace route; see above

kubectl get deployment "$APP_DEPLOY" -n "$NS_APP" -o yaml > /tmp/app-deploy-source.yaml
```

Edit `/tmp/app-deploy-source.yaml` into `/tmp/app-deploy-hardened.yaml` before applying — a raw `kubectl get -o yaml` of the Deployment you scaled to 0 in step 3 isn't safe to apply as-is:

- `metadata.name` → `$THROWAWAY_NAME`
- `spec.replicas` → `1` (it's currently `0` from step 3)
- `spec.selector.matchLabels` and `spec.template.metadata.labels` → change to a distinct value (e.g. add `app: $THROWAWAY_NAME`) so this Deployment does not overlap the real app's selector or get picked up by its Service
- the container image → `$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_HARDENED_REPO:r1`
- keep env/envFrom/volumes/serviceAccountName unchanged from the source
- strip `metadata.uid`, `metadata.resourceVersion`, `metadata.creationTimestamp`, and the whole top-level `status:` block (all are read-only/server-set, and `kubectl apply` will reject or ignore them, but they're easiest to just delete)

```bash
kubectl apply -n "$NS_APP" -f /tmp/app-deploy-hardened.yaml
kubectl -n "$NS_APP" rollout status deployment/$THROWAWAY_NAME
```

Run the app's own smoke command/health check against it (curl its real endpoint, run its actual readiness probe command manually, exercise whatever you'd normally use to confirm "this is up"). Or, if the app can run standalone without cluster-only dependencies, pull it locally instead (no `--all` here — `docker-daemon:` only ever takes one platform, unlike the ECR mirror copy above):

```bash
skopeo copy \
  docker://$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_HARDENED_REPO:r1 \
  docker-daemon:${APP_DEPLOY}:hardened-r1
docker run --rm -e <required-env> ${APP_DEPLOY}:hardened-r1 <your-app's-own-smoke-command>
```

**If it crashes:** read the error (usually a missing file/dir on first touch), find the path, rebuild with `--include <path>` (or `--mkdir`/`--touch` for empty dirs/files the app creates itself at runtime — these can't be added via `--include`, which skips empty directories), bump the output dir and ECR tag to `-r2`, and redeploy the throwaway.

✅ **Continue when** the throwaway (with the real app's env/config) starts and the app's own smoke check succeeds, with no further `--include`/`--mkdir`/`--touch` needed beyond step 3's known gaps.
❌ **Stop if** it keeps crashing after 2–3 `--include` rounds without converging — re-profile with a longer/more representative window (step 3) rather than guessing more `--include` paths.

## Clean up

```bash
# Remove the throwaway
kubectl delete deployment "$THROWAWAY_NAME" -n "$NS_APP"
# or, if you used a separate namespace:
kubectl delete namespace "$NS_THROWAWAY"

# Undo the nodeSelector pin on the real app, restore replicas:
kubectl -n $NS_APP patch deployment "$APP_DEPLOY" --type=json \
  -p='[{"op":"remove","path":"/spec/template/spec/nodeSelector/kubernetes.io~1hostname"}]'
kubectl -n $NS_APP scale deployment/$APP_DEPLOY --replicas=$ORIG_REPLICAS
# resume GitOps auto-sync / HPA if you paused it

# Uninstall the sensor
helm uninstall tracepod -n $TRACEPOD_NS
```

:::note
`helm uninstall` deletes the DaemonSet, ServiceAccount, and ClusterRole/Binding, but `profileHostPath` (`/var/lib/tracepod/profiles` by default, per `values.yaml`) is a `hostPath` volume — Helm does not clean up data written to a node's local disk. Leftover profile JSON files will remain on each node under that path until the node is recycled or you remove them manually (for example via another debug pod). Low sensitivity (just file paths/metadata, not secrets), but worth a line in any handoff.
:::

```bash
kubectl delete namespace "$TRACEPOD_NS"   # optional, only after confirming nothing else needs it

# ECR cleanup (optional — keep if you want to re-run without rebuilding)
aws ecr delete-repository --repository-name $ECR_HARDENED_REPO --region $REGION --force
aws ecr delete-repository --repository-name $ECR_MIRROR_REPO --region $REGION --force   # if you mirrored
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No profile appears after container stops | Pod not actually stopped (profile writes on container stop, not on Deployment edit); wrong node (`$NODE` stale after a reschedule); container started outside the CRI (`docker run` elsewhere); or container was running before the sensor started (`nri-sync`, early opens dropped) | Re-check `$NODE`/`$CONTAINER_ID` are current; confirm via `kubectl get pods` which node the pod is actually on now; re-profile with the rollout-restart-after-sensor-ready ordering (step 3) |
| Sensor `CrashLoopBackOff`, logs show `fatal: NRI unavailable` | NRI disabled in containerd on this node (containerd <2.0 default, or explicitly disabled) | Fix the containerd config (bootstrap userdata on an EKS custom launch template) and let kubelet restart the pod; re-run the step 1 probe first to confirm |
| Sensor pod `ImagePullBackOff` | No node egress to `ghcr.io`, or ECR mirror ref/credentials wrong | Mirror to ECR (see above) and/or check the node IAM role can pull from the mirror repo |
| Sensor pod stuck `Pending`/not created on the app's node | Node group taint with no matching toleration in `values.yaml` (chart sets none by default) | `--set` tolerations at install matching the node group's taints |
| PSA rejects the sensor pod | Namespace enforces restricted/baseline PSA | Label the namespace `pod-security.kubernetes.io/enforce=privileged` |
| `harden build` exits 3 | Manifest has zero `direct` entries — sensor wasn't attached, or the profiling window captured nothing | Re-check steps 1/2 passed on the right node; redo step 3 profiling; don't use `--allow-empty` for a production image |
| `harden build` exits 1 with unresolved `DT_NEEDED` entries | ELF dependency not found in source image layers | Investigate the specific `.so`; `--include` its directory if it's a plugin/optional lib, or re-profile if it should have been observed via `dlopen`/mmap |
| `harden build` exits 2 | A scratch-compat file other than `/etc/resolv.conf` missing from source image layers | Read the specific `Warning:` line; usually harmless, but confirm |
| Hardened image crashes in the throwaway | Missing file/dir the app needs at runtime, not observed during profiling | Read the exact error (missing path), add via `--include` (files/non-empty dirs) or `--mkdir`/`--touch` (empty dirs/0-byte files) or `--tmpfs` at runtime for empty dirs the app itself creates, rebuild as `-r2`, redeploy |
| `harden build` `Auth:` line looks right but pull/push still fails with a credential error | `Auth:` only reports keychain routing by hostname, not whether credentials actually resolved | Run `aws sts get-caller-identity` in the same shell/profile `harden` is using; re-authenticate (`aws sso login`) if stale |
