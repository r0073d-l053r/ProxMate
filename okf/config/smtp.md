---
type: Configuration Group
title: SMTP (outgoing email) settings
description: SystemConfig keys configuring the nodemailer SMTP transport that ProxMate uses for invites, password resets, notifications, broadcasts and backup-download links.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/mail.service.ts
tags: [proxmate, config, smtp, email]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: mail
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/mail.service.ts
    title: backend/src/services/mail.service.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
  - id: download
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/download.service.ts
    title: backend/src/services/download.service.ts
---

# Purpose

SMTP settings for `nodemailer`. Mail counts as **configured** when `smtp_host` is non-empty (`isMailConfigured`); if it is empty, `getMailConfig()` returns `null`.[^mail] Several features depend on mail being configured. For example, tenant backup downloads need both `BACKUP_DOWNLOAD_DIR` and SMTP (`downloadsEnabled`).[^download] Admins write these keys through `PUT /api/admin/settings/smtp` and test them with `POST /api/admin/settings/smtp/test` ([admin API](/api/admin.md)).

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `smtp_host` | hostname (zod `min(1)`) | Unset or empty: mail is not configured | `saveMailConfig` ← `PUT /api/admin/settings/smtp` | `getMailConfig`, `isMailConfigured` | SMTP server host. |
| `smtp_port` | integer string 1–65535 | Reader fallback `587` (`Number(port) \|\| 587`) | same | `getMailConfig` | SMTP port. |
| `smtp_secure` | `"true"` / `"false"` | zod default `false`; a missing row reads as false | same | `getMailConfig` | Use implicit TLS. |
| `smtp_user` | string or `''` | `''`, treated as no auth user | same (always written, `?? ''`) | `getMailConfig` | SMTP auth username. |
| `smtp_pass` | string. **Secret, stored encrypted** (`sensitive=true`) | Unset: no password | same, but only when `pass` is non-blank (blank keeps the existing password) | `getMailConfig`. Admin settings expose only `smtp.hasPass` | SMTP auth password. |
| `smtp_from` | address string or `''` | Reader fallback: `smtp_user`, then `proxmate@<smtp_host>` | same (always written, `?? ''`) | `getMailConfig` | From address. |

# Validation

`SmtpSchema`: `host` min 1, `port` int positive max 65535, `secure` boolean default false, and optional `user`, `pass`, `from`.[^admin-routes]

# Gotchas

- An empty `pass` in the request keeps the existing password, so the API cannot clear a stored SMTP password.[^mail]
- The [notifications](/config/notifications.md) email channel reuses this transport.

[^mail]: backend/src/services/mail.service.ts (`getMailConfig`, `isMailConfigured`, `saveMailConfig`)
[^admin-routes]: backend/src/routes/admin.routes.ts (`SmtpSchema`, `PUT /settings/smtp`)
[^download]: backend/src/services/download.service.ts (`downloadsEnabled`)
