---
type: API Router
title: SSH key router
description: Manages the caller's saved OpenSSH public keys (account keychain), mounted at /api/ssh-keys.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/ssh-key.routes.ts
tags: [proxmate, api, ssh, keys]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/ssh-key.routes.ts
    title: backend/src/routes/ssh-key.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
---

# Purpose

CRUD for a user's saved SSH public keys. Mounted at `/api/ssh-keys`.[^app] (Injecting a key into a running guest is a different endpoint, `POST /api/vms/:id/ssh-keys`, in the [VM router](/api/vm.md).)

# Authentication

- `router.use(requireAuth)` only; no MFA-setup gate.[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/ssh-keys` | user | List the caller's keys. |
| POST | `/api/ssh-keys` | user | Body `{ name, publicKey }`; 201 with the created key. |
| DELETE | `/api/ssh-keys/:id` | user | Delete one of the caller's keys; 404 if not found. |

# Gotchas

- zod `CreateSchema = { name: 1..60, publicKey: 1..16384 chars }`, then `isValidPublicKey()`; failure is 400 `That doesn't look like an OpenSSH public key.`[^routes]
- `DuplicateKeyError` and `TooManyKeysError` both map to 409; other errors are rethrown to the global error handler (500).[^routes]
- Adding and deleting a key are audited (`ssh_key.add`, `ssh_key.delete`).

# Relationships

- Persists [SshKey](/database/ssh-key.md) for a [User](/database/user.md) via the [ssh-key service](/services/ssh-key.md).
- Overall surface: [HTTP API](/api/http-api.md).

[^routes]: backend/src/routes/ssh-key.routes.ts
[^app]: backend/src/app.ts
