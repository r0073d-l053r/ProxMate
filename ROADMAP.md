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
  bulk start/stop/restart/**delete** on the VM list. Bulk delete is guarded behind a typed
  confirmation (you must type the exact count of selected VMs) so a destructive mass-action can't
  happen on a stray click. _Done (delete restored in v0.2.7)._

## Tier 2 — Notifications & sharing

- **Event notifications** ✅ — admin-configured webhook (Discord / Slack / Mattermost /
  generic) + optional email alerts for backup failed, VM provisioning error, and account
  lockout. Per-event toggles and a "send test" button in Admin → Settings. _Done._
- **Share a VM** with another tenant ✅ — grant **co-owner** (full lifecycle: start/stop/resize/
  back up) or **read-only** (view details, live stats, activity) access by email, managed from the
  VM detail page (`/api/vms/:id/shares`). The API enforces every action; shared VMs show in the
  recipient's list with a role badge. _Done._ _(Read-only access to the **interactive console** —
  input-blocked viewing — is the remaining follow-up; co-owners already get full console.)_

## Tier 3 — API & scale

- **Public REST API + per-user API tokens** ✅ — `pm_…` Bearer tokens (managed under Security),
  resolved alongside the session cookie; only a one-way HMAC-SHA256 hash is stored, never the token.
  _Done._
- **OpenAPI / Swagger spec** ✅ — served at `GET /api/openapi.json`. _Done._
- **PostgreSQL option** — Prisma queries are portable and a switch is feasible, but **SQLite stays
  the default** and is the only supported datasource for now.
- **Cluster Balancer (DRS-style workload balancing)** ✅ — evens out node **memory** load (the
  binding constraint) by live-migrating ProxMate-managed guests off the hottest node onto the
  coldest. Admin policy in **Admin → Balancer**: _Off / Recommend only / Auto-apply_, an imbalance
  tolerance, a per-run move cap, and a never-move list. Guardrails: architecture-aware (never
  x86↔ARM), **anti-affinity** via `aa:<group>` tags, **pinning** via `pin`/`no-balance` tags, and
  every candidate move must strictly lower the peak node load (no oscillation). Recommend mode shows
  a reviewable plan you apply by hand; auto mode applies on a ~15-min scheduler tick. _Done._

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

## Candidate ideas — proposed 2026-06-29 (post-audit)

Proposed 2026-06-29. Reviewed with the owner: build the **Community-Edition** items first,
then the **EDU** items. Status below reflects the CE build pass (shipped in **v0.3.4**).

1. **Usage-based billing & showback.** Turn the v0.3.1 `ResourceSample` history into
   per-tenant monthly cost/showback reports (configurable $/vCPU-hr, $/GB-RAM, $/GB-disk)
   with CSV/PDF export. _Builds on:_ per-tenant resource history. **→ EDU, planned next.**
2. **Ephemeral / TTL VMs (auto-expiry).** A VM (or an invite's VMs) gets a lifetime —
   auto-stop, then auto-delete at expiry, with warning emails first. _Builds on:_ invites +
   power schedules + notifications. **→ EDU, planned next.**
3. ~~**Tenant self-service firewall rules.**~~ _Declined by the owner._
4. ✅ **Off-cluster backup targets — covered.** Achieved today by pointing the v0.3.0
   backup-storage picker at a remote **NFS/CIFS/PBS** storage. _(S3/restic via ProxMate isn't
   feasible in the API-only model — Proxmox has no API to read vzdump bytes, and S3 isn't a
   native vzdump target.)_
5. ✅ **VM migration between nodes — DONE (v0.3.4).** Admin-triggered live/offline migrate
   (`POST /api/vms/:id/migrate`), arch-guardrailed.
6. ~~**Custom cloud-init user-data editor.**~~ _Dropped — arbitrary user-data needs a host
   snippet file the API can't write (the Docker/Tailscale extras rely on admin-placed snippets)._
7. ✅ **Additional data disks / volume management — DONE (v0.3.4).** Attach / grow / remove
   extra disks per VM, quota-aware.
8. ✅ **Quota-increase request workflow — DONE (v0.3.4).** Tenants request from their
   dashboard; admins approve (applies caps) or deny on the Users page.
9. ✅ **Live updates over the wire — DONE (v0.3.4, via SSE).** One server poll loop fans live
   stats out to all admins over Server-Sent Events; the monitor falls back to polling.
10. ~~**Audit-log retention, export & SIEM streaming.**~~ _Declined by the owner._
11. ✅ **Cluster Balancer (DRS-style) — DONE.** Professional-grade workload balancing for the
    API-only model: memory-load-based, recommend-first then opt-in auto-apply, with arch +
    anti-affinity + pinning guardrails (Admin → Balancer). _Builds on:_ VM migration (#5) + the
    arch-aware placement guardrail. See Tier 3 above for the full description.

> **UI:** the admin **Usage** tab is now merged into **Users** (an in-page _Accounts / Usage_
> toggle), so cluster ops live under one fewer nav entry.
