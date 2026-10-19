---
type: Configuration Group
title: Event notification settings
description: SystemConfig keys configuring admin event notifications, covering the outgoing webhook, the email channel and its recipient, the enabled event list and the event-list schema version.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/notify.service.ts
tags: [proxmate, config, notifications, webhook, email]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: notify
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/notify.service.ts
    title: backend/src/services/notify.service.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
---

# Purpose

A single fan-out of admin events to two optional channels: a webhook (Discord, Slack, Mattermost or generic JSON) and email (reusing [SMTP](/config/smtp.md)). Sends are best-effort. A failing channel is logged and never breaks the operation that triggered the notification.[^notify] The event ids are `backup.failed`, `vm.error`, `auth.lockout`, `access.expired` and `deploy.agent_missing` (`NOTIFY_EVENTS`).

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `notify_webhook_url` | URL or `''` (zod `max(2000)`). **Encrypted when non-empty**: `setConfig(..., url.length > 0)`; an empty value is stored as a plain marker | `''`: webhook disabled | `saveNotifyConfig` ← `PUT /api/admin/settings/notifications` (blank keeps the stored URL; `clearWebhookUrl: true` removes it) | `getNotifyConfig`, `postWebhook` | Outgoing webhook URL. It is treated as a secret because anyone holding it can post; the settings response reports only `hasWebhookUrl` and a masked `scheme://host/…`. |
| `notify_email_enabled` | `"true"` / `"false"` | zod default false; a missing row reads as false | same | `getNotifyConfig` | Email channel on/off. |
| `notify_email_to` | address or `''` (zod `max(200)`), trimmed | `''`: all admins | same | `getNotifyConfig` | Email recipient. |
| `notify_events` | CSV of event ids, filtered to `NOTIFY_EVENTS` | **Unset (row missing): all events enabled.** An empty string means none, apart from the version rule in the next row | same | `getNotifyConfig` → `parseEvents` | Which events fire. |
| `notify_events_version` | string; the current `EVENTS_VERSION` is `'3'` | Unset or different: the events in `EVENTS_ADDED_LATER` (`access.expired`, `deploy.agent_missing`) are force-enabled on top of the CSV | same (always written as the current version on save) | `parseEvents` | Marks that the CSV was saved by a UI that knew every current event, so an explicit opt-out of later-added events is respected. |

# Validation

`NotifySchema`: `webhookUrl` string max 2000 optional (blank = keep), `clearWebhookUrl` boolean default false, `emailEnabled` boolean default false, `emailTo` max 200 optional, `events` array of `z.enum(NOTIFY_EVENTS)` default `[]`.[^admin-routes]

A non-empty webhook URL must also pass `assertPublicHttpUrlShape` at save time, which rejects private, loopback and metadata hosts. At send time `assertSafeOutboundUrl` re-checks the URL, including DNS. Setting `ALLOW_PRIVATE_OUTBOUND_URLS=true` relaxes the private-host check (see [backend environment](/env/backend-environment.md)).[^notify]

# Gotchas

- `POST /api/admin/settings/notifications/test` returns HTTP 200 with a per-channel result body even when a channel fails. It returns 400 only for a config error such as no channel enabled.[^admin-routes]
- When adding a new event, append it to `EVENTS_ADDED_LATER` and bump `EVENTS_VERSION`. Otherwise installs with a saved CSV silently leave the new event off.[^notify]

[^notify]: backend/src/services/notify.service.ts (`NOTIFY_EVENTS`, `EVENTS_ADDED_LATER`, `EVENTS_VERSION`, `parseEvents`, `saveNotifyConfig`, `postWebhook`)
[^admin-routes]: backend/src/routes/admin.routes.ts (`NotifySchema`, `PUT /settings/notifications`, `POST /settings/notifications/test`)
