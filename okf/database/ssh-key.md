---
type: Prisma Model
title: SshKey
description: A reusable SSH public key saved on a user's profile so cloud-init deploys can pick it from a list.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, ssh, cloud-init]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ssh-key.service.ts
    title: backend/src/services/ssh-key.service.ts
---

# Purpose

Saved OpenSSH public keys for the deploy wizard. See [ssh-key router](/api/ssh-key.md).[^schema]

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| userId | String | FK, `@@index` | Owning [User](/database/user.md). |
| name | String | | Label, e.g. "laptop" (trimmed). |
| publicKey | String | | One OpenSSH public key line (trimmed). |
| createdAt | DateTime | `@default(now())` | |
| lastUsedAt | DateTime? | | Declared, but no service code writes it. |

[^schema] [^svc]

# Relationships

- Belongs to [User](/database/user.md), `onDelete: Cascade`.[^schema]

# Invariants

- At most 25 keys per user (`MAX_KEYS_PER_USER`); exact duplicates for the same user are rejected.[^svc]
- `isValidPublicKey` accepts `ssh-rsa`, `ssh-ed25519`, `ssh-dss`, `ecdsa-sha2-*` and `sk-*@openssh.com` types and rejects any CR/LF, which blocks smuggling a second `authorized_keys` entry into cloud-init.[^svc]
- Deletion succeeds only for the owner; otherwise it returns false so the route can 404.[^svc]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/ssh-key.service.ts
