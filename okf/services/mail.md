---
type: Backend Service
title: Mail service (SMTP)
description: Reads and saves SMTP settings from SystemConfig (password encrypted) and sends mail through a fresh nodemailer transport per message.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/mail.service.ts
tags: [proxmate, email, smtp]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: mail
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/mail.service.ts
    title: backend/src/services/mail.service.ts
---

# Purpose

Single outbound-email path for invites, password resets, alerts, backup-download links, lockout and access-expiry warnings, and notifications.[^mail]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `getMailConfig` | `() => Promise<MailConfig \| null>` | Null when `smtp_host` unset; `port` default 587; `secure` = `'true'`; `from` falls back to `smtp_user`, then `proxmate@<host>`. |
| `isMailConfigured` | `() => Promise<boolean>` | `smtp_host` present. |
| `saveMailConfig` | `({ host, port, secure, user?, pass?, from? })` | Writes keys; `smtp_pass` only when non-blank, encrypted (`sensitive`). |
| `sendMail` | `({ to, subject, text, html? })` | Throws `SMTP is not configured` when off; otherwise sends. |
| `verifyMailConfig` | `() => { ok: true }` | `transport.verify()` for the admin "Test" button. |

# Data

SystemConfig keys `smtp_host`, `smtp_port`, `smtp_secure`, `smtp_user`, `smtp_pass` (sensitive), `smtp_from` — see [smtp config](/config/smtp.md).[^mail]

# Gotchas

- Saving with an empty password keeps the existing one (there is no way to clear `smtp_pass` through `saveMailConfig`).[^mail]
- `sendMail` throws; callers that must stay best-effort wrap it in `.catch` (see [notify](/services/notify.md), [alert](/services/alert.md)).[^mail]
- SMTP auth is used only when `smtp_user` is set.[^mail]

# Relationships

- Called by the [admin router](/api/admin.md) and [invite router](/api/invite.md).
- Used by [download](/services/download.md), [alert](/services/alert.md), [access-sweep](/services/access-sweep.md), [account-lockout](/services/account-lockout.md), [vm](/services/vm.md), [notify](/services/notify.md), [password-reset](/services/password-reset.md).

[^mail]: backend/src/services/mail.service.ts
