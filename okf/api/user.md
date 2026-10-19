---
type: API Router
title: User management router
description: Admin-only listing, quota/access-window edits and deletion of user accounts, mounted at /api/users.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/user.routes.ts
tags: [proxmate, api, admin, users, quota]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/user.routes.ts
    title: backend/src/routes/user.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
---

# Purpose

Admin user directory. Mounted at `/api/users`.[^app]

# Authentication

- `router.use(requireAuth, requireAdmin, enforceMfaSetup)`: non-admins get 403 `Forbidden — admin access required`.[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/users` | admin | All users (newest first) with `vmCount`, quota `{ used, max }` for cpu/ram/storage, `accessExpiresAt`, `accessSuspendedAt`, `createdAt`. |
| PATCH | `/api/users/:id` | admin | Set `{ maxCpu, maxRam, maxStorage, accessDuration? }`. Audited `admin.update_quota`, plus `admin.update_access` when `accessDuration` is given. |
| DELETE | `/api/users/:id` | admin | Destroy every VM of the user (guest and row), then delete the user row. 409 `{ error, vms }` (account kept) when any machine's guest can't be deleted with it. |

# Gotchas

- zod `UpdateQuotaSchema`: `maxCpu` int 0..1024, `maxRam` int >= 0 (MB), `maxStorage` int >= 0 (GB), `accessDuration` optional enum `ACCESS_DURATIONS`.[^routes]
- `accessDuration` is tri-state: omitted leaves the window unchanged; a duration sets `accessExpiresAt` from now; `'never'` clears it. Any supplied value also clears `accessSuspendedAt` so the tenant can power on again.[^routes]
- Setting a non-`never` duration on an admin returns 400 (admins never expire).[^routes]
- Quotas are enforced at create/resize time only; lowering below usage leaves existing VMs untouched.[^routes]
- "used" in GET sums all the user's VMs (this list does not exclude `quotaExempt` VMs, unlike `GET /api/auth/me`).[^routes]
- DELETE: refuses self-deletion (400). Every VM is first checked (`destroyBlocker`): a guest without a ProxMate tag, or one whose location can't be confirmed, refuses the deletion up front with 409 and nothing is destroyed — adopt or remove those rows first. A guest that then fails to destroy also returns 409 and keeps the account. The account's unredeemed invites are revoked in the same transaction as the account itself; redeemed ones are kept with no creator. A successful deletion is audited as `admin.delete_user`.[^routes]

# Relationships

- Reads/writes [User](/database/user.md) and reads [VirtualMachine](/database/virtual-machine.md) via Prisma directly; cascades to [Session](/database/session.md) and others.
- Uses the [vm service](/services/vm.md) (`destroyVm`), [access service](/services/access.md) (`accessExpiryFrom`), [audit service](/services/audit.md).
- Related: [quota-request router](/api/quota-request.md), [invite router](/api/invite.md), [admin router](/api/admin.md).

[^routes]: backend/src/routes/user.routes.ts
[^app]: backend/src/app.ts
