---
type: Configuration Group
title: Event notification settings
description: SystemConfig keys configuring admin event notifications, covering the outgoing webhook, the ntfy and Telegram channels, the email channel and its recipient, the enabled event list and the event-list schema version.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/notify.service.ts
tags: [proxmate, config, notifications, webhook, ntfy, telegram, email]
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

A single fan-out of admin events to optional channels: a webhook (Discord, Slack, Mattermost or generic JSON), an ntfy topic, a Telegram chat and email (reusing [SMTP](/config/smtp.md)). Sends are best-effort. A failing channel is logged and never breaks the operation that triggered the notification.[^notify] The event ids are `backup.failed`, `vm.error`, `auth.lockout`, `access.expired` and `deploy.agent_missing` (`NOTIFY_EVENTS`).

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `notify_webhook_url` | URL or `''` (zod `max(2000)`). **Encrypted when non-empty**: `setConfig(..., url.length > 0)`; an empty value is stored as a plain marker | `''`: webhook disabled | `saveNotifyConfig` ← `PUT /api/admin/settings/notifications` (blank keeps the stored URL; `clearWebhookUrl: true` removes it) | `getNotifyConfig`, `postWebhook` | Outgoing webhook URL. It is treated as a secret because anyone holding it can post; the settings response reports only `hasWebhookUrl` and a masked `scheme://host/…`. |
| `notify_ntfy_url` | topic URL or `''` (zod `max(2000)`). **Encrypted when non-empty** (on a public server the topic name is its credential) | `''`: ntfy disabled | `saveNotifyConfig` (blank keeps; `clearNtfy: true` removes it and the token) | `getNotifyConfig`, `postNtfy` | ntfy.sh or a self-hosted server, ending in the topic. Reported as `hasNtfyUrl` + masked `ntfyUrlMasked`. |
| `notify_ntfy_token` | access token or `''` (max 200, no spaces). **Encrypted when non-empty** | `''`: publish without auth | same (blank keeps; `clearNtfyToken` removes) | `postNtfy` (`Authorization: Bearer`) | Optional token for a protected topic. Reported only as `hasNtfyToken`. |
| `notify_telegram_bot_token` | `<bot id>:<secret>` (`TELEGRAM_TOKEN_RE`) or `''`. **Encrypted when non-empty** | `''`: Telegram disabled | same (blank keeps; `clearTelegram` removes it and the chat id) | `postTelegram` | Bot token from @BotFather. Reported as `hasTelegramBotToken` + `telegramBotTokenMasked` (`<bot id>:…`). |
| `notify_telegram_chat_id` | numeric id (groups/channels negative) or `@channelname` (`TELEGRAM_CHAT_RE`) | `''` | same (omitted keeps) | `postTelegram` | Where the bot sends. Not a secret; returned as `telegramChatId`. |
| `notify_email_enabled` | `"true"` / `"false"` | zod default false; a missing row reads as false | same | `getNotifyConfig` | Email channel on/off. |
| `notify_email_to` | address or `''` (zod `max(200)`), trimmed | `''`: all admins | same | `getNotifyConfig` | Email recipient. |
| `notify_events` | CSV of event ids, filtered to `NOTIFY_EVENTS` | **Unset (row missing): all events enabled.** An empty string means none, apart from the version rule in the next row | same | `getNotifyConfig` → `parseEvents` | Which events fire. |
| `notify_events_version` | string; the current `EVENTS_VERSION` is `'3'` | Unset or different: the events in `EVENTS_ADDED_LATER` (`access.expired`, `deploy.agent_missing`) are force-enabled on top of the CSV | same (always written as the current version on save) | `parseEvents` | Marks that the CSV was saved by a UI that knew every current event, so an explicit opt-out of later-added events is respected. |

# Validation

`NotifySchema`: `webhookUrl` string max 2000 optional (blank = keep), `clearWebhookUrl` boolean default false, `emailEnabled` boolean default false, `emailTo` max 200 optional, `events` array of `z.enum(NOTIFY_EVENTS)` default `[]`.[^admin-routes]

A non-empty webhook URL must also pass `assertPublicHttpUrlShape` at save time, which rejects private, loopback and metadata hosts. At send time `assertSafeOutboundUrl` re-checks the URL, including DNS. Setting `ALLOW_PRIVATE_OUTBOUND_URLS=true` relaxes the private-host check (see [backend environment](/env/backend-environment.md)).[^notify]

ntfy fields: `ntfyUrl` max 2000 optional, `ntfyToken` max 200 without spaces, `clearNtfy`, `clearNtfyToken`. A non-empty ntfy URL passes the same `assertPublicHttpUrlShape` check and must end in a topic (`parseNtfyTopicUrl`; no query string). Telegram fields: `telegramBotToken` must match `TELEGRAM_TOKEN_RE`, `telegramChatId` `TELEGRAM_CHAT_RE`, and Telegram can't be left with a bot but no chat: an empty chat id (or a new bot token with none stored) is refused with 400 unless `clearTelegram` is set.[^admin-routes]

# Gotchas

- `POST /api/admin/settings/notifications/test` returns HTTP 200 with a per-channel result body even when a channel fails. It returns 400 only for a config error such as no channel enabled.[^admin-routes]
- ntfy is published in ntfy's JSON format: a POST to the server root (everything before the topic, so a sub-path install works) with `topic`, `title`, `message`, `priority` (4 for backup/VM/lockout events, 3 otherwise) and `tags`. JSON keeps non-ASCII text such as the em dash intact, which header-based publishing would not.[^notify]
- Telegram always goes to `https://api.telegram.org/bot<token>/sendMessage` as plain text (no `parse_mode`, so names and errors need no escaping). The fixed host means no URL check is needed; errors carry the Bot API's `description` but never the URL, which holds the token.[^notify]
- The push channels (webhook, ntfy, Telegram) all use `redirect: 'error'` and a 10 s timeout, and all receive `notifyWebhook` dispatches.[^notify]
- When adding a new event, append it to `EVENTS_ADDED_LATER` and bump `EVENTS_VERSION`. Otherwise installs with a saved CSV silently leave the new event off.[^notify]

[^notify]: backend/src/services/notify.service.ts (`NOTIFY_EVENTS`, `EVENTS_ADDED_LATER`, `EVENTS_VERSION`, `parseEvents`, `saveNotifyConfig`, `postWebhook`, `postNtfy`, `postTelegram`)
[^admin-routes]: backend/src/routes/admin.routes.ts (`NotifySchema`, `PUT /settings/notifications`, `POST /settings/notifications/test`)
