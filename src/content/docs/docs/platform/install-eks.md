---
title: Install on EKS
description: Install the Tracepod Platform on Amazon EKS - node check, storage, Helm install, first sign-in, Amazon ECR with an IAM role, and uninstall.
---

This guide installs the Platform into an existing Amazon EKS cluster. Read the [overview](/docs/platform/overview/) first for what gets installed and what the cluster needs.

You need `kubectl`, `helm` 3.8 or later, `jq`, `curl` and the `aws` CLI. You also need the registry host, user name, token, chart location and chart version that come with beta access.

## 0. Set the variables

Set these once in your shell. Every later block uses them.

```bash
export AWS_REGION=eu-west-1
CLUSTER=<your EKS cluster name>
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
NS=tracepod                          # release namespace

# These come with beta access
TP_REGISTRY=<registry-host>
TP_REGISTRY_USER=<registry-user>
TP_REGISTRY_TOKEN=<registry-token>
CHART=<chart-location>               # an OCI chart reference
CHART_VERSION=<chart-version>

VALUES=./tracepod/examples/values-eks.yaml

aws eks update-kubeconfig --name "$CLUSTER" --region "$AWS_REGION"

echo "$TP_REGISTRY_TOKEN" | helm registry login "$TP_REGISTRY" -u "$TP_REGISTRY_USER" --password-stdin
helm pull "$CHART" --version "$CHART_VERSION" --untar     # unpacks ./tracepod, including examples/
SENSOR_TAG=$(helm show values "$CHART" --version "$CHART_VERSION" | awk '/tracepod-sensor/{f=1} f&&/tag:/{gsub(/"/,"",$2); print $2; exit}')
echo "sensor tag: $SENSOR_TAG"
```

The same token pulls the chart and the controller image. The sensor image is public. The example values files ship inside the chart, in `examples/`. Do not override `sensor.image.tag` or `controller.image.tag`: the chart pins a sensor that matches its controller.

## 1. Check the nodes

List the node OS images, container runtimes and architectures:

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,OS:.status.nodeInfo.osImage,RUNTIME:.status.nodeInfo.containerRuntimeVersion,KERNEL:.status.nodeInfo.kernelVersion,ARCH:.status.nodeInfo.architecture
```

You want `containerd://2.x`, which Amazon Linux 2023 node groups run. NRI is on by default in containerd 2.x and off by default in containerd 1.7. Bottlerocket 1.33 or later also runs containerd 2.x; run the probe below to check NRI on those nodes.

If the ARCH column shows both `amd64` and `arm64`, uncomment `controller.nodeSelector` in `$VALUES` and set the architecture of the workloads you will harden. The controller builds images for its own architecture.

Then run the discovery probe on one node of each node group. It is read-only and needs no SSH:

```bash
NODE=$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')
kubectl debug node/"$NODE" -it --profile=sysadmin --image=ubuntu:24.04 -- bash
```

Inside the debug pod:

```bash
apt-get update -qq && apt-get install -y -qq curl socat
curl -fsSLO https://raw.githubusercontent.com/tracepod/tracepod/<SENSOR_TAG>/hack/discovery-probe.sh
HOST_ROOT=/host bash discovery-probe.sh
exit
```

Replace `<SENSOR_TAG>` with the value printed in step 0, so the probe matches the sensor the chart deploys. `--profile=sysadmin` makes the debug pod privileged, so it can open the NRI socket on SELinux nodes such as Bottlerocket.

Exit code 0 and `This node can run the Tracepod sensor.` mean the node is fine. `FAIL` on NRI means the sensor will crash-loop on that node; use a node group whose image runs containerd 2.x. Delete the debug pod afterwards:

```bash
kubectl get pods -o name | grep node-debugger | xargs -r kubectl delete
```

Tainted node groups (GPU, spot, dedicated) only run the sensor with a toleration, and workloads on nodes without a sensor are not profiled. Set `sensor.tolerations` in `$VALUES`, for example `[{operator: Exists}]` to run on every node.

## 2. Storage

The controller needs one ReadWriteOnce volume (10Gi by default). `values-eks.yaml` uses the `gp2` StorageClass, which needs the Amazon EBS CSI driver add-on:

```bash
kubectl get storageclass
aws eks describe-addon --cluster-name "$CLUSTER" --addon-name aws-ebs-csi-driver --query addon.status
```

