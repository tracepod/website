---
title: Registries
description: How the Tracepod Platform authenticates to your registry, where images are pushed, how source images are pulled, and how to set up GHCR, Docker Hub, Harbor, ACR and Amazon ECR.
---

The Platform pushes hardened images to a registry you configure on the **Registries** page. A pipeline publishes a staging tag there, promotes the tested digest to a production tag, and later deletes the staging tag. Adding a registry needs the Admin role.

## Where images go

Images are pushed to `<host>/<repository path>/<image name>:<tag>`, where the image name is the last part of the source image's name. For the source image `nginx:1.27-alpine`, host `ghcr.io` and repository path `acme/hardened`:

| Tag | Example |
|---|---|
| Staging | `ghcr.io/acme/hardened/nginx:1.27-alpine-tp-<build id>` |
| Production (default tag strategy) | `ghcr.io/acme/hardened/nginx:1.27-alpine-hardened` |

The source tag is never overwritten. Staging tags of finished pipelines are deleted after 24 hours. The credential needs delete rights for that, or set the setting `pipeline_staging_cleanup` to `keep`.

## Authentication modes

Each registry has one authentication mode. It is stored on the registry and never guessed from the host.

| Mode | Credentials | Use it for |
|---|---|---|
| **Existing K8s secret** (`secret`) | A `kubernetes.io/dockerconfigjson` Secret that you create. By default it is looked up in the controller's namespace | GHCR, Docker Hub, Harbor, ACR, any registry with a user name and a password or token |
| **Anonymous** (`anonymous`) | None | Local or in-cluster registries that accept unauthenticated pushes |
| **AWS ECR (IAM role)** (`ecr`) | The controller's own AWS identity, exchanged for an ECR token | Private Amazon ECR on EKS |

In Secret mode the registry entry stores the Secret's name, not its contents, and the controller only reads the Secret. Entries in the Secret are matched to the registry host the way docker matches them: case, a scheme and a path are ignored, so `https://ghcr.io/` matches `ghcr.io`.

**Test connection** on the form checks the registry before you save.

## Source image pulls

A build pulls the source image with the credentials of the registry configured for that image's host: its Secret, its ECR token, or no credentials for an anonymous registry. When several registries share a host, the default registry is used, then the first by name. If no registry matches the host, the pull is anonymous.

So to harden private images, add their registry too, even if you never push to it. If the matching registry's credentials cannot be read, the build fails with `source registry <name> credentials: …`. It does not fall back to an anonymous pull.

## Can the nodes pull the hardened image?

The pushed images are private on most registries. Kubernetes nodes must be able to pull them, for the Pro canary and rollout pods and for your CD when it deploys the promoted tag.

Before a Pro canary, the pipeline checks that the workload can pull the staging image. It looks for an image pull Secret with an entry for the registry host, on the pod template or on its ServiceAccount. If none is found, the pipeline pauses with `pull-credentials-missing:<host>`. The check is skipped when:

- the registry is anonymous;
- the registry uses **AWS ECR (IAM role)**, because the kubelet pulls with the node role;
- the registry has **Nodes can pull this registry** set. Use this when the nodes pull without a Secret, for example AKS with `az aks update --attach-acr <acr>`, or a public registry.

If the nodes cannot in fact pull, the canary pod shows `ImagePullBackOff` and the pipeline rolls back.

## Set up a registry with a Secret

This works for GHCR, Docker Hub, Harbor and ACR, on any cluster. The commands assume the variables `NS`, `API` and `AUTH` from the install guide, and the Admin role.

### 1. Set the variables

```bash
NS=tracepod                           # the Tracepod release namespace
REGISTRY_HOST=ghcr.io                 # ghcr.io | docker.io | harbor.example.com | <name>.azurecr.io
REPO_PATH=<github-user>/tracepod-eval # GHCR: <user or org>/<name>; Docker Hub: <user>; Harbor: <project>
REGISTRY_USER=<user name>
REGISTRY_PASSWORD=<token>
```

