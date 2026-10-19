---
type: Prisma Model
title: IdeGatewayToken
description: Per-user per-VM token (pmide_ prefix) that authenticates the in-guest IDE AI agent to the ProxMate LLM gateway.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, ide, llm-gateway]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: gw
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-gateway.service.ts
    title: backend/src/services/ide-gateway.service.ts
  - id: provision
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-provision.service.ts
    title: backend/src/services/ide-provision.service.ts
  - id: ide-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/ide.routes.ts
    title: backend/src/routes/ide.routes.ts
---

# Purpose

OpenCode runs inside the tenant's VM with no ProxMate session cookie. It instead bears this token against `/api/ide/:vmId/llm/v1`; the gateway resolves the token to (user, vm), re-checks access live, and forwards to the upstream model.[^gw] See [IDE gateway service](/services/ide-gateway.md) and [IDE config](/config/ide.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| userId | String | FK | Owning [User](/database/user.md). |
| vmId | String | `@@index` | ProxMate [VirtualMachine](/database/virtual-machine.md) id (scalar, no FK). |
| tokenHash | String | `@unique` | Hex SHA-256 of the raw token. |
| prefix | String | | First 12 chars (`pmide_` + 6). |
| lastUsedAt | DateTime? | | Best-effort stamp on each verify. |
| expiresAt | DateTime? | | null = valid until revoked or rotated. |
| revokedAt | DateTime? | | Set by revoke. |
| createdAt | DateTime | `@default(now())` | |
| | | `@@unique([userId, vmId])` | One token per (user, VM). |

[^schema] [^gw]

# Relationships

- Belongs to [User](/database/user.md), `onDelete: Cascade`. `vmId` is a plain column with no relation to [VirtualMachine](/database/virtual-machine.md).[^schema]

# Invariants

- Minting (`issueGatewayToken`, called from IDE provisioning and an IDE route) upserts on `(userId, vmId)` and resets `revokedAt`, `expiresAt`, `lastUsedAt` to null, so re-provisioning rotates the secret.[^gw] [^provision] [^ide-routes]
- Only the VM's owner is issued a token. Verification rejects a token whose `vmId` differs from the path VM, revoked or expired tokens, holders with lapsed access, holders who are not the VM's owner, and callers who no longer hold the `ide` capability on the VM or the admin IDE policy.[^gw]

# Gotchas

- There is no FK to the VM, so `destroyVm` and template conversion delete the VM's token rows in the same transaction as the VM row; verification also re-loads the VM live.[^gw]
- `revokeGatewayToken` exists but no route or service outside its own module calls it.[^gw]

[^schema]: backend/prisma/schema.prisma
[^gw]: backend/src/services/ide-gateway.service.ts
[^provision]: backend/src/services/ide-provision.service.ts
[^ide-routes]: backend/src/routes/ide.routes.ts
