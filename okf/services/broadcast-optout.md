---
type: Backend Service
title: Broadcast opt-out service
description: Stateless HMAC unsubscribe tokens for admin broadcast emails and the per-user `broadcastOptOut` flag they toggle.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/broadcast-optout.service.ts
tags: [proxmate, email, broadcast, hmac]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: optout
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/broadcast-optout.service.ts
    title: backend/src/services/broadcast-optout.service.ts
---

# Purpose

Community-Edition opt-out for admin broadcast (announcement) emails. Each broadcast carries a per-recipient link authenticated by a deterministic HMAC over the user id, so no token table is needed and the link stays valid for the life of the account.[^optout]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `unsubscribeToken` | `(userId) => string` | `<userId>.<hmac-hex>`; HMAC-SHA256 keyed by `ENCRYPTION_KEY` (hex-decoded) over `broadcast-unsub:` + userId. |
| `verifyUnsubscribeToken` | `(token) => string \| null` | Regex `^([a-z0-9]{10,40})\.([a-f0-9]{64})$`, then constant-time compare (`timingSafeEqual`); returns userId or null. |
| `setBroadcastOptOut` | `(userId, optOut) => Promise<string \| null>` | Updates `User.broadcastOptOut` if changed; returns the email, or null for unknown user. |

# Data

[User](/database/user.md) `broadcastOptOut`; env `ENCRYPTION_KEY` (throws if unset).[^optout]

# Gotchas

- Only broadcast emails honour the flag; transactional, security and event-notification emails are unaffected.[^optout]
- The `broadcast-unsub:` prefix domain-separates this HMAC from any other use of the key. Rotating `ENCRYPTION_KEY` invalidates every previously emailed link.[^optout]
- The EDU edition deliberately has no opt-out (instructors must reach every student).[^optout]

# Relationships

- Called by the [broadcast router](/api/broadcast.md) (public unsubscribe) and the [admin router](/api/admin.md) (sending broadcasts).

[^optout]: backend/src/services/broadcast-optout.service.ts
