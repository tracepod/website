---
title: CLI reference
description: Complete flag reference for the harden, sensor, and tracepod command-line tools.
---

Tracepod ships three binaries. All flags below are verified against the source of the current release line.

## `harden`

The image hardener. Cross-platform (Linux + macOS), no kernel dependency.

```
harden <subcommand> [flags]
```

| Subcommand | Purpose |
|------------|---------|
| `build` | Build a `FROM scratch` OCI image from a sensor manifest (the main workflow) |
| `extract` | Pull an image and extract the manifest file set to disk (inspection/debugging) |
| `version` | Print version information |

Run `harden <subcommand> -help` for the built-in flag reference.

### `harden build`

Assembles a FROM-scratch OCI image from a sensor manifest, writes it as an OCI layout to `--output`, and optionally pushes it.

| Flag | Default | Description |
|------|---------|-------------|
| `--manifest <path>` | — | Path to manifest JSON produced by the sensor (**required**) |
| `--source <ref>` | — | OCI image reference used during profiling, e.g. `nginx:1.25-alpine` (**required**) |
| `--output <dir>` | — | Destination directory for the OCI layout (**required**) |
| `--push <ref>` | — | Push the image to this registry reference after building |
| `--base <name>` | `scratch` | Base image (only `scratch` is currently implemented) |
| `--platform <os/arch>` | `linux/amd64` | Image platform — must match your deployment target |
| `--include <path>` | — | Force-include all files under this in-image directory (repeatable) |
| `--mkdir <path>` | — | Create an empty directory in the hardened image even if absent from source (repeatable) |
| `--touch <path>` | — | Create an empty 0-byte file in the hardened image if absent from source (repeatable) |
| `--username <user>` | — | Registry username (overrides keychain; must pair with `--password`) |
| `--password <pass>` | — | Registry password (must pair with `--username`) |
| `--insecure` | `false` | Skip TLS certificate verification |
| `--work-dir <dir>` | system temp | Temp directory for staging |
| `--min-profile-duration <dur>` | `10m` | Minimum recommended profiling window for confidence scoring |
| `--verbose` | `false` | Print the full confidence penalty breakdown and ELF audit warnings |
| `--sbom` | `false` | Generate CycloneDX and SPDX SBOMs via syft into the `--output` directory |
| `--sbom-sign-key <path>` | — | Path to a cosign private key for signing SBOMs (requires `--sbom`) |
| `--smoke-test` | `false` | After building, load the image into the local Docker daemon and run it briefly — fails the build if the minimized image cannot boot |
| `--smoke-window <dur>` | `5s` | How long the smoke-test container must survive (requires `--smoke-test`) |

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Fatal error — missing required flags, pull/network failure, unresolved ELF dependencies, failed smoke test |
| `2` | Warning: a scratch-compat file other than `resolv.conf` absent from source image layers (`resolv.conf` absence is expected and exits 0) |

See [Outputs](/docs/concepts/outputs/) for what a build produces and [Observation sources & confidence](/docs/concepts/observation-sources/) for the confidence score behind the `Confidence:` line.

### `harden extract`

Pulls an OCI image, extracts the files listed in a sensor manifest, resolves ELF shared-library dependencies, and writes the complete file tree to a directory on disk — useful for inspecting what would be included before committing to a full build.

| Flag | Default | Description |
|------|---------|-------------|
| `--manifest <path>` | — | Path to manifest JSON produced by the sensor (**required**) |
| `--source <ref>` | — | OCI image reference (**required**) |
| `--output <dir>` | — | Destination directory for the extracted file tree (**required**) |
| `--platform <os/arch>` | `linux/amd64` | Image platform |
| `--username` / `--password` | — | Registry credentials (both or neither) |
| `--insecure` | `false` | Skip TLS certificate verification |
| `--work-dir <dir>` | system temp | Temp directory for staging |

Exits 1 if any `DT_NEEDED` entries remain unresolved (they are listed on stderr).

## `sensor`

The eBPF profiling daemon. Linux only; requires root (`privileged` + `hostPID` when containerized). Usually deployed via the [Helm chart](/docs/guides/kubernetes/) rather than run by hand.

| Flag | Default | Description |
|------|---------|-------------|
| `--profile-dir <dir>` | `profiles` | Directory for manifest output (standalone mode) |
| `--controller-url <url>` | — | Tracepod controller URL for Kubernetes mode, e.g. `http://tracepod-controller.tracepod.svc:8080` |
| `--node-name <name>` | — | Node name (set via the Downward API in the DaemonSet) |
| `--trace-stat` | `false` | Additionally trace stat-family existence checks (`vfs_fstatat` kprobe; access mode `s`, schema v4). Higher event volume — watch the `event_loss` counters |
| `--ringbuf-bytes <n>` | `0` | Override the events ring-buffer size in bytes (0 = default 256 KB; power of two, page-multiple) |
| `--post-unowned-pods-namespace <ns>` | — | POST profiles for pods with no tracked workload owner in this one namespace (controller sandbox validation) |
| `--cgroup-path <path>` | — | Manually allow this cgroup path (debug) |
| `--verbose` | `false` | Print every file-open event to stderr (noisy; for debugging) |
| `--version` | — | Print version and exit |

## `tracepod`

CLI client for the Tracepod controller. It transparently port-forwards to the controller running in your cluster.

:::note
The controller is a separate server-side component, not included in the open-source repository. Without it, none of these commands apply — retrieve manifests directly from the sensor pod with `kubectl exec` instead.
:::

```
tracepod [--kubeconfig <path>] [--controller-namespace <ns>] <command>
```

**Global flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--kubeconfig <path>` | `$KUBECONFIG` or `~/.kube/config` | Path to kubeconfig |
| `--controller-namespace <ns>` | `tracepod` | Namespace where the controller is deployed |
| `--version` | — | Print version and exit |

**Commands:**

| Command | Description |
|---------|-------------|
| `profile list [--namespace <ns>]` | List active and completed profiling sessions |
| `profile get --namespace <ns> --deployment <name> [--output <file>]` | Download a merged manifest for a deployment |
| `profile stop --namespace <ns> --deployment <name>` | Stop profiling a deployment (freezes the manifest) |
| `cve-report <workload\|profile-id> [flags]` | Render the reachability/CVE report — see the [CVE reporting guide](/docs/guides/cve-reporting/) |
| `version` | Print version |
