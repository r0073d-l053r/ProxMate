# ProxMate Roadmap

A living, prioritized list of suggested additions. ProxMate is already a mature,
production-ready multi-tenant Proxmox dashboard — the items here are about **closing
cloud-provider parity gaps and hardening for scale**, not fixing breakage. Tiers are
rough priority bands, not commitments. Have an idea? Open a
[discussion](https://github.com/r0073d-l053r/ProxMate/discussions/categories/ideas).

> ✅ **Shipped (Tier 1):** _Live VM resize_ — resize a VM's vCPU / memory / disk in place
> (quota-checked, disk grow-only). _Rebuild / reinstall_ — re-image a VM from a fresh ISO or
> template while keeping its VMID, name, and resources. _Per-VM backup policy_ — configurable
> MateState frequency + retention per VM.

---

## Tier 1 — High-value, low-risk (cloud parity)

- **Live VM resize / reconfigure** ✅ — change CPU/RAM/disk after creation
  (`PATCH /api/vms/:id`; disk is grow-only). _Done._
- **Rebuild / reinstall** ✅ — re-image a VM from a fresh ISO or template while keeping
  its DB record, VMID, name, and resources (`POST /api/vms/:id/rebuild`). _Done._
- **Per-VM backup policy** ✅ — configurable MateState frequency + retention per VM
  (`PUT /api/vms/:id/backup-policy`); VMs without one stay on the cluster-wide weekly
  default. _Done._
- **Tags / projects + bulk actions** ✅ — per-VM tags with a tag filter, plus multi-select
  bulk start/stop/restart on the VM list. (Bulk *delete* intentionally omitted — destroying
  several VMs at once is too easy to fumble, so deletion stays a deliberate per-VM action.) _Done._

## Tier 2 — Notifications & sharing

- **Event notifications** ✅ — admin-configured webhook (Discord / Slack / Mattermost /
  generic) + optional email alerts for backup failed, VM provisioning error, and account
  lockout. Per-event toggles and a "send test" button in Admin → Settings. _Done._
- **Share a VM** with another tenant — co-owner or read-only console access. _(Not yet
  built — deferred.)_

## Tier 3 — API & scale

- **Public REST API + per-user API tokens** — `pm_…` Bearer tokens resolved alongside the session
  cookie. _Deferred_ — built and verified, but held back from release to land on its own with a
  focused security review (it adds a second authentication path with full user privileges, which an
  invite-only deployment doesn't need yet). Tracked in PR #34.
- **OpenAPI / Swagger spec** ✅ — served at `GET /api/openapi.json`. _Done._
- **PostgreSQL option** — documented switch + portable Prisma queries. _Deferred_ — the prose docs
  (`docs/api.md`) ride with the API-tokens PR (#34); the queries are already portable and SQLite
  stays the default.

## Tier 4 — Reliability & observability ✅

- **Structured logging** (pino) + request-correlation IDs (`x-request-id`). _Done._
- **Deep health / readiness checks** — `GET /api/health` checks the DB; `?deep=1` probes
  Proxmox. _Done._
- **Prometheus `/metrics`** — request latency, `proxmate_proxmox_api_errors_total`,
  `proxmate_vm_count`. _Done._
- **Proxmox API timeouts + retry/backoff** — transient retries on idempotent reads only
  (never mutations). _Done._
- **Rate-limit all mutating endpoints** — a write limiter covers every non-GET API call.
  _Done._

## Tier 5 — Test & developer experience ✅

- **Playwright E2E** (login smoke) and **frontend unit tests** (Vitest + RTL). _Done._
- **Backend ESLint + Prettier** (wired into CI). _Done._
- **CI security scanning** — CodeQL / Trivy / `npm audit` + a CycloneDX SBOM. _Done._

## Optional / larger bets

- **LXC container support** — the isolation model already extends to it.
- **Built-in public ingress** — a managed reverse proxy / per-VM Cloudflare tunnel so
  tenants get `name.proxmate.example.com` without manual setup.
- **GPU / PCI passthrough requests.**