| Registry | Type in the dashboard | Host | Repository path | Credential |
|---|---|---|---|---|
| GitHub Container Registry | **Generic OCI** | `ghcr.io` | `<user or org>/<name>` | A GitHub token of your own with `write:packages` and `delete:packages` |
| Docker Hub | **Docker Hub** | `docker.io` (set by the form) | `<Docker Hub user>`. Docker Hub allows only one level | A personal access token with read, write and delete |
| Harbor | **Harbor** | Your Harbor host, for example `harbor.example.com` | A Harbor project | A robot account with push, pull and delete on the project |
| Azure Container Registry | **Azure ACR** | `<name>.azurecr.io` | Any path | See [Install on AKS](/docs/platform/install-aks/#6-connect-azure-container-registry) |

### 2. Create the push Secret in the release namespace

```bash
kubectl -n "$NS" create secret docker-registry tracepod-push \
  --docker-server="$REGISTRY_HOST" \
  --docker-username="$REGISTRY_USER" \
  --docker-password="$REGISTRY_PASSWORD"
```

### 3. Add the registry in the dashboard

**Registries** → **Add registry**:

| Field | Value |
|---|---|
| Name | Any name, for example `eval` |
| Type | From the table above |
| Registry URL / Harbor URL / Login server | `$REGISTRY_HOST` (Docker Hub has no host field) |
| Repository path | `$REPO_PATH` |
| Authentication | **Existing K8s secret**, Secret name `tracepod-push` |
| Nodes can pull this registry | Leave unchecked unless your nodes pull from it without a Secret (step 4) |
| Tag strategy | **Original + "-hardened"** |
| Use as default registry | Checked |

Click **Test connection**, then **Save**. Do not pick **Overwrite** as the tag strategy: promote refuses to push over the source tag.

The same with the API:

```bash
curl -s -X POST "$API/registries" -H "$AUTH" -H 'Content-Type: application/json' -d "{
  \"name\": \"eval\",
  \"registry_type\": \"oci\",
  \"host\": \"$REGISTRY_HOST\",
  \"repository_path\": \"$REPO_PATH\",
  \"tag_strategy\": \"original-tag-hardened\",
  \"auth_mode\": \"secret\",
  \"k8s_secret_name\": \"tracepod-push\",
  \"is_default\": true
}" | jq
```

`registry_type` is one of `oci`, `harbor`, `acr`, `ecr`, `dockerhub`, `gcr`.

### 4. Let the nodes pull the hardened images

Pick one:

- **The nodes can already pull** (AKS attached to ACR, a public registry). Check **Nodes can pull this registry** on the registry (`nodes_can_pull: true` in the API).
- **Otherwise**, create a pull Secret in the workload's namespace and attach it to the workload's ServiceAccount (`default` unless the pod template names another):

  ```bash
  APP_NS=<workload namespace>
  kubectl -n "$APP_NS" create secret docker-registry tracepod-pull \
    --docker-server="$REGISTRY_HOST" \
    --docker-username="$REGISTRY_USER" \
    --docker-password="$REGISTRY_PASSWORD"
  kubectl -n "$APP_NS" patch serviceaccount default \
    -p '{"imagePullSecrets":[{"name":"tracepod-pull"}]}'
  ```

  Pods created after the patch get the Secret. Use a read-only credential here if your registry offers one.

## Amazon ECR with an IAM role

In this mode the controller calls `ecr:GetAuthorizationToken` through the AWS SDK's default credential chain and pushes with the token it gets back. The chain picks up, in order: EKS Pod Identity, IRSA (web identity), environment variables, and the node's instance role. The token is cached in memory and replaced 15 minutes before its 12-hour expiry, so no Secret is needed and nothing has to be rotated. The token is never logged or returned by the API.

The host must be a private ECR host, `<account-id>.dkr.ecr.<region>.amazonaws.com`. The region comes from the host. The API refuses this mode with a non-ECR host, so the token is never sent anywhere but ECR.

Every registry operation uses the mode: the build push, the publish push, the promote copy and its read-back, staging cleanup, and **Test connection**. Source images follow the same rule (see [Source image pulls](#source-image-pulls)).

[Install on EKS](/docs/platform/install-eks/#6-connect-a-registry) has the commands in order. The policies are below.

### Permissions policy

Replace `<account-id>` and `<region>`, and narrow the repository ARN to the registry's repository path (`tracepod/hardened` in this example).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrToken",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "EcrPushPullCleanup",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:DescribeImages",
        "ecr:ListImages",
        "ecr:BatchDeleteImage"
      ],
      "Resource": "arn:aws:ecr:<region>:<account-id>:repository/tracepod/hardened/*"
    }
  ]
}
```

`ecr:GetAuthorizationToken` only works with `"Resource": "*"`. `ecr:ListImages` is needed because staging cleanup lists tags, and `ecr:BatchDeleteImage` for the cleanup delete. If you would rather keep staging tags, set `pipeline_staging_cleanup` to `keep` and drop it.

If the source images also live in ECR, add read access to their repositories: `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` and `ecr:BatchCheckLayerAvailability`.

### Trust policy for IRSA

The trust policy uses the cluster's OIDC provider. The controller's ServiceAccount is `tracepod-controller` in the release namespace (`tracepod` below).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/oidc.eks.<region>.amazonaws.com/id/<oidc-id>"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.<region>.amazonaws.com/id/<oidc-id>:sub": "system:serviceaccount:tracepod:tracepod-controller",
          "oidc.eks.<region>.amazonaws.com/id/<oidc-id>:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

Then annotate the ServiceAccount through Helm and restart the controller, as shown in [Install on EKS](/docs/platform/install-eks/#6-connect-a-registry). Changing only the annotation does not restart the controller, and IRSA injects the credentials when a pod is admitted.

### Trust policy for EKS Pod Identity

Install the EKS Pod Identity Agent add-on, then use this trust policy on the role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "pods.eks.amazonaws.com" },
      "Action": ["sts:AssumeRole", "sts:TagSession"]
    }
  ]
}
```

Associate the role with the ServiceAccount (no annotation is needed) and restart the controller so that the agent injects the credentials.

### Things ECR does differently

- **Repositories are not created on push.** Every source image gets its own repository, `<repository path>/<image>`, for example `tracepod/hardened/nginx`. Create them ahead of time, or add an ECR [repository creation template](https://docs.aws.amazon.com/AmazonECR/latest/userguide/repository-creation-templates.html) for the prefix.
- **Immutable tags.** If a repository has tag immutability enabled, promoting to `<tag>-hardened` a second time fails. Use mutable tags, or a `pipeline_promote_tag_template` that is unique per build.
- **The kubelet pulls with the node role.** Canary and rollout pods pull the staging image with the node's IAM role, not the controller's. The node role needs ECR read access; the managed `AmazonEC2ContainerRegistryReadOnly` policy is enough. If pulls fail, the pods show `ImagePullBackOff` and the pipeline rolls back.
- **Node role fallback.** Without IRSA or Pod Identity, the SDK falls back to the node's instance role through IMDS. On nodes with IMDSv2 and a hop limit of 1 the pod cannot reach IMDS. Prefer IRSA or Pod Identity over raising the hop limit.
