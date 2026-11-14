---
title: Roles and sign-in
description: Draft outline - how the Tracepod dashboard authenticates users with Kubernetes tokens, and what Viewer, Operator and Admin can do.
---

:::caution[Draft outline]
This page is an outline. The headings are the final structure; the full commands will be filled in before publishing.
:::

The Platform has no user database. It reuses your cluster's identities: you sign in with a Kubernetes bearer token, the controller asks the Kubernetes API whether the token is valid (a TokenReview), and it looks up the user name it gets back in a role list that you maintain.

## Roles

| Role | Can |
|---|---|
| **Viewer** | Read everything: workloads, builds, pipelines, would-breaks, the audit log |
| **Operator** | Everything a Viewer can, plus create builds, start, pause, resume, roll back and cancel pipelines, and run auto-fix |
| **Admin** | Everything an Operator can, plus approve canary and promote, change settings, manage registries and fleet policies, and create test builds |

Every action that changes something is written to the audit log with the user, the time and the target. Refused attempts to change something are recorded too.

## Assigning roles

Roles live in a ConfigMap named `tracepod-rbac` in the Tracepod namespace: one line per identity, `<user name>=<role>`. The chart does not create it; you do. The controller reads it on every request, so a change takes effect without a restart.

:::danger[TO CONFIRM BEFORE PUBLISHING]
State here which role an identity gets when the cluster accepts its token but it is not listed in `tracepod-rbac`. Owner to supply the final behaviour and wording.
:::

## Signing in for a pilot

The simplest identity is a ServiceAccount, because its user name is predictable: `system:serviceaccount:<namespace>:<name>`. This section will carry the four steps: create the ServiceAccount, add it to `tracepod-rbac`, create a short-lived token with `kubectl create token`, and paste it on the **Sign in** page. When the token expires, the dashboard returns to the sign-in page.

## Signing in with your identity provider

Any token your cluster's API server accepts is checked the same way; the user name in the role list is whatever the cluster reports for that user. This section will list the token types that have been tested (for example EKS IAM, Microsoft Entra ID and OIDC) and show how to find the user name.

## Reaching the dashboard

The chart creates a ClusterIP Service and no Ingress, so by default the dashboard is only reachable through `kubectl port-forward`. The chart has an optional Ingress; this section will say what to put in front of it.

## API access

The API uses the same token, as `Authorization: Bearer <token>`, and the same roles. Every `/api/v1` route except the health check needs a token.
