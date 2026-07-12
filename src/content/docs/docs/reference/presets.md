---
title: Runtime presets
description: Curated include-path sets for files common runtimes need but the profiler cannot observe.
---

The [`presets/`](https://github.com/tracepod/tracepod/tree/main/presets) directory in the repository holds curated include-path sets for files a runtime **needs but the profiler cannot observe**:

- work directories created at startup (nginx's cache tree, Apache's pid directory),
- paths the sensor denylist deliberately drops from profiles (`/tmp`, `/run`, `*.log`),
- interpreter files that are stat()ed but never opened.

These are curated known gaps, not kitchen-sink includes — the bar for every path is a runtime that fails or degrades without it, with the failure mode documented in the description.

## Format

Each preset is a JSON document:

```json
{
  "name": "runtime-nginx",
  "description": "why these paths are invisible to profiling",
  "paths": [
    { "path": "/var/log/nginx", "type": "directory" }
  ]
}
```

`type` is one of:

- `directory` — created empty in the hardened image, and expanded from the source image when present there
- `file` — created as an empty file when absent

## Using a preset with the CLI

The `harden` CLI does not read preset files directly — apply the paths with the corresponding flags:

- `type: directory` → `--include <path>` (expands files present in the source image) and/or `--mkdir <path>` (guarantees the directory exists even when empty)
- `type: file` → `--touch <path>`

For example, applying `runtime-nginx`:

```bash
harden build \
  --manifest manifest.json \
  --source nginx:1.25-alpine \
  --output /tmp/hardened-nginx \
  --mkdir /var/log/nginx \
  --mkdir /var/cache/nginx
```

## Available presets

| Preset | Paths | Why |
|--------|-------|-----|
| `runtime-nginx` | `/var/log/nginx`, `/var/cache/nginx` (dirs) | nginx creates its log and cache trees at startup and aborts when the parent directories are missing; both are runtime-written and never profiled |
| `runtime-python3.11` | `/usr/local/lib/python3.11/encodings`, `.../lib-dynload` (dirs) | CPython startup essentials the profiler cannot observe (encodings package, lib-dynload C extensions) |
| `runtime-python3.12` | `/usr/local/lib/python3.12/encodings`, `.../lib-dynload` (dirs) | Same as above, for 3.12 |
| `runtime-python3.13` | `/usr/local/lib/python3.13/encodings`, `.../lib-dynload` (dirs) | Same as above, for 3.13 |
| `runtime-node` | `/tmp` (dir) | Node's `os.tmpdir()` must exist for temp files and native-addon extraction; `/tmp` observations are denylisted |
| `runtime-java` | `/tmp` (dir) | The JVM requires `java.io.tmpdir` to exist for hsperfdata and temporary files |
| `runtime-ruby` | `/tmp` (dir) | Ruby's `Tempfile`/`Dir.tmpdir` must exist |
| `runtime-php-apache` | `/var/run/apache2`, `/var/log/apache2`, `/var/lock`, `/tmp` (dirs) | `php:*-apache` images need Apache's runtime directories (pid, logs) plus `/tmp` for PHP sessions and uploads |
| `runtime-postgres` | `/var/run/postgresql`, `/tmp` (dirs) | PostgreSQL needs its Unix-socket directory; `/run` observations are denylisted. `/tmp` for sort spill files |
| `runtime-redis` | `/data` (dir) | Redis persists RDB/AOF into its working directory (`/data` in the official image); writes are runtime-only so the directory is absent from profiles |

## Why these paths are invisible

Each preset maps to one of the sensor gaps documented in [Known limitations](/docs/concepts/known-limitations/):

- **Runtime-created directories** never exist as files in the image, so `--include` alone cannot add them — hence `--mkdir`.
- **Denylisted paths** (`/tmp`, `/run`, logs) are dropped from profiles by design to keep manifests clean, so even observed accesses never appear.
- **Stat-only files** (Python's `encodings`) are probed for existence without an `openat`, which the sensor cannot see.

Contributions of new presets are welcome — see the [presets README](https://github.com/tracepod/tracepod/blob/main/presets/README.md) for the acceptance bar.
