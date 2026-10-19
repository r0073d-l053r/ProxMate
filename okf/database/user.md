---
type: Prisma Model
title: User
description: A ProxMate account (admin or tenant) holding credentials, 2FA state, lockout counters, resource quotas and the compute access window.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, auth, quota]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: auth-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auth.service.ts
    title: backend/src/services/auth.service.ts
  - id: lockout
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/account-lockout.service.ts
    title: backend/src/services/account-lockout.service.ts
  - id: twofactor
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/twofactor.service.ts
    title: backend/src/services/twofactor.service.ts
  - id: access
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/access.service.ts
    title: backend/src/services/access.service.ts
  - id: sweep
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/access-sweep.service.ts
    title: backend/src/services/access-sweep.service.ts
  - id: auth-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/auth.routes.ts
    title: backend/src/routes/auth.routes.ts
  - id: user-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/user.routes.ts
    title: backend/src/routes/user.routes.ts
  - id: sso
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/sso.service.ts
    title: backend/src/services/sso.service.ts
  - id: mfa
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/mfa.service.ts
    title: backend/src/services/mfa.service.ts
  - id: vm-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
  - id: init-mig
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/migrations/20260623035652_init/migration.sql
    title: backend/prisma/migrations/20260623035652_init/migration.sql
  - id: creator-mig
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/migrations/20261019132000_invite_creator_set_null/migration.sql
    title: backend/prisma/migrations/20261019132000_invite_creator_set_null/migration.sql
---

# Purpose

The central identity row. Every tenant and admin is a `User`; `role` decides admin vs tenant. Quotas, 2FA, SSO linkage, brute-force lockout and the compute access window all live directly on this row.[^schema]

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| email | String | `@unique` | Login email; stored lowercased and trimmed at registration.[^auth-routes] |
| passwordHash | String | | bcrypt hash, cost 12.[^auth-svc] |
| displayName | String | | Display name. |
| role | String | `@default("user")` | `"admin"` or `"user"`. |
| ssoSubject | String? | `@unique` | OIDC `sub` claim, set on first SSO login. |
| emailBound | Boolean | default false | The address is known to belong to this person: registered through an invite addressed to it, entered at setup, or asserted verified by the IdP at SSO sign-up. Required before SSO links by email. |
| twoFactorEnabled | Boolean | `@default(false)` | TOTP active. |
| twoFactorSecret | String? | | AES-256-GCM encrypted base32 TOTP secret (`iv:tag:ciphertext` hex).[^twofactor] |
| twoFactorPendingSecret | String? | | Encrypted secret from a setup not yet confirmed; replaces `twoFactorSecret` when `enable` verifies a code from it. |
| require2fa | Boolean | `@default(false)` | Copied from the invite; user must enroll a factor before use. |
| failedLoginAttempts | Int | `@default(0)` | Consecutive failed passwords. |
| lockedUntil | DateTime? | | End of the temporary lockout window. |
| twoFactorFailedAttempts | Int | `@default(0)` | Wrong 2FA codes at login. Not reset by a correct password; cleared by a completed 2FA login. Shares the lockout threshold and `lockedUntil`. |
| maxCpu | Int | `@default(0)` | Total vCPU quota. |
| maxRam | Int | `@default(0)` | Total RAM quota (MB). |
| maxStorage | Int | `@default(0)` | Total disk quota (GB). |
| broadcastOptOut | Boolean | `@default(false)` | Opted out of admin broadcast emails (Community Edition only). |
| accessExpiresAt | DateTime? | | End of the compute access window; null = never expires. |
| accessSuspendedAt | DateTime? | | Set when the window lapsed and the tenant was suspended; cleared when access is extended. |
| accessWarned7For | DateTime? | | The deadline the 7-day warning was sent for. |
| accessWarned1For | DateTime? | | The deadline the 1-day warning was sent for. |
| createdAt | DateTime | `@default(now())` | |
| updatedAt | DateTime | `@updatedAt` | |

[^schema]

# Relationships

