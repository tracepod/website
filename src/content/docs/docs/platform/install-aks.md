---
title: Install on AKS
description: Install the Tracepod Platform on Azure Kubernetes Service - node check, storage, Helm install, first sign-in, Azure Container Registry, and uninstall.
---

This guide installs the Platform into an existing AKS cluster. Read the [overview](/docs/platform/overview/) first for what gets installed and what the cluster needs.

You need `kubectl`, `helm` 3.8 or later, `jq`, `curl` and the `az` CLI. You also need the registry host, user name, token, chart location and chart version that come with beta access.

## 0. Set the variables

Set these once in your shell. Every later block uses them.

```bash
RG=<resource group of the cluster>
CLUSTER=<your AKS cluster name>
ACR_NAME=<your ACR name, without .azurecr.io>
NS=tracepod                          # release namespace

# These come with beta access
TP_REGISTRY=<registry-host>
TP_REGISTRY_USER=<registry-user>
TP_REGISTRY_TOKEN=<registry-token>
CHART=<chart-location>               # an OCI chart reference
CHART_VERSION=<chart-version>

VALUES=./tracepod/examples/values-aks.yaml

az aks get-credentials --resource-group "$RG" --name "$CLUSTER"

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

You want `containerd://2.x`, which Ubuntu 24.04 and Azure Linux 3.0 node pools run. If the ARCH column shows both `amd64` and `arm64`, uncomment `controller.nodeSelector` in `$VALUES` and set the architecture of the workloads you will harden. The controller builds images for its own architecture.

**Ubuntu 22.04 node pools run containerd 1.7, where NRI may be off**, and the sensor crash-loops on such nodes. If you only have 22.04, add an Ubuntu 24.04 pool:

```bash
az aks nodepool add --resource-group "$RG" --cluster-name "$CLUSTER" \
  --name tpeval --node-count 2 --os-sku Ubuntu2404
```

Check `az aks nodepool add --help` for the `--os-sku` values your CLI version accepts.

Then run the discovery probe on one node of each node pool. It is read-only and needs no SSH:

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

Replace `<SENSOR_TAG>` with the value printed in step 0, so the probe matches the sensor the chart deploys.

Exit code 0 and `This node can run the Tracepod sensor.` mean the node is fine. Delete the debug pod afterwards:

```bash
kubectl get pods -o name | grep node-debugger | xargs -r kubectl delete
```

Tainted node pools (a system pool tainted `CriticalAddonsOnly`, GPU or spot pools) only run the sensor with a toleration, and workloads on nodes without a sensor are not profiled. Set `sensor.tolerations` in `$VALUES`, for example `[{operator: Exists}]` to run on every node.

## 2. Storage

The controller needs one ReadWriteOnce volume (10Gi by default). `values-aks.yaml` uses `managed-csi`, the AKS default StorageClass:

```bash
kubectl get storageclass
```

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

Edit `$VALUES` first if needed: `controller.licenseMode` (`""` for Free, `pro` for Pro), `controller.nodeSelector` and `sensor.tolerations`.

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

[Roles and sign-in](/docs/platform/roles-and-sign-in/) explains how this works. In short: create a ServiceAccount, add it to the `tracepod-rbac` ConfigMap with the `admin` role, create a token for the `tracepod` audience, and port-forward the controller Service. Add yourself to `tracepod-rbac` before you sign in: a user who is not listed in it is refused.

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
TOKEN=$(kubectl -n "$NS" create token tracepod-admin --audience tracepod --duration=24h)
echo "$TOKEN"
kubectl -n "$NS" port-forward svc/tracepod-controller 9090:8080
```

Open <http://localhost:9090> and paste the token on the **Sign in** page. To use the API, in a second shell (with `NS` and `TOKEN` set there too):

```bash
API=http://localhost:9090/api/v1
AUTH="Authorization: Bearer $TOKEN"
curl -s -H "$AUTH" "$API/auth/me" | jq
```

## 6. Connect Azure Container Registry

A pipeline needs a registry to push to. The controller pushes to ACR with credentials in a docker-config Secret. Use a service principal or a repository-scoped token.

```bash
REGISTRY_HOST="$ACR_NAME.azurecr.io"
REPO_PATH=tracepod-eval
ACR_ID=$(az acr show --name "$ACR_NAME" --query id -o tsv)
```

**Option 1: service principal** (works on every ACR SKU). `AcrPush` covers push and pull; `AcrDelete` lets the controller delete the staging tags of finished pipelines.

```bash
SP=$(az ad sp create-for-rbac --name tracepod-push --role AcrPush --scopes "$ACR_ID" -o json)
REGISTRY_USER=$(echo "$SP" | jq -r .appId)
REGISTRY_PASSWORD=$(echo "$SP" | jq -r .password)
az role assignment create --assignee "$REGISTRY_USER" --role AcrDelete --scope "$ACR_ID"
```

**Option 2: repository-scoped token.** A token covers one image repository: `--repository` takes one `<path>/<image>` scope for each image you will harden. Create one token per image repository, or use the service principal. For an image named `nginx`:

```bash
REGISTRY_USER=tracepod-push
REGISTRY_PASSWORD=$(az acr token create --name "$REGISTRY_USER" --registry "$ACR_NAME" \
  --repository "$REPO_PATH/nginx" content/read content/write content/delete \
  --query 'credentials.passwords[0].value' -o tsv)
```

Create the push Secret in the release namespace:

```bash
kubectl -n "$NS" create secret docker-registry tracepod-push \
  --docker-server="$REGISTRY_HOST" \
  --docker-username="$REGISTRY_USER" \
  --docker-password="$REGISTRY_PASSWORD"
```

Let the nodes pull from ACR with the cluster's kubelet identity:

```bash
az aks update --resource-group "$RG" --name "$CLUSTER" --attach-acr "$ACR_NAME"
```

Add the registry. In the dashboard, **Registries** → **Add registry**: type **Azure ACR**, login server `$REGISTRY_HOST`, repository path `$REPO_PATH`, authentication **Existing K8s secret** with Secret name `tracepod-push`, check **Nodes can pull this registry** (the attached ACR needs no pull Secret, so the pull-Secret check before a canary is skipped), tag strategy **Original + "-hardened"**, **Use as default registry**. Click **Test connection**, then **Save**. The same with the API:

```bash
curl -s -X POST "$API/registries" -H "$AUTH" -H 'Content-Type: application/json' -d "{
  \"name\": \"acr\",
  \"registry_type\": \"acr\",
  \"host\": \"$REGISTRY_HOST\",
  \"repository_path\": \"$REPO_PATH\",
  \"tag_strategy\": \"original-tag-hardened\",
  \"auth_mode\": \"secret\",
  \"k8s_secret_name\": \"tracepod-push\",
  \"nodes_can_pull\": true,
  \"is_default\": true
}" | jq
```

The same registry entry also serves source images hosted in this ACR, so private source images there can be hardened. See [Source image pulls](/docs/platform/registries/#source-image-pulls).

### GHCR, Docker Hub or Harbor instead

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

Deleting the namespace also removes the Secrets, including `tracepod-webhook-tls`, which the controller created. Then remove the Azure objects you created:

```bash
az ad sp delete --id "$REGISTRY_USER"                                   # option 1
az acr token delete --name tracepod-push --registry "$ACR_NAME" --yes   # option 2
az acr repository delete --name "$ACR_NAME" --repository "$REPO_PATH/nginx" --yes
```
