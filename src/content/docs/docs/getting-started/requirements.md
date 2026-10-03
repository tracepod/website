---
title: Requirements
description: What a node needs before you install the Tracepod sensor, and how to check it with the discovery probe before you deploy.
---

Before installing the sensor, check whether the node can run it. The sensor's
only container-discovery mechanism is containerd's NRI (Node Resource Interface), and on
a node where NRI is unreachable the sensor **exits non-zero and refuses to run** — the
pod goes `CrashLoopBackOff` / not `Ready` instead of tracing silently. Logs show:

```
fatal: NRI unavailable (...) — refusing to run: no containers would be traced.
```

It recovers on its own, with no manual intervention beyond fixing the containerd config,
once NRI is enabled on the node — the next kubelet-driven restart connects normally.
(Before v0.2.3 the sensor instead warned once to stderr and kept running with an empty
BPF allowlist, so the pod stayed `Ready` while tracing nothing — if you're running an
older sensor image, that's the behavior to expect instead.) Work through this page, then
run the probe below, before you `helm install`.

## What a node needs

- **containerd, with NRI enabled.** NRI ships **disabled by default on containerd below
  2.0**, and **enabled by default from containerd 2.0 onward**. Whether your nodes already
  have it on depends entirely on which containerd version the node image bundles — see
  [Enabling NRI on containerd 1.x](#enabling-nri-on-containerd-1x) below if you're on an
  older image.
- **`privileged: true` and `hostPID: true`** on the sensor pod. Attaching BPF kprobes and
  reading cgroup IDs requires both. The Helm chart sets these automatically; you cannot
  run the sensor without them.
- **cgroup v2.** The sensor identifies cgroups by directory inode
  (`bpf_get_current_cgroup_id`), which is a cgroup-v2-only semantic. cgroup v1 nodes are
  not supported.
- **Kernel BTF.** The DaemonSet mounts `/sys/kernel/btf` from the host as a read-only
  `Directory` volume, and the sensor needs `/sys/kernel/btf/vmlinux` to load its CO-RE BPF
  programs. If that path is missing, the pod will hang in `ContainerCreating` rather than
  fail cleanly.

## Enabling NRI on containerd 1.x

If your nodes are still on containerd 1.x (NRI off by default), add this to
`/etc/containerd/config.toml` on each node and restart containerd:

```toml
[plugins."io.containerd.nri.v1.nri"]
  disable = false
  socket_path = "/var/run/nri/nri.sock"
```

Where to make that change depends on the platform:

| Platform | Mechanism |
|---|---|
| EKS (managed node group with a custom launch template) | Bootstrap userdata writes the config and restarts containerd before the kubelet starts |
| EKS (self-managed nodes / Karpenter `NodeClass`) | Same, via the AMI's userdata or a `NodeClass` userdata block |
| AKS | Node customization / custom node configuration on the node pool |
| kubeadm, k3s, on-prem | Edit `/etc/containerd/config.toml` directly |

This costs one bootstrap line and is the recommended fix wherever you can make it. On AKS,
moving the node pool to a containerd-2.x image (for example, Ubuntu 24.04) is often
simpler than patching the 1.x config.

Where this does **not** work: managed node groups on a containerd-1.x image with no
custom launch template, where you cannot edit containerd's configuration at all.

## Where this does not work

- **GKE Autopilot** — blocks privileged pods at the admission-controller level.
- **AWS Fargate** — no access to the underlying node; DaemonSets aren't supported there.
- **Any node pool whose PodSecurity policy forbids `privileged` or `hostPID`** — for
  example a cluster enforcing the `restricted` Pod Security Standard, or an OpenShift
  project without a custom SecurityContextConstraint.
- **Containers started outside the CRI** — `docker run`, `nerdctl run`,
  `docker-compose`/`docker compose`, or `ctr run` all talk to containerd's native API
  directly rather than going through the CRI plugin, so they never fire the NRI events
  the sensor relies on. This is a **silent miss**: the sensor stays healthy, the
  container runs fine, and no manifest is ever written, with no error on either side.
  Only containers started through kubelet or `crictl` are profiled.

### Bottlerocket

NRI is expected on for Bottlerocket's `aws-k8s-1.33`+ variants (containerd 2.x), per a
maintainer statement — there is no Bottlerocket setting that toggles it. Whether the
sensor's privileged pod works under Bottlerocket's SELinux policy is **unverified**, not
confirmed either way. Treat Bottlerocket as untested and run the probe below before
relying on it.

## Which kernels

Rather than quote a minimum kernel version, this lists what's exercised in CI on
every pull request:

- **Amazon Linux 2023, kernels 6.1, 6.12, and 6.18 (x86_64)** — the full end-to-end path
  (sensor DaemonSet via Helm, profiling, `harden build`, hardened-image validation) runs
  against all three as a required check.
- **GitHub-hosted `ubuntu-latest` runners** — additional CI jobs run on these, but the
  exact kernel version they carry isn't something the project pins or publishes, so it
  isn't listed here as a tested version.

If your node is on a kernel outside that AL2023 matrix, run the probe below to find
out whether it works.

## Run the discovery probe before you install

The repository ships `hack/discovery-probe.sh`, which checks the node before you deploy,
instead of finding out from a `CrashLoopBackOff` afterward. Run it directly on the node,
for example over SSH, or via SSM Session Manager on EKS:

```bash
curl -fsSLO https://raw.githubusercontent.com/tracepod/tracepod/v0.2.6/hack/discovery-probe.sh
chmod +x discovery-probe.sh
./discovery-probe.sh
```

With no node/SSH access, run it via a node-debug pod instead. The debug pod's own
`/sys`/`/proc` reflect the pod, not the host — the host filesystem is bind-mounted at
`/host` instead, so `HOST_ROOT` must be set, and the debug image needs `bash` and
`socat` (not just `/bin/sh`):

```bash
kubectl debug node/<node-name> -it --image=ubuntu:24.04 -- bash
# then, inside the debug pod:
apt-get update -qq && apt-get install -y -qq curl socat
curl -fsSLO https://raw.githubusercontent.com/tracepod/tracepod/v0.2.6/hack/discovery-probe.sh
HOST_ROOT=/host bash discovery-probe.sh
```

It needs `bash` (not a plain `/bin/sh`), and it's read-only — it writes only under `/tmp`
and never restarts anything.

**Exit codes:**

| Exit | Meaning |
|------|---------|
| `0` | NRI reachable and cgroup v2 present — the sensor will work on this node |
| `1` | NRI unreachable, or the node isn't on cgroup v2 — the sensor would trace nothing. The script prints the specific remediation for whichever check failed |
| `2` | The probe itself couldn't run (non-Linux host) |

Two things worth knowing before you trust the exit code on its own:

- **The exit code covers NRI and cgroup v2 only.** It also checks kernel BTF and
  cgroupfs readability and prints `PASS`/`WARN`/`FAIL` for each, but a BTF or cgroupfs
  `FAIL` does not by itself turn the exit code to `1` — read every `FAIL` line in the
  output as blocking, not just the final verdict. A missing BTF path, for instance, means
  the sensor pod will hang in `ContainerCreating` even if the script exits `0`.
- **Without `socat` on the node, the NRI check is weaker.** If the NRI socket exists but
  `socat` isn't available to test a real connection, the probe warns and assumes NRI is
  enabled rather than confirming it. Install `socat` first if you want a definitive
  answer.

The probe also checks node-level preconditions only — it says nothing about whether your
*cluster* will admit a privileged, `hostPID` pod in the first place (see
[Where this does not work](#where-this-does-not-work) above). And because NRI availability
and kernel version can both vary by node pool or node image within the same cluster, run
the probe against each node pool you intend to deploy to, not just one node.

Running on Amazon EKS? See the [EKS guide](/docs/guides/eks/).

## Next steps

- [Installation](/docs/getting-started/installation/) — install the sensor via Helm
- [Quickstart](/docs/getting-started/quickstart/) — profile and harden your first container
- [Known limitations](/docs/concepts/known-limitations/) — the full set of sensor coverage gaps
