---
title: Roles and sign-in
description: How the Tracepod dashboard and API authenticate users with Kubernetes tokens, how to assign the Viewer, Operator and Admin roles, and how to sign in.
---

The Platform has no user database. It reuses your cluster's identities: you sign in with a Kubernetes bearer token, the controller asks the Kubernetes API whether the token is valid (a TokenReview), and it looks up the user name it gets back in a role list that you maintain.

## Roles

| Role | Can |
|---|---|
| `viewer` | Read everything: workloads, builds, pipelines, would-breaks, the audit log |
| `operator` | Everything a Viewer can, plus profile actions, create builds, start, pause, resume, roll back and cancel pipelines, and run auto-fix |
| `admin` | Everything an Operator can, plus approve canary and promote, change settings, manage registries, and create test builds |

Actions that change something are written to the audit log with the user, the action and the target. Refused attempts to change something are recorded too.

## Assigning roles

Roles live in a ConfigMap named `tracepod-rbac` in the Tracepod release namespace, under the key `roles`. Each line is `<user name>=<role>`. The chart does not create the ConfigMap; you do. Add a line for every identity that should have a role.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tracepod-rbac
  namespace: tracepod
data:
  roles: |
    system:serviceaccount:tracepod:tracepod-admin=admin
    system:serviceaccount:tracepod:tracepod-operator=operator
```

The controller reads the ConfigMap on every request, so a change takes effect without a restart.

## Signing in with a ServiceAccount

The simplest identity is a Kubernetes ServiceAccount, because its user name is predictable: `system:serviceaccount:<namespace>:<name>`. The commands use `NS` for the release namespace.

1. Create a ServiceAccount and give it the `admin` role:

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
   ```

2. Create a token, valid for 24 hours here:

   ```bash
   TOKEN=$(kubectl -n "$NS" create token tracepod-admin --duration=24h)
   echo "$TOKEN"
   ```

3. Reach the dashboard through a port-forward. The Service is named `<release>-controller`:

   ```bash
   kubectl -n "$NS" port-forward svc/tracepod-controller 9090:8080
   ```

4. Open <http://localhost:9090>. You land on **Sign in**. Paste the token into **Token** and click **Sign in**. The sidebar then shows your user and role. **Sign out** is in the user menu in the sidebar.

When the token expires, the dashboard returns to the sign-in page with "Your token was refused or has expired". Create a new token and sign in again.

## Other identities

The controller checks every token the same way, through the cluster's TokenReview API, and the user name in the role list is the one the cluster reports for that token. After you sign in, the sidebar shows that user name, and so does the API:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:9090/api/v1/auth/me | jq
```

## Reaching the dashboard

The chart creates a ClusterIP Service and no Ingress, so by default the dashboard is only reachable through `kubectl port-forward`. The port-forward ends when the controller pod is replaced; run it again.

The chart has an optional Ingress (`controller.ingress.enabled`, off by default) with a class name, a host, annotations and a TLS section.

## API access

The API uses the same token and the same roles. Every `/api/v1` route except `/api/v1/health` needs the header `Authorization: Bearer <token>`.

```bash
API=http://localhost:9090/api/v1
AUTH="Authorization: Bearer $TOKEN"
curl -s -H "$AUTH" "$API/auth/me" | jq
```

For the admin ServiceAccount above, the response shows `"role": "admin"`.

:::caution[Do not disable authentication on a shared cluster]
The Helm value `controller.authDisabled=true` skips the token check and makes every request an Admin. It is for a local kind cluster only. Do not set it on a cluster that anyone else can reach.
:::
