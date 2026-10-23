---
type: Backend Service
title: Guest-file service (push a file, read the IDE install log)
description: Pushes a small file into a running QEMU guest through the guest agent (strict path checks, base64 parts, fixed assemble script) and reads the cleaned tail of the ProxMate IDE install log.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/guest-file.service.ts
tags: [proxmate, guest-agent, qemu, files, ide]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T06:45:00Z }
sources:
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/guest-file.service.ts
    title: backend/src/services/guest-file.service.ts
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
---

# Purpose

Two guest-agent tools for QEMU guests. Everything reaches the guest through `agent/file-write` (content only) or `agent/exec` with a fixed argv; request values are only ever argv entries, never part of a script's text.[^svc]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `validateGuestPath` | `(input) => { ok, path } \| { ok: false, error }` | Absolute, already normalized (no empty, `.` or `..` segments, no trailing `/`), no control characters (NUL included), at most 1024 bytes and 230 bytes per segment, not `/proc`, `/sys` or `/dev` or below. The path is used exactly as given. |
| `parseFileMode` | `(input) => '0644' \| null` | `644` or `0644`; empty means `0644`. Setuid, setgid and sticky bits are refused. |
| `guestFilePushMaxBytes` | `(env?) => number` | `GUEST_FILE_PUSH_MAX_BYTES`, default 1 MiB, clamped to 8 MiB. |
| `pushGuestFile` | `(vm, { path, content, mode, owner?, createParents? })` | Re-validates input, `requireOurGuest`, pings the agent, optional `mkdir -p -- <parent>`, `mktemp -d /tmp/pmpush.XXXXXXXX`, one `file-write` per 48 KiB base64 part (`p.00000`, `p.00001`, ...), then `sh -c ASSEMBLE_SCRIPT sh <staging> <dest> <mode> <owner>`. Returns `{ path, size, sha256, verified }`. |
| `readIdeInstallLog` | `(vm) => { path, log, truncated, missing }` | `requireOurGuest`, agent ping, `tail -c 65536 /var/log/pmide-provision.log`, then `shapeIdeLog`. A missing file is `missing: true`, not an error. |
| `stripControlChars` | `(text) => string` | Drops ANSI CSI/OSC/nF/two-character escapes and 8-bit CSI, resolves `\r` progress lines to their last state, removes other C0/C1 controls (keeps `\n`, `\t`) and the bidirectional overrides. |
| `shapeIdeLog` | `(raw) => { log, truncated }` | Cleans, drops the partial first line of a full 64 KiB tail, keeps the last 500 lines. |

# Gotchas

- `ASSEMBLE_SCRIPT` decodes each part into a sibling `<dest>.pmpush.<pid>` created under umask 077, applies `chmod` and (optionally) `chown <owner>:<owner's group>`, then `mv -f` over the destination, so the file never appears half-written or briefly with looser permissions. It removes the staging directory on exit and prints `sha256sum` of the result, which must match the backend's hash. Exit codes: 3 owner does not exist, 4 destination is a directory, 5 parent folder missing, 6 a write step failed.[^svc]
- Parts are base64 text written with the agent's default `encode=1`, the same transport the IDE bootstrap uses; Proxmox caps one `file-write` `content` at 60 KiB, hence 48 KiB parts. An empty file has no parts.[^svc][^pve]
- The staging directory must match `/tmp/pmpush.<8 alphanumerics>` before any part is written; a failed part write runs `rm -rf -- <staging>` best-effort.[^svc]
- `guestExecOutput` gained a `trim` argument (default true); the log read passes `false` so the tail's length is measured as received.[^pve]
- Containers are refused (409): the tools need the QEMU guest agent.[^svc]

# Relationships

- Called by the [VM router](/api/vm.md) (`POST /api/vms/:id/files`) and the [IDE router](/api/ide.md) (`GET /api/ide/:id/install-log`).
- Uses the [proxmox service](/services/proxmox.md) agent calls and `requireOurGuest` from the [vm service](/services/vm.md). The log it reads is written by [ide-provision](/services/ide-provision.md).
- Proxmox privileges: [privileges](/proxmox/privileges.md).

[^svc]: backend/src/services/guest-file.service.ts
[^pve]: backend/src/services/proxmox.service.ts
