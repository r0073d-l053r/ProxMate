---
type: Database
title: ProxMate database
description: The single Prisma-managed SQLite database behind the ProxMate backend, with its 23 core models, migration history and the module schema seam.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, sqlite, migrations]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: prisma-lib
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/prisma.ts
    title: backend/src/lib/prisma.ts
  - id: env-example
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/.env.example
    title: .env.example
  - id: compose
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/docker-compose.yml
    title: docker-compose.yml
  - id: entrypoint
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/docker-entrypoint.sh
    title: backend/docker-entrypoint.sh
  - id: package
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/package.json
    title: backend/package.json
  - id: migrations
    resource: https://github.com/r0073d-l053r/ProxMate/tree/main/backend/prisma/migrations
    title: backend/prisma/migrations/
  - id: modules-readme
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/modules/README.md
    title: backend/src/modules/README.md
  - id: migrate-modules
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/scripts/migrate-modules.ts
    title: backend/src/scripts/migrate-modules.ts
  - id: example-schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/modules/example/schema.prisma
    title: backend/prisma/modules/example/schema.prisma
  - id: appdb-backup
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/appdb-backup.service.ts
    title: backend/src/services/appdb-backup.service.ts
  - id: api-docs
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/docs/api.md
    title: docs/api.md
  - id: crypto
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/crypto.ts
    title: backend/src/lib/crypto.ts
---

# Purpose

ProxMate keeps all of its own state in one relational database: accounts, VM ownership records, backups metadata, tokens, audit trail and runtime settings. Proxmox itself remains the source of truth for live guest state.[^schema]

# Provider and connection

- Datasource `provider = "sqlite"`, `url = env("DATABASE_URL")`. Client generator is `prisma-client-js` (Prisma `^6.9.0`).[^schema] [^package]
- Local default is `DATABASE_URL="file:./proxmate.db"`, which Prisma resolves relative to `backend/prisma/`. Docker Compose uses `file:/data/proxmate.db` on a named volume.[^env-example] [^compose] See [backend environment](/env/backend-environment.md) and [docker environment](/env/docker-environment.md).
- One shared `PrismaClient` singleton lives in `backend/src/lib/prisma.ts`. It's cached on `globalThis` outside production.[^prisma-lib]
- `.env.example` and `docs/api.md` describe switching the provider to `postgresql` for HA. See Gotchas.[^env-example] [^api-docs]
- Secret columns and sensitive [SystemConfig](/database/system-config.md) rows are AES-256-GCM encrypted under `ENCRYPTION_KEY` (64 hex chars). That key must stay stable.[^crypto] [^compose]

# Migrations

- Core migrations live in `backend/prisma/migrations/` (51 directories, from `20260623035652_init` to `20261019140000_vm_hold_reason`).[^migrations]
- The 1.1.0 migrations (`20261019*`) add `User.emailBound` (backfilled for accounts that registered through an invite addressed to their email, and for the setup-wizard admin), the `IdeGuestSecret` table, `User.twoFactorFailedAttempts` and `User.twoFactorPendingSecret`, make `InviteToken.createdById` nullable with `ON DELETE SET NULL`, and add `VirtualMachine.holdReason`.[^migrations]
- The container entrypoint runs `npx prisma migrate deploy` on every boot, then the module migration step when `PROXMATE_MODULES` is set.[^entrypoint]
- npm scripts: `db:generate` (`prisma generate`), `db:migrate` (`prisma migrate dev`), `db:push`, `db:studio`, `db:migrate:modules` (`tsx src/scripts/migrate-modules.ts`).[^package]
- App-DB snapshots are taken with SQLite `VACUUM INTO` by the app-DB backup service (see [app-DB backup config](/config/appdb-backup.md)).[^appdb-backup]

# Module seam

Optional compiled-in modules (`backend/src/modules/<name>/`, enabled by `PROXMATE_MODULES`) may own tables:[^modules-readme]

- Schema at `backend/prisma/modules/<name>/schema.prisma`, with a `datasource` on the same `DATABASE_URL` and **no `generator` block**. A second client would mean a second connection pool against the single-writer SQLite file. Modules query their tables through the core singleton with `$queryRaw` / `$executeRaw`.[^modules-readme] [^example-schema]
- No `@relation` to core models. Module tables reference core rows by plain scalar ids.[^example-schema]
- Migration directories must be named `<14-digit timestamp>_<module>_<description>`. Core and module migrations share one `_prisma_migrations` ledger keyed by directory name alone, so a name collision would silently skip a module migration. `migrate-modules.ts` refuses to run on a non-conforming name.[^migrate-modules]
- `migrate-modules.ts` validates each name against `^[a-z][a-z0-9-]{1,30}$` and requires the module's code to exist. It makes a relative SQLite `file:` URL absolute (relative to `prisma/`) before running `prisma migrate deploy --schema <module schema>`. Any failure exits non-zero and aborts boot.[^migrate-modules] [^entrypoint]
- The shipped example module (`prisma/modules/example`) defines `ModuleExample` with migration `20260811000000_example_init`.[^example-schema]