If the add-on is missing, install it (it needs an IAM role; see the AWS documentation for the EBS CSI driver), or set `controller.pvc.storageClassName` to a class you already use. An empty value uses the cluster default.

## 3. Create the namespace and the pull Secret

The cluster pulls the controller image with the token from step 0. The Secret must have the name listed under `imagePullSecrets` in `$VALUES`; the command below reads it from the file:

```bash
PULL_SECRET=$(awk '/^imagePullSecrets:/{f=1;next} f&&/name:/{print $NF; exit}' "$VALUES")
echo "pull Secret: $PULL_SECRET"

kubectl create namespace "$NS"
kubectl -n "$NS" create secret docker-registry "$PULL_SECRET" \
  --docker-server="$TP_REGISTRY" \
  --docker-username="$TP_REGISTRY_USER" \
  --docker-password="$TP_REGISTRY_TOKEN"
```

If your cluster enforces Pod Security Admission, allow privileged pods in this namespace (the sensor needs them):

```bash
kubectl label namespace "$NS" pod-security.kubernetes.io/enforce=privileged
```

## 4. Install

Edit `$VALUES` first if needed: `controller.licenseMode` (`""` for Free, `pro` for Pro), `controller.pvc.storageClassName`, `controller.nodeSelector` and `sensor.tolerations`.

```bash
helm install tracepod "$CHART" --version "$CHART_VERSION" -n "$NS" -f "$VALUES"

kubectl -n "$NS" rollout status deployment/tracepod-controller --timeout=5m
kubectl -n "$NS" rollout status daemonset/tracepod-sensor --timeout=5m
kubectl -n "$NS" get pods -o wide
```

Expect one `tracepod-controller-…` pod and one `tracepod-sensor-…` pod per node, all `Running`. Object names are `<release>-controller` and `<release>-sensor`; this guide uses the release name `tracepod`. Check that the sensor attached:

```bash
kubectl -n "$NS" logs ds/tracepod-sensor --tail=50
```

**Restart the workloads you want to profile** (`kubectl rollout restart`), so the sensor sees them start.

## 5. Sign in to the dashboard

[Roles and sign-in](/docs/platform/roles-and-sign-in/) explains how this works. In short: create a ServiceAccount, give it the `admin` role in the `tracepod-rbac` ConfigMap, create a token, and port-forward the controller Service.

```bash
kubectl -n "$NS" create serviceaccount tracepod-admin
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: tracepod-rbac
  namespace: $NS
data:
  roles: |
    system:serviceaccount:$NS:tracepod-admin=admin
EOF
TOKEN=$(kubectl -n "$NS" create token tracepod-admin --duration=24h)
echo "$TOKEN"
kubectl -n "$NS" port-forward svc/tracepod-controller 9090:8080
```

Open <http://localhost:9090> and paste the token on the **Sign in** page. To use the API, in a second shell (with `NS` and `TOKEN` set there too):

```bash
API=http://localhost:9090/api/v1
AUTH="Authorization: Bearer $TOKEN"
curl -s -H "$AUTH" "$API/auth/me" | jq
```

## 6. Connect a registry

A pipeline needs a registry to push to. Pick one option.

### Option A: Amazon ECR with an IAM role

