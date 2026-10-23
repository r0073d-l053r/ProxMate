# ProxMate REST API

Everything the dashboard does over `/api/*` is a normal REST call, so you can drive
ProxMate from a script, a CLI, Terraform, or CI.

## Authentication — personal API tokens

Create a token under **Security → API tokens** in the app. The raw token (prefixed
`pm_…`) is shown **once** — copy it then. Send it as a Bearer header:

```bash
curl -H "Authorization: Bearer pm_xxxxxxxx" https://proxmate.example.com/api/vms
```

A token acts as the user who created it (same quotas and ownership). Tokens are stored
as an HMAC-SHA256 hash — ProxMate can't recover the secret, only revoke it. A password
reset revokes all of the account's tokens.

An unknown, revoked or expired token answers **401**. A valid token whose owner's compute
access window has ended answers **403** with `code: "access_expired"`, so a script can tell
the two apart.

### Session-only routes

Routes that change how an account signs in or is secured accept only a browser
session. Called with an API token they answer **403** (`API tokens cannot manage
account security — use the web app.`):

| Area | Routes |
|---|---|
| Session | `POST /api/auth/session/refresh` |
| Kiosk exit | `POST /api/auth/kiosk-exit`, `POST /api/auth/kiosk-exit/passkey-options`, `POST /api/auth/kiosk-exit/passkey-verify` |
| Two-factor | `POST /api/auth/2fa/setup`, `POST /api/auth/2fa/enable`, `POST /api/auth/2fa/disable`, `GET /api/auth/2fa/status` |
| Passkeys | `POST /api/auth/passkeys/register/options`, `POST /api/auth/passkeys/register/verify`, `GET /api/auth/passkeys`, `DELETE /api/auth/passkeys/:id` |
| API tokens | `GET /api/api-tokens`, `POST /api/api-tokens`, `DELETE /api/api-tokens/:id` |
| Invites (admin) | `GET /api/invites`, `POST /api/invites`, `POST /api/invites/:id/send` |
| Admin | `PUT /api/admin/settings/kiosk`, `PUT /api/admin/settings/sso`, `POST /api/admin/users/:id/reset-password` |

Everything else an account can do — VMs, backups, snapshots, shares, templates,
and the rest of the admin API — works with a token.

## Discovering the API

A machine-readable description is served at:

```
GET /api/openapi.json
```

It's an OpenAPI 3.1 document of the tenant-facing endpoints (VMs, templates, ISOs).
Point Swagger UI, `openapi-generator`, or an HTTP client at it to explore or generate a
client.

## Common calls

```bash
BASE=https://proxmate.example.com/api
AUTH="Authorization: Bearer pm_xxxxxxxx"

# List your VMs
curl -H "$AUTH" "$BASE/vms"

# Create a VM from an ISO
curl -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"web-01","cpu":2,"ram":2048,"storage":20,"os":"debian-12.iso"}' \
  "$BASE/vms"

# Start / stop / restart
curl -H "$AUTH" -X POST "$BASE/vms/<id>/start"
curl -H "$AUTH" -X POST "$BASE/vms/<id>/stop?force=true"

# Resize (grow disk / change cores/ram)
curl -H "$AUTH" -H 'content-type: application/json' -X PATCH \
  -d '{"cpu":4,"ram":4096,"storage":40}' "$BASE/vms/<id>"

# Add an SSH public key to a running VM (via the QEMU guest agent)
curl -H "$AUTH" -H 'content-type: application/json' -X POST \
  -d '{"username":"ubuntu","publicKey":"ssh-ed25519 AAAA… you@laptop"}' \
  "$BASE/vms/<id>/ssh-keys"

# Push a small file into a running VM (QEMU guest agent; 1 MiB by default)
curl -H "$AUTH" -X POST -F file=@app.conf -F path=/etc/app/app.conf \
  -F mode=0640 -F owner=ubuntu -F createParents=true "$BASE/vms/<id>/files"

# Tail of the ProxMate IDE install log (VM owner or admin)
curl -H "$AUTH" "$BASE/ide/<id>/install-log"

# Nodes this VM may migrate to (admin only) — Proxmox allowed_nodes ∩ online
curl -H "$AUTH" "$BASE/vms/<id>/migrate-targets"

# Share a VM by email (owner/admin) — role: viewer | operator | manager
curl -H "$AUTH" -H 'content-type: application/json' -X POST \
  -d '{"email":"friend@example.com","role":"operator"}' "$BASE/vms/<id>/shares"

# Your VMs grouped by project, with usage averaged over the last 7 days
curl -H "$AUTH" "$BASE/projects?days=7"

# Move VMs you own into a project (or out of one with "project": null)
curl -H "$AUTH" -H 'content-type: application/json' -X POST \
  -d '{"ids":["<id>","<id>"],"project":"shop"}' "$BASE/projects/assign"
```

## Responses worth knowing

- **Start, stop and restart** wait up to 45 seconds for Proxmox to confirm the task
  finished before answering (stop answers `{ success, status: "stopped", forced }`). A
  task Proxmox reports as failed answers **502** with its message. A graceful stop or
  restart the guest ignores answers **502** with an error asking you to wait or stop it
  forcibly (`?force=true`).