# Models

| Model | Concept | Notes |
|---|---|---|
| User | [user](/database/user.md) | Accounts, 2FA, lockout, quotas, access window |
| Session | [session](/database/session.md) | Server side of the 24h session JWT + CSRF token |
| ApiToken | [api-token](/database/api-token.md) | `pm_` personal tokens (HMAC-hashed) |
| IdeGatewayToken | [ide-gateway-token](/database/ide-gateway-token.md) | `pmide_` per-VM LLM gateway tokens |
| IdeGuestSecret | [ide-guest-secret](/database/ide-guest-secret.md) | Per-VM IDE guest credential, encrypted |
| TenantLlmKey | [tenant-llm-key](/database/tenant-llm-key.md) | BYO LLM keys, encrypted |
| SshKey | [ssh-key](/database/ssh-key.md) | Saved public keys |
| InviteToken | [invite-token](/database/invite-token.md) | Registration invites with quotas |
| VirtualMachine | [virtual-machine](/database/virtual-machine.md) | Tenant guests (qemu/lxc) |
| PassthroughRequest | [passthrough-request](/database/passthrough-request.md) | GPU/PCI requests + apply progress |
| VmShare | [vm-share](/database/vm-share.md) | Preset-level VM sharing |
| MateState | [mate-state](/database/mate-state.md) | vzdump backups |
| SystemConfig | [system-config](/database/system-config.md) | Key/value settings and secrets |
| DownloadToken | [download-token](/database/download-token.md) | Single-use backup download links |
| AuditLog | [audit-log](/database/audit-log.md) | Append-only audit trail |
| ResourceSample | [resource-sample](/database/resource-sample.md) | 5-minute usage samples |
| AlertRule | [alert-rule](/database/alert-rule.md) | Per-VM threshold alerts |
| Template | [template](/database/template.md) | Template Store entries |
| QuotaRequest | [quota-request](/database/quota-request.md) | Quota increase requests |
| PasswordResetToken | [password-reset-token](/database/password-reset-token.md) | Emailed reset tokens (hashed) |
| PasswordResetRequest | [password-reset-request](/database/password-reset-request.md) | No-SMTP admin reset requests |
| TwoFactorRecoveryCode | [two-factor-recovery-code](/database/two-factor-recovery-code.md) | TOTP backup codes (hashed) |
| Passkey | [passkey](/database/passkey.md) | WebAuthn credentials |

[^schema]

# Invariants

- Foreign keys with `ON DELETE CASCADE` hang off [User](/database/user.md) and [VirtualMachine](/database/virtual-machine.md). Logs and auth side tables (`AuditLog`, `ResourceSample`, `DownloadToken`, `PasswordResetToken`, `PasswordResetRequest`, `TwoFactorRecoveryCode`, `Passkey`) use scalar ids with no FK, so they survive deletions.[^schema]
- Stored bearer secrets are hashed (SHA-256, or HMAC-SHA256 for API tokens). Exceptions are stored raw: [Session](/database/session.md).`token` (the JWT) and [InviteToken](/database/invite-token.md).`token`.[^schema]

# Gotchas

- The committed migrations are SQLite-dialect SQL (`PRAGMA foreign_keys`, `DATETIME`, table-rebuild "RedefineTables"), and app-DB backups use `VACUUM INTO`. A Postgres switch therefore needs fresh migrations and a different DB backup method, despite `docs/api.md` saying there is no SQLite-specific SQL.[^migrations] [^appdb-backup] [^api-docs]
- There is no `migration_lock.toml` in the core migrations directory (the example module has one).[^migrations]
- Pruning is per table and partial: `ResourceSample` (rolling window), `DownloadToken` (opportunistic), `MateState` (retention), and expired `Session`s only on refresh. `AuditLog` and `PasswordResetToken` are never pruned.[^schema]

[^schema]: backend/prisma/schema.prisma
[^prisma-lib]: backend/src/lib/prisma.ts
[^env-example]: .env.example
[^compose]: docker-compose.yml
[^entrypoint]: backend/docker-entrypoint.sh
[^package]: backend/package.json
[^migrations]: backend/prisma/migrations/
[^modules-readme]: backend/src/modules/README.md
[^migrate-modules]: backend/src/scripts/migrate-modules.ts
[^example-schema]: backend/prisma/modules/example/schema.prisma
[^appdb-backup]: backend/src/services/appdb-backup.service.ts
[^api-docs]: docs/api.md
[^crypto]: backend/src/lib/crypto.ts
