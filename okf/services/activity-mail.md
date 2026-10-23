---
type: Backend Service
title: Activity-mail service (deploy-for-tenant and share emails)
description: Best-effort emails to a tenant about their own machines - an admin set a VM up in their account, or a VM was shared with them or their share level changed - sent after the request is answered.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/activity-mail.service.ts
tags: [proxmate, email, sharing, notifications]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T12:00:00Z }
sources:
  - id: activity
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/activity-mail.service.ts
    title: backend/src/services/activity-mail.service.ts
  - id: share
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm-share.service.ts
    title: backend/src/services/vm-share.service.ts
  - id: templates
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/email-templates.ts
    title: backend/src/lib/email-templates.ts
---

# Purpose

Tells a tenant when something happens to their machines that they did not do themselves: an admin created a VM or container in their account (deploy-for-tenant), or a VM was shared with them / their share level changed. Uses the branded templates `vmDeployedForYouEmail` and `vmSharedEmail`.[^activity][^templates] There is no in-app inbox; the VM's activity feed already records both events.

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `sendDeployedForTenantEmail` | `(vm, actor) => Promise<boolean>` | No-op when `vm.userId === actor.id`. Otherwise emails the owner the VM's name, size, quota effect and the admin-managed lock, with a link to `/vms/:id`. |
| `sendShareEmail` | `(notice: ShareNotice, actor, now?) => Promise<boolean>` | Emails the recipient of a live share: new share, or level change (`previousRole`). Names the sharer by display name **and** address. At most one email per (recipient, VM) per `SHARE_NOTICE_WINDOW_MS` (24 h); a share or level change inside the window is folded. The window map is in memory, capped at 10,000 pairs (oldest dropped). |
| `sendLater` | `(what, fn) => void` | Runs `fn` on `setImmediate` and logs (never rethrows) a failure. Routes call it after `res.json`. |

# Gotchas

- SMTP off: logged (`[activity-mail] SMTP is not configured …`) and skipped. A recipient with `User.activityEmailOptOut` (Security → Email preferences), or whose access window has ended (`hasAccessEnded`: expired or suspended), gets nothing.[^activity]
- The 24 h share window resets on a backend restart (it is in memory), so a restart can allow one extra email per pair.[^activity]
- Sharing must answer the same whether or not the address has an account. `addShareWithNotice` returns a `ShareNotice` only for a live share that is new or changed level — never for a pending share (an address with no account) and never for a re-save at the same level. The route answers first and only then hands the notice to `sendLater`, so the response, its headers and its timing are identical for both cases.[^share]
- The links use `frontend_url` / `FRONTEND_URL`; with neither set the email has no button.[^activity]

# Relationships

- Called by the [VM router](/api/vm.md) (`POST /`, `POST /containers`, `POST /:id/shares`) and the [template router](/api/template.md) (`POST /deploy`).
- Uses [mail](/services/mail.md), [config](/services/config.md), [vm-share](/services/vm-share.md) (`ShareNotice`); reads [User](/database/user.md).

[^activity]: backend/src/services/activity-mail.service.ts
[^share]: backend/src/services/vm-share.service.ts (`addShareWithNotice`, `ShareNotice`)
[^templates]: backend/src/lib/email-templates.ts (`vmDeployedForYouEmail`, `vmSharedEmail`)
