---
type: Backend Service
title: Invite service (token and expiry helpers)
description: Two pure helpers used by the invite router to generate a random invite token and parse a `7d`/`24h`/`60m` style expiry.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/invite.service.ts
tags: [proxmate, invites, onboarding]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: invite
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/invite.service.ts
    title: backend/src/services/invite.service.ts
---

# Purpose

Utility module for invite links; persistence and policy (access duration, require-2FA, quotas) live in the [invite router](/api/invite.md).[^invite]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `generateToken` | `() => string` | 32 random bytes, base64url. |
| `parseExpiry` | `(expiry: string) => Date` | Accepts `^(\d+)([dhm])$`; returns now + amount; throws `Invalid expiresIn format` otherwise. |

# Data

No direct DB access. The router stores tokens in [InviteToken](/database/invite-token.md).[^invite]

# Gotchas

- `parseExpiry` does not cap the amount; any bound must be enforced by the caller.[^invite]

# Relationships

- Called only by the [invite router](/api/invite.md). Invite access windows use [access service](/services/access.md).

[^invite]: backend/src/services/invite.service.ts
