---
title: Install on EKS
description: Draft outline - installing the Tracepod Platform on Amazon EKS, from node check to first sign-in.
---

:::caution[Draft outline]
This page is an outline. The headings are the final structure; each section will get its full commands before publishing. The AWS-specific steps have not yet been run end to end on a real EKS cluster.
:::

You need the registry token and the Helm chart we send you when you [request access](/contact?plan=free), plus `kubectl`, `helm` 3.8 or later, `jq` and the `aws` CLI. Read the [overview](/docs/platform/overview/) first for what gets installed.

## 1. Check the nodes

Amazon Linux 2023 node groups run containerd 2.x with NRI on, which is what the sensor needs. Run the read-only [discovery probe](/docs/getting-started/requirements/) on one node of each node group through `kubectl debug`; no SSH is needed. On Bottlerocket, NRI is expected on (containerd 2.x), but the sensor has not yet been run there.

If the cluster has both amd64 and arm64 nodes, decide now which architecture the controller runs on: it builds images for its own architecture.

## 2. Storage

The controller needs one ReadWriteOnce volume, 10Gi by default. On EKS that means the EBS CSI driver add-on and a StorageClass that uses it. The example values file names the class; change it if you already use another.

## 3. Namespace and pull Secret

Create the namespace, then a `docker-registry` Secret that holds the token we sent you, so the cluster can pull the controller image. The sensor image is public. If the cluster enforces Pod Security Admission, label the namespace `pod-security.kubernetes.io/enforce=privileged`, because the sensor is a privileged pod.

## 4. Install the chart

One `helm install` with the EKS example values file. Expect one controller pod and one sensor pod per node. Tainted node groups (GPU, spot, dedicated) only get a sensor if you add a toleration. Restart the workloads you want to profile afterwards, so the sensor sees them start.

## 5. Sign in

Port-forward the controller Service and sign in with a Kubernetes token. [Roles and sign-in](/docs/platform/roles-and-sign-in/) has the steps.

## 6. Connect Amazon ECR

The recommended setup uses no Secret: the controller pushes with its own IAM role, through IRSA or EKS Pod Identity. This section will carry the IAM policy, the trust policy for each option, and the note that ECR does not create repositories on push. [Registries](/docs/platform/registries/) explains the choices.

## 7. Opt a namespace in (Pro)

Free never changes a pod and needs no label. For Pro canary and rollout, label each workload namespace and set the webhook mode. The EKS control plane must be able to reach the controller pod on the webhook port; this section will say which security-group rule that is when the node security groups are custom.

## 8. Uninstall

`helm uninstall` removes the workloads and the webhook configuration and keeps the controller's volume by default. The full removal steps are on [Architecture and security](/docs/platform/architecture-and-security/#uninstall), plus the AWS objects to delete: the role or pod identity association, and the ECR repositories.