- Has many [VirtualMachine](/database/virtual-machine.md) (`vms`), [Session](/database/session.md), [SshKey](/database/ssh-key.md), [ApiToken](/database/api-token.md), [VmShare](/database/vm-share.md) (VMs shared *with* this user), [QuotaRequest](/database/quota-request.md), [PassthroughRequest](/database/passthrough-request.md), [IdeGatewayToken](/database/ide-gateway-token.md), [TenantLlmKey](/database/tenant-llm-key.md) (`llmKeys`). All these FKs are `ON DELETE CASCADE`.[^schema]
- [InviteToken](/database/invite-token.md) twice: `invitesCreated` (relation `CreatedInvites`, FK `ON DELETE SET NULL`) and `usedInvite` (relation `UsedInvite`, FK `ON DELETE SET NULL`).[^init-mig]
- Referenced by plain scalar `userId` (no FK) from [PasswordResetToken](/database/password-reset-token.md), [PasswordResetRequest](/database/password-reset-request.md), [TwoFactorRecoveryCode](/database/two-factor-recovery-code.md), [Passkey](/database/passkey.md), [DownloadToken](/database/download-token.md), [AuditLog](/database/audit-log.md), [ResourceSample](/database/resource-sample.md), [AlertRule](/database/alert-rule.md).[^schema]

# Invariants

- Lockout: after `AUTH_LOCKOUT_MAX` (default 10) consecutive failed passwords, or as many wrong 2FA codes (`twoFactorFailedAttempts`), the account is locked for `AUTH_LOCKOUT_MINUTES` (default 15). The counter stays spent until the lock runs out; a correct password resets `failedLoginAttempts` but never lifts a lock in force or resets the 2FA count. Locks always auto-expire.[^lockout]
- `isAccessExpired` is false for admins and for null `accessExpiresAt`; otherwise true once `accessExpiresAt <= now`.[^access]
- Warning dedupe compares `accessWarned7For` / `accessWarned1For` against the *current* `accessExpiresAt`, so extending the window re-arms warnings automatically.[^sweep]
- Quota enforcement sums `cpu`/`ram`/`storage` over the user's VMs with `quotaExempt: false`; admins are never quota-checked.[^vm-svc]
- `isMfaSetupRequired` is true only when `require2fa` is set, TOTP is off and the user has zero passkeys. An SSO-linked account (`ssoSubject`) is exempt for SSO sessions only; its local password login still requires the factor.[^mfa]
- SSO login looks up by `ssoSubject`, otherwise links an existing account with the same email (only when `emailBound` and the IdP asserts `email_verified: true`) by writing `ssoSubject` onto it, and otherwise JIT-provisions a new user when that is allowed.[^sso]

# Gotchas

- Deleting a user cascades VMs, sessions, keys, tokens and shares, but leaves the non-FK rows listed above (passkeys, recovery codes, reset tokens, audit, samples) as orphans. The admin delete route first checks that every one of the user's machines can be deleted with its guest; if any cannot (a guest without its ownership tag, an unconfirmed location, or a failed destroy) the account is kept and the route answers 409 with the blocked `vms`.[^user-routes]
- `InviteToken.createdById` is `ON DELETE SET NULL`: deleting an admin who created invites keeps the redeemed ones with no creator; the delete route revokes the unredeemed ones in the same transaction.[^creator-mig] [^user-routes]
- `InviteToken.usedById` is `SET NULL` on delete: deleting a tenant makes the invite they redeemed look unused again, and it is redeemable if its `expiresAt` has not passed.[^init-mig] [^auth-routes]
- Registration creates the user first, then atomically claims the invite with `updateMany where usedById: null`; on a lost race the new user row is deleted.[^auth-routes]

[^schema]: backend/prisma/schema.prisma
[^auth-svc]: backend/src/services/auth.service.ts
[^lockout]: backend/src/services/account-lockout.service.ts
[^twofactor]: backend/src/services/twofactor.service.ts
[^access]: backend/src/services/access.service.ts
[^sweep]: backend/src/services/access-sweep.service.ts
[^auth-routes]: backend/src/routes/auth.routes.ts
[^user-routes]: backend/src/routes/user.routes.ts
[^sso]: backend/src/services/sso.service.ts
[^mfa]: backend/src/services/mfa.service.ts
[^vm-svc]: backend/src/services/vm.service.ts
[^init-mig]: backend/prisma/migrations/20260623035652_init/migration.sql
[^creator-mig]: backend/prisma/migrations/20261019132000_invite_creator_set_null/migration.sql
