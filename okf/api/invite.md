---
type: API Router
title: Invite router
description: Admin-only creation, emailing, listing and revocation of registration invite tokens, mounted at /api/invites.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/invite.routes.ts
tags: [proxmate, api, admin, invites, onboarding]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/invite.routes.ts
    title: backend/src/routes/invite.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
  - id: auth
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/auth.routes.ts
    title: backend/src/routes/auth.routes.ts
---

# Purpose

Admins mint invite links that carry a tenant's starting quota, 2FA requirement and compute-access duration. Mounted at `/api/invites`.[^app] Redemption is public, in the [auth router](/api/auth.md) (`GET /api/auth/invite/:token`, `POST /api/auth/register`).[^auth]

# Authentication

- `router.use(requireAuth, requireAdmin)`. No `enforceMfaSetup` on this router.[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/invites` | admin + requireSession | Create an invite; optionally email it. The invite's `email` is stored only when the send succeeds. 201 with `token`, `inviteUrl`, quotas, `require2fa`, `accessDuration`, `expiresAt`, `emailed`, `emailError?`. |
| POST | `/api/invites/:id/send` | admin + requireSession | (Re)send a still-valid invite to `{ email }`; 400 on a bad email, 404 if unknown, 409 if used or expired; otherwise 200 `{ ok, email, error? }` even when the send fails. On success the invite's `email` is updated; when the address differs from the stored one (or none was stored) the invite gets a new token in the same write and the mail carries the new link, so the previous link stops working. A failed send changes nothing. |
| GET | `/api/invites` | admin + requireSession | All invites (newest first) with `used`, `usedBy`, `expired`. |
| DELETE | `/api/invites/:id` | admin | Revoke an unused invite; 409 if already used. |

# Gotchas

- zod `CreateInviteSchema`: `maxCpu/maxRam/maxStorage` positive ints, `label` max 200, `email` optional trimmed email max 254, `expiresIn` default `'7d'` (parsed by `parseExpiry`, 400 on bad value), `require2fa` default false, `accessDuration` optional `ACCESS_DURATIONS`.[^routes]
- `expiresIn` is how long the link is redeemable; `accessDuration` is how long the tenant may use the cluster after redeeming. `'never'` or omitted is stored as `null`.[^routes]
- Invite URL is `${FRONTEND_URL}/register/<token>` (default `http://localhost:3000`).[^routes]
- Email failure never fails creation; SMTP not configured yields an `emailError` string. `/send` returns 200 even on failure so a proxy does not replace the error page.[^routes]
- GET omits `token` and `inviteUrl` for used or expired invites so stale tokens do not linger in admin logs.[^routes]
- Create, send and revoke are audited (`invite.create`, `invite.send`, `invite.revoke`) by invite id; the token itself is never written to the audit log.

# Relationships

- Persists [InviteToken](/database/invite-token.md) (created by and used by a [User](/database/user.md)); token generation in the [invite service](/services/invite.md).
- Email via the [mail service](/services/mail.md) using [SMTP config](/config/smtp.md).
- Access windows: [access service](/services/access.md).

[^routes]: backend/src/routes/invite.routes.ts
[^app]: backend/src/app.ts
[^auth]: backend/src/routes/auth.routes.ts
