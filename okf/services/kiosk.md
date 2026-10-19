---
type: Backend Service
title: Kiosk service (exit PIN)
description: Stores and verifies the bcrypt-hashed 4-12 digit PIN required to leave the unattended full-screen kiosk admin panel.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/kiosk.service.ts
tags: [proxmate, kiosk, auth, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: kiosk
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/kiosk.service.ts
    title: backend/src/services/kiosk.service.ts
---

# Purpose

Kiosk mode is a full-screen admin panel on a physical display (e.g. a rack Pi). Leaving it requires re-auth by passkey (normal passkey routes) or this PIN, so a passer-by cannot tap out into the full admin console.[^kiosk]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `isValidKioskPin` | `(pin) => boolean` | `^[0-9]{4,12}$`. |
| `isKioskPinSet` | `() => Promise<boolean>` | Whether a PIN exists (never exposes it). |
| `setKioskPin` | `(pin)` | `''` clears (stored as plain empty string); otherwise bcrypt hash stored with `sensitive = true`. Caller validates format. |
| `verifyKioskPin` | `(pin) => Promise<boolean>` | False when no PIN is set; else bcrypt compare. |

# Data

SystemConfig key `kiosk_exit_pin` in [SystemConfig](/database/system-config.md) (bcrypt hash, additionally encrypted as sensitive).[^kiosk]

# Gotchas

- An unset PIN must never verify; the unlock path is also gated by `isKioskPinSet` upstream.[^kiosk]
- The PIN is never returned by any API.[^kiosk]

# Relationships

- Called by the [auth router](/api/auth.md) (unlock) and [admin router](/api/admin.md) (settings).
- Uses [auth service](/services/auth.md) `hashPassword`/`verifyPassword` and [config](/services/config.md). Kiosk session rotation grace is in [auth service](/services/auth.md).

[^kiosk]: backend/src/services/kiosk.service.ts