The controller pushes to ECR with its own AWS identity, through IRSA or EKS Pod Identity. There is no Secret and nothing to rotate. The policies are on the [Registries](/docs/platform/registries/#amazon-ecr-with-an-iam-role) page.

1. **Create the IAM role** `tracepod-controller` with the [permissions policy for the controller role](/docs/platform/registries/#permissions-policy). The repository ARN in the policy follows the registry's repository path. This guide uses `tracepod-eval`, so use `arn:aws:ecr:<region>:<account-id>:repository/tracepod-eval/*`.

2. **Let the controller's ServiceAccount assume it.** The ServiceAccount is `tracepod-controller` in the release namespace (`$NS`). Either:

   - **IRSA.** Use the [IRSA trust policy](/docs/platform/registries/#trust-policy-for-irsa) with `system:serviceaccount:<NS>:tracepod-controller`, then set the annotation:

     ```bash
     helm upgrade tracepod "$CHART" --version "$CHART_VERSION" -n "$NS" --reuse-values \
       --set-string "controller.serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::$ACCOUNT_ID:role/tracepod-controller"
     ```

     The annotation alone does not restart the controller, and IRSA injects credentials only when a pod is admitted, so restart it:

     ```bash
     kubectl -n "$NS" rollout restart deployment/tracepod-controller
     kubectl -n "$NS" rollout status deployment/tracepod-controller --timeout=5m
     ```

     You can instead put the annotation in `$VALUES` before installing; the file has it commented out. A fresh install needs no restart.

   - **EKS Pod Identity.** Install the EKS Pod Identity Agent add-on, use the [Pod Identity trust policy](/docs/platform/registries/#trust-policy-for-eks-pod-identity), then:

     ```bash
     aws eks create-pod-identity-association --cluster-name "$CLUSTER" \
       --namespace "$NS" --service-account tracepod-controller \
       --role-arn "arn:aws:iam::$ACCOUNT_ID:role/tracepod-controller"
     kubectl -n "$NS" rollout restart deployment/tracepod-controller
     kubectl -n "$NS" rollout status deployment/tracepod-controller --timeout=5m
     ```

3. **Create the repository** for each image you will harden. ECR does not create repositories on push. For an image named `nginx`:

   ```bash
   aws ecr create-repository --repository-name tracepod-eval/nginx
   ```

4. **Add the registry.** In the dashboard, **Registries** → **Add registry**: type **AWS ECR**, your **Account ID** and **Region**, repository path `tracepod-eval`, authentication **AWS ECR (IAM role)**, tag strategy **Original + "-hardened"**, **Use as default registry**. Click **Test connection** (it gets a token and checks that ECR accepts it), then **Save**. The same with the API:

   ```bash
   curl -s -X POST "$API/registries" -H "$AUTH" -H 'Content-Type: application/json' -d "{
     \"name\": \"ecr\", \"registry_type\": \"ecr\",
     \"host\": \"$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com\",
     \"repository_path\": \"tracepod-eval\", \"auth_mode\": \"ecr\",
     \"tag_strategy\": \"original-tag-hardened\", \"is_default\": true}" | jq
   ```

5. **Node pulls.** Canary pods and the pods your CD deploys are pulled by the kubelet with the node IAM role, which needs ECR read access (`AmazonEC2ContainerRegistryReadOnly`, attached to managed node groups by default). For ECR registries with an IAM role, the pull-Secret check before a canary is skipped.

To harden private source images that live in ECR, give the role read access to their repositories too, and add their registry in Tracepod. See [Source image pulls](/docs/platform/registries/#source-image-pulls).

### Option B: GHCR, Docker Hub or Harbor with a Secret

Follow [Set up a registry with a Secret](/docs/platform/registries/#set-up-a-registry-with-a-secret) on the Registries page.

## 7. Opt a namespace in (Pro)

Free never changes a pod, so it needs no label. For Pro canary and rollout, a person labels each workload namespace. Never label `kube-system` or the Tracepod release namespace.

```bash
APP_NS=<workload namespace>
kubectl label namespace "$APP_NS" tracepod.io/pipeline=enabled
```

Then set the webhook mode, first to `observe` (records what would change), then to `enforce` (Pro only; canary needs it):

```bash
curl -s -X PUT "$API/settings" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"settings":{"pipeline_webhook_mode":"observe"}}' | jq .settings.pipeline_webhook_mode
```

The same is in the dashboard: **Settings** → **Pipeline** → **Admission webhook mode** → **Save**.

The EKS control plane must reach the controller pod on port 9443 for the webhook. Managed node groups with the cluster security group allow this. If your node security groups are custom, allow TCP 9443 from the cluster security group. The webhook fails open, so a blocked port shows up as a pipeline paused with `mutation-not-applied`, not as failing pods.

## 8. Next steps

Build a hardened image from a workload's page, then start a pipeline for the build. [The validation pipeline](/docs/platform/pipeline/) describes each stage. If something does not work, see [Troubleshooting](/docs/platform/troubleshooting/).

## 9. Uninstall

```bash
helm uninstall tracepod -n "$NS"
kubectl label namespace "$APP_NS" tracepod.io/pipeline-
```

`helm uninstall` removes the workloads and the webhook configuration, but keeps the controller's PersistentVolumeClaim (`tracepod-controller`) with the database and build output (`controller.persistence.keep`, default `true`). A reinstall with the same release name and namespace reuses it. To remove everything:

```bash
kubectl -n "$NS" delete pvc tracepod-controller
kubectl delete namespace "$NS"
```

Deleting the namespace also removes the Secrets, including `tracepod-webhook-tls`, which the controller created. Then remove the AWS objects (the pod identity association or the IRSA role, and the `tracepod-eval/*` ECR repositories) and the images in your registry.
