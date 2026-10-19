---
type: Backend Service
title: Notify service (admin event notifications)
description: Best-effort fan-out of admin event notifications to an SSRF-guarded outgoing webhook and/or email, with per-event toggles.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/notify.service.ts
tags: [proxmate, notifications, webhook, email]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: notify
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/notify.service.ts
    title: backend/src/services/notify.service.ts
---

# Purpose

One admin-configured fan-out to two optional channels: a webhook (Discord / Slack / Mattermost / generic JSON) and email (to a chosen address or every admin). A failing channel is logged and never propagates into the operation that triggered it.[^notify]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `NOTIFY_EVENTS` | `backup.failed, vm.error, auth.lockout, access.expired, deploy.agent_missing` | Event types; labels in `NOTIFY_EVENT_LABEL`. |
| `getNotifyConfig` | `() => { webhookUrl, emailEnabled, emailTo, events }` | Reads config; missing `notify_events` = all on. |
| `saveNotifyConfig` | `({ webhookUrl?, clearWebhookUrl?, emailEnabled, emailTo?, events })` | A non-blank webhook URL is stored encrypted; blank keeps the stored one; `clearWebhookUrl` removes it. Writes `notify_events_version`. |
| `maskWebhookUrl` | `(url) => string` | Display form `scheme://host/…` (`''` when unset) used by `GET /api/admin/settings`. |
| `notify` | `(payload: { event, title, message })` | Both enabled channels in parallel, errors swallowed. |
| `notifyWebhook` | `(payload)` | Webhook only (used where email is handled elsewhere, e.g. lockouts, alerts). |
| `sendTestNotification` | `() => { ok, results[] }` | Admin "Send test": each channel tried independently, per-channel errors reported; throws if no channel is enabled. |

# Data

SystemConfig keys `notify_webhook_url` (sensitive when set), `notify_email_enabled`, `notify_email_to`, `notify_events` (CSV), `notify_events_version` — see [notifications config](/config/notifications.md). Reads admin emails from [User](/database/user.md).[^notify]

# Gotchas

- Events added after the settings UI shipped (`access.expired`, `deploy.agent_missing`) are force-enabled unless `notify_events_version` equals the current `EVENTS_VERSION` ('3'); otherwise an old saved CSV would leave them silently off forever.[^notify]
- The webhook goes through `assertSafeOutboundUrl` (no loopback/LAN/metadata), uses `redirect: 'error'` and a 10 s timeout. Connection failures surface the cause code (ENOTFOUND, ECONNREFUSED, TimeoutError).[^notify]
- Webhook body carries both `content` (Discord) and `text` (Slack/Mattermost) plus `title`, `message`, `event`.[^notify]
- Email is silently skipped when SMTP is not configured.[^notify]

# Relationships

- Called by the [admin router](/api/admin.md) (settings and test).
- Used by [alert](/services/alert.md), [access-sweep](/services/access-sweep.md), [account-lockout](/services/account-lockout.md), [vm](/services/vm.md), [deploy-lock](/services/deploy-lock.md), [passthrough-request](/services/passthrough-request.md), [matestate](/services/matestate.md).
- Uses [mail](/services/mail.md) and [config](/services/config.md).

[^notify]: backend/src/services/notify.service.ts
