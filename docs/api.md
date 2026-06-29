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
as a SHA-256 hash — ProxMate can't recover the secret, only revoke it. For safety, API
tokens **cannot** create or revoke other tokens; that requires a browser session.

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
```

## Observability

- `GET /api/health` — liveness; checks the DB. Add `?deep=1` to also probe Proxmox.
- `GET /metrics` — Prometheus metrics (request latency, Proxmox API errors, `proxmate_vm_count`).
  Set `METRICS_TOKEN` to require a Bearer token on this endpoint.

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
