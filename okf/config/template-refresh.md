---
type: Configuration Group
title: Template auto-refresh setting
description: SystemConfig key toggling the monthly job that rebuilds every refreshable cloud-image template so new deploys start from a patched base.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
tags: [proxmate, config, templates, scheduler]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
---

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `template_refresh_enabled` | `"true"` / `"false"` | **Off**: the tick runs only when the value is exactly `'true'` | `PUT /api/admin/settings/template-refresh` (`{ enabled: boolean }`, zod `z.object({ enabled: z.boolean() })`) | Scheduler template tick; `GET /api/admin/settings` (`templateRefreshEnabled`) | When on, `refreshAllTemplates()` rebuilds every refreshable template on schedule.[^scheduler][^admin-routes] |

# Gotchas

- Schedule: `TEMPLATE_REFRESH_CRON`, default `0 4 1 * *` (the 1st of the month at 04:00). The cron task is always registered and checks the flag on every tick, so toggling takes effect without a restart.[^scheduler]
- The route writes no audit entry.[^admin-routes]

# Relationships

- [Templates service](/services/template.md), [admin API](/api/admin.md), [backend environment](/env/backend-environment.md)

[^scheduler]: backend/src/services/scheduler.service.ts (`DEFAULT_TEMPLATE_SCHEDULE`, template tick)
[^admin-routes]: backend/src/routes/admin.routes.ts (`PUT /settings/template-refresh`)
