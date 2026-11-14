---
title: Registries
description: Draft outline - how the Tracepod Platform authenticates to your registry, where images are pushed, and how source images are pulled.
---

:::caution[Draft outline]
This page is an outline. The headings are the final structure; the full reference (IAM policies, Secret formats, per-registry notes) will be filled in before publishing.
:::

The Platform pushes hardened images to a registry you configure on the **Registries** page. A pipeline publishes a staging tag there, promotes the tested digest to a production tag, and later deletes the staging tag. Adding a registry needs the Admin role.

## Where images go

Images are pushed to `<host>/<repository path>/<image name>:<tag>`, where the image name is the last part of the source image's name. For the source image `nginx:1.27-alpine`, host `ghcr.io` and repository path `acme/hardened`:

| Tag | Example |
|---|---|
| Staging | `ghcr.io/acme/hardened/nginx:1.27-alpine-tp-<build id>` |
| Production (default tag strategy) | `ghcr.io/acme/hardened/nginx:1.27-alpine-hardened` |

The source tag is never overwritten. The credential needs delete rights for the staging cleanup, or you can turn the cleanup off.

## Authentication modes

| Mode | Credentials | Use it for |
|---|---|---|
| Secret | A `kubernetes.io/dockerconfigjson` Secret that you create. The controller only reads it | GHCR, Docker Hub, Harbor, ACR, any registry with a user name and a password or token |
| Anonymous | None | Local or in-cluster registries that accept unauthenticated pushes |
| AWS ECR (IAM role) | The controller's own AWS identity, exchanged for a short-lived ECR token | Private Amazon ECR on EKS. No Secret, nothing to rotate |

In Secret mode the registry entry stores the Secret's name, not its contents. **Test connection** on the form checks the registry before you save.

## Source image pulls

A build pulls the source image with the credentials of the registry configured for that image's host. To harden private images, add their registry too, even if you never push to it. If the matching registry's credentials cannot be read, the build fails; it does not fall back to an anonymous pull.

## Can the nodes pull the hardened image? (Pro)

Before a canary, the pipeline checks that the workload can pull from the staging registry: an image pull Secret on the pod template or its ServiceAccount. The check is skipped for anonymous registries, for ECR with an IAM role (the kubelet pulls with the node role), and for registries marked **Nodes can pull this registry**, for example an ACR attached to an AKS cluster.

## Per-registry notes

This section will carry one short recipe each for Amazon ECR, Azure Container Registry, GHCR, Docker Hub and Harbor: the minimum permissions, and the things each registry does differently (ECR does not create repositories on push, for example).
