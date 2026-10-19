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
as a SHA-256 hash — ProxMate can't recover the secret, only revoke it. A password
reset revokes all of the account's tokens.

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

# Nodes this VM may migrate to (admin only) — Proxmox allowed_nodes ∩ online
curl -H "$AUTH" "$BASE/vms/<id>/migrate-targets"
```

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