- **Migration targets** (`GET /vms/:id/migrate-targets`) answers
  `{ current, targets, blockers, localDisks }`: `targets` are the online nodes Proxmox
  allows, `blockers` is a list of `{ node, reason }` for the nodes it can't move to (`node`
  is `"*"` when the reason covers every node, e.g. a container or an attached PCI device).
- **Shares.** `POST /vms/:id/shares` answers **202** with the same message whether or not
  the address has an account, and is limited per signed-in user (30 per hour by default;
  `SHARE_RATE_LIMIT_MAX`, `SHARE_RATE_LIMIT_WINDOW_MS`). An address with no account yet
  gets a pending share that starts once someone registers with it through an invite sent
  to that address (or signs up by SSO with a verified email). `GET /vms/:id/shares` lists
  `{ id, email, role, createdAt }` per share, pending ones included and shown the same way;
  `DELETE /vms/:id/shares/:shareId` revokes either kind. A VM holds at most 100 shares
  (a new address past that answers **409**).
- **Projects.** A project is a `project:<name>` tag on the VM (names: letters, numbers,
  `_` and `-`, up to 32, lowercased; one project per VM). Only a VM's owner (or an admin)
  sets it; `POST /projects/assign` answers per VM `{ id, ok, error? }`, with VMs you don't own
  reported as `not found`. `PATCH /vms/:id` `tags` edits the other labels and keeps the
  project. `GET /projects` answers `{ days, owners, shared }`: your VMs by project, each with
  `vmCount`, `running`, allocated `cpu`/`ram`/`storage` and `usage { samples, avgCpuPct,
  avgMemBytes }` (averages from the usage samples taken while each VM ran), and VMs shared
  with you as one `shared` group without their owner's tags. Admins get every owner.
- **File push.** `POST /vms/:id/files` (multipart) needs the `configure` capability (owner,
  admin or a Manager share) and answers `{ path, size, sha256, verified }`. The path must
  be absolute and normalized and not under `/proc`, `/sys` or `/dev` (**400** otherwise);
  a file over the limit (`GUEST_FILE_PUSH_MAX_BYTES`, 1 MiB by default, at most 8 MiB)
  answers **413**, a container or a guest whose agent doesn't answer **409**. Into a folder other users can write to (or reached through a symlink) the file is written as `owner`; without one that push answers **400**. Limited per
  signed-in user (30 per 10 minutes; `GUEST_FILE_RATE_LIMIT_MAX`, `_WINDOW_MS`).
- **Sizes.** Creates, template deploys and resizes asking for less than 64 MB of RAM
  answer **400**. A resize grows the root disk by the difference between the requested
  total and the current total.
- **Alerts.** A machine can have at most 20 alert rules; a 21st, or a duplicate of an
  existing rule (same metric and threshold), answers **409**.
- **Machines that can't run.** A machine held after a create, rebuild or restore that
  didn't finish, or one whose guest doesn't carry its ProxMate ownership tag, refuses
  start, console, IDE and backups with an error that says why; an admin settles it (below).
- **Kiosk exit** (`POST /auth/kiosk-exit`, `/auth/kiosk-exit/passkey-verify`) answers
  **403** with `code: "reauth_failed"` for a wrong PIN, password or passkey. A 401 there
  always means the session is gone.

### Admin: unconfirmed machines and users

| Call | What it does |
|---|---|
| `GET /admin/vms/unmatched` | Machines whose VMID holds no guest carrying their ProxMate tag, with what Proxmox has at that VMID (`guest`), whether another machine shares the VMID (`sharedVmid`) and whether it's a Template Store VMID (`templateRow`). |
| `POST /admin/vms/:id/adopt` | Tags the guest at the VMID as this machine's (and, for a held machine, re-applies isolation and re-reads its sizes before clearing the hold). **409** with the reason when the guest can't be adopted. |
| `DELETE /vms/:id?rowOnly=true` | Removes only ProxMate's record and leaves the guest alone. Admin only (**403** otherwise); refused for a machine whose guest is confirmed as its own — delete it normally. |
| `DELETE /users/:id` | Deletes the account and its machines with their guests. When any machine can't be deleted with its guest, answers **409**, keeps the account and lists those machines in `vms` (`id`, `name`, `proxmoxVmId`, `reason`). |

## Observability

- `GET /api/health` — liveness; checks the DB. Add `?deep=1` to also probe Proxmox.
- `GET /metrics` — Prometheus metrics (request latency, Proxmox API errors, `proxmate_vm_count`).
  Set `METRICS_TOKEN` to require a Bearer token on this endpoint. **In production `/metrics`
  returns 404 unless `METRICS_TOKEN` is set** — scrape over localhost, or set a token.

## Running on PostgreSQL (HA / larger deployments)

SQLite is the default and is perfect for a single instance. To run multiple instances
(or just prefer Postgres), switch the Prisma datasource provider and point
`DATABASE_URL` at your database:

```prisma
// backend/prisma/schema.prisma
datasource db {
  provider = "postgresql"   // was "sqlite"
  url      = env("DATABASE_URL")
}
```

```bash
DATABASE_URL="postgresql://proxmate:secret@db:5432/proxmate?schema=public"
cd backend && npx prisma migrate deploy   # applies the schema to Postgres
```

All of ProxMate's queries go through Prisma (no SQLite-specific SQL), so the app code is
portable. Keep one provider per deployment — don't switch a populated SQLite database to
Postgres in place; export/import the data instead.
