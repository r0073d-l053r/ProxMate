---
type: Configuration Group
title: Weekly usage digest setting
description: SystemConfig key with the admin on/off switch for the weekly per-tenant usage digest email, which each user also opts in to.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/usage-digest.service.ts
tags: [proxmate, config, email, scheduler, usage]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T12:00:00Z }
sources:
  - id: digest
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/usage-digest.service.ts
    title: backend/src/services/usage-digest.service.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
---

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `usage_digest_enabled` | `"true"` / `"false"` | **On**: only exactly `'false'` turns it off | `PUT /api/admin/settings/usage-digest` (`{ enabled: boolean }`) | `isUsageDigestEnabled` (weekly tick, `GET /api/admin/settings` → `usageDigestEnabled`, `GET /api/auth/me` → `usageDigestAvailable`) | Admin switch for the whole digest. Who gets one is decided per user by `User.usageDigestOptIn`, which is off by default.[^digest][^admin-routes] |

# Gotchas

- Default on is deliberate: nobody receives anything until they opt in on their Security page, so the switch exists to let an admin stop the digest for everyone.[^digest]
- Schedule: `USAGE_DIGEST_CRON`, default `0 8 * * 1` (Mondays 08:00 in the backend's local time — UTC in the Docker image). An invalid value logs a warning and falls back to the default. There is no catch-up: a run missed while the backend was down is skipped.[^digest]
- Users whose access window has ended (expired or suspended) are skipped even if opted in; `PUT /api/auth/email-preferences` stays open to them (`allowExpiredAccess`) so they can still opt out.[^digest]
- Needs SMTP. With SMTP off the tick logs `skipped: SMTP is not configured` and sends nothing.[^digest]
- The digest covers 7 days of `ResourceSample` rows, so `RESOURCE_HISTORY_DAYS` below 7 shortens what it can show.
- `POST /api/admin/settings/usage-digest/preview` emails the calling admin their own digest, for checking the format and SMTP delivery.[^admin-routes]
- Toggling is audited as `admin.usage_digest_config` (`weekly digest enabled` / `disabled`).[^admin-routes]

# Relationships

- [Usage-digest service](/services/usage-digest.md), [admin API](/api/admin.md), [User](/database/user.md), [ResourceSample](/database/resource-sample.md), [backend environment](/env/backend-environment.md)

[^digest]: backend/src/services/usage-digest.service.ts (`isUsageDigestEnabled`, `runUsageDigest`, `DEFAULT_USAGE_DIGEST_CRON`)
[^admin-routes]: backend/src/routes/admin.routes.ts (`PUT /settings/usage-digest`, `POST /settings/usage-digest/preview`)
