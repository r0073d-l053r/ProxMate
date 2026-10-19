---
type: Backend Service
title: SSH-key service
description: Validates single-line OpenSSH public keys and manages a user's saved keys (max 25, de-duplicated) for injection into guest cloud-init.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ssh-key.service.ts
tags: [proxmate, ssh, cloud-init, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: ssh
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ssh-key.service.ts
    title: backend/src/services/ssh-key.service.ts
---

# Purpose

Saved SSH keys a tenant can pick when deploying a VM.[^ssh]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `isValidPublicKey` | `(key) => boolean` | Shape check: `ssh-rsa/ed25519/dss`, `ecdsa-sha2-*`, `sk-*@openssh.com`, then base64 blob, optional comment; rejects CR/LF. |
| `listSshKeys` | `(userId)` | Newest first. |
| `addSshKey` | `(userId, name, publicKey)` | Trims; throws `TooManyKeysError` at `MAX_KEYS_PER_USER` (25) and `DuplicateKeyError` on exact match. |
| `deleteSshKey` | `(userId, id) => boolean` | False if missing or not the user's (route 404s without leaking). |

# Data

[SshKey](/database/ssh-key.md) (`userId`, `name`, `publicKey`).[^ssh]

# Gotchas

- Separators are space/tab only (not `\s`) and any newline is rejected, so a multi-line paste cannot smuggle a second `authorized_keys` entry into cloud-init.[^ssh]
- Not a cryptographic validation; it mirrors the frontend wizard check.[^ssh]

# Relationships

- Called by the [ssh-key router](/api/ssh-key.md) and [vm router](/api/vm.md); used by [vm service](/services/vm.md). See [cloud-init config](/config/cloud-init.md).

[^ssh]: backend/src/services/ssh-key.service.ts
