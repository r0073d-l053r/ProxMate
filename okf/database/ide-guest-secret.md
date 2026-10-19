---
type: Prisma Model
title: IdeGuestSecret
description: Per-VM encrypted credential that the IDE reverse proxy uses to prove a guest's code-server is that VM's own install and to authenticate every proxied request.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, ide, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: guest
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-guest-auth.service.ts
    title: backend/src/services/ide-guest-auth.service.ts
  - id: provision
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-provision.service.ts
    title: backend/src/services/ide-provision.service.ts
---

# Purpose

Holds the random secret generated for a VM's IDE install. The guest receives only its SHA-256 (code-server's `HASHED_PASSWORD`); the backend keeps the secret to prove the guest before proxying and to authenticate proxied requests. See [IDE guest-auth service](/services/ide-guest-auth.md).[^guest]

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| vmId | String | `@id` | ProxMate [VirtualMachine](/database/virtual-machine.md) id (scalar, no FK). |
| secretEnc | String | | The secret, AES-256-GCM encrypted under `ENCRYPTION_KEY` (`lib/crypto.ts`). |
| createdAt | DateTime | `@default(now())` | |
| updatedAt | DateTime | `@updatedAt` | Last rotation. |

[^schema]

# Invariants

- Written (upserted) by every IDE (re)provision, together with the `installing` lock, so each install has a fresh secret.[^provision]
- No row, or a row that fails to decrypt, means the proxy refuses the VM's IDE (fail closed) and `GET /api/ide/:id/status` reports `reinstallRequired` for a `ready` install.[^guest]

# Gotchas

- There is no FK (like [IdeGatewayToken](/database/ide-gateway-token.md)), so `destroyVm` and template conversion delete the VM's row in the same transaction as the VM row.[^schema]

[^schema]: backend/prisma/schema.prisma
[^guest]: backend/src/services/ide-guest-auth.service.ts
[^provision]: backend/src/services/ide-provision.service.ts
