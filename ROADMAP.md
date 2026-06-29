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

Fresh ideas for future updates. Each builds on something already shipped; roughly
ordered high-value/low-risk → larger bets.

1. **Usage-based billing & showback.** Turn the v0.3.1 `ResourceSample` history into
   per-tenant monthly cost/showback reports (configurable $/vCPU-hr, $/GB-RAM, $/GB-disk)
   with CSV/PDF export. _Builds on:_ per-tenant resource history. Natural fit for the EDU /
   commercial edition.
2. **Ephemeral / TTL VMs (auto-expiry).** A VM (or an invite's VMs) gets a lifetime —
   auto-stop, then auto-delete at expiry, with warning emails first. Ideal for classes,
   labs, and demos. _Builds on:_ invites + power schedules + notifications.
3. **Tenant self-service firewall rules.** Let tenants open specific inbound ports on their
   own VMs within an admin-set allow-list (ports/protocols), layered on the existing per-VM
   Proxmox firewall. _Builds on:_ the tenant-isolation model.
4. **Off-cluster backup targets (S3 / restic) + restore-elsewhere.** Push MateStates to
   object storage or a remote restic repo for real disaster recovery, plus download. _Builds
   on:_ MateStates. Removes the single-cluster-failure risk.
5. **VM migration between nodes.** Admin-triggered live/offline migrate to another cluster
   node (Proxmox `migrate`) for balancing and maintenance/drain. _Builds on:_ the arch-aware
   placement guardrail.
6. **Custom cloud-init user-data editor.** A validated field for extra cloud-init (packages,
   `runcmd`) at create time, beyond the SSH-key + Docker/Tailscale toggles. _Builds on:_
   cloud-init deploys.
7. **Additional data disks / volume management.** Attach / detach / resize extra disks per
   VM, not just grow the root. _Builds on:_ live resize.
8. **Quota-increase request workflow.** A tenant requests more quota → an admin approves or
   denies in-app (notified + audited), instead of out-of-band asks. _Builds on:_ editable
   quotas + notifications.
9. **Push live updates over WebSocket.** Replace the dashboard/monitor polling with a single
   cluster poll fanned out to all clients as state/stat deltas — lower Proxmox load and
   latency. _Builds on:_ the console-WS infra + the `/admin/live-stats` cache.
10. **Audit-log retention, export & SIEM streaming.** Configurable retention/pruning, CSV/JSON
    export, and optional streaming of audit events to a SIEM/webhook for compliance. _Builds
    on:_ the audit log (its note already flags "log retention") + the notification webhook.
