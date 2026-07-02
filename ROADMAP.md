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
  - **Maintenance mode (node drain)** ✅ — before taking a node down, evacuate every
    ProxMate-managed guest off it (`POST /api/admin/balancer/drain` → plan; reuses `/balancer/apply`):
    auto best-fit placement **or** bulk-migrate all to one chosen target, running guests **live** (no
    downtime), stopped guests offline — same arch + anti-affinity guardrails. Unmanaged/foreign guests
    are flagged for manual handling. _Done._
  - **Live migration on local storage + owner heads-up** ✅ — migration now passes
    `--with-local-disks`, so a running guest on node-local storage (local-lvm / ZFS) live-migrates
    (disk copied during the move) instead of being refused; a no-op on shared storage. Every
    admin-initiated move (manual or drain) emails the VM's **owner** a branded heads-up ("maintenance
    — brief momentary blip"); routine auto-balancing stays silent. _Done._

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

- **LXC container support** ✅ — create and manage **LXC containers** alongside VMs:
  create from an OS template, start/stop/restart, noVNC + text console, tenant
  isolation, quota, cpu/ram/rootfs resize, and MateState backups. Live migration,
  extra data disks, snapshots, and cloud-init extras stay VM-only (the balancer
  treats containers as pinned and flags them on a node drain). _Done (v0.4.0)._
- **Built-in public ingress** — **documented self-service** (`docs/cloudflare-tunnels.md`),
  **not automated**. Automating it collides with the API-only + tenant-isolation model:
  it would need DNS automation plus a path into isolated tenant networks (or cloudflared
  installed inside each guest, which ProxMate can't reliably do). Left as a documented
  manual setup.
- **GPU / PCI passthrough requests** ✅ — a **request → admin-attach workflow** (mirrors
  the quota-request flow): a tenant requests GPU/PCI passthrough for a VM they own → an
  admin reviews and attaches an available Proxmox **PCI resource mapping**
  (`hostpciN: mapping=<name>`), or denies. Host VFIO/IOMMU setup + defining the mapping
  stays the admin's job (API-only, documented). Attaching requires the VM stopped; a
  passthrough VM can't be live-migrated, so the balancer skips it (pinned) and a node
  drain flags it. QEMU-only. _Done (v0.4.1)._

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

## The v0.5 arc — planned 2026-07-02

Reviewed with the owner; in progress. Continues the DigitalOcean-parity push for tenants.

**Console & UX batch (in progress):**

- **Console power actions** — an Actions menu on the console page (start / pause / resume /
  restart / shutdown / force stop) so you never leave the terminal to manage the machine.
  Pause/resume = QEMU suspend (new `POST /api/vms/:id/pause` + `/resume`).
- **Pop-out text console** — the xterm console in its own chromeless window, with a
  **"Keep on top"** floating mode (Document Picture-in-Picture, Chrome/Edge) so the
  terminal stays visible over other windows. Real copy/paste throughout.
- **Live Insights** — the per-VM metrics view gains a **Live** mode ticking every second
  (rolling window, y-axis zoomed to the activity); Day/Week stay on Proxmox RRD history.
- **OS logos** on the VM list and detail pages; **typed-name delete confirmation** with a
  download-your-backups warning.

**Feature slate (planned):**

1. **Per-VM resource alerts** ✅ — tenant-set thresholds (CPU %, memory %, disk-full via the
   guest agent, unexpected stop) with a sustained-duration + cooldown state machine, delivered
   as a branded email to the VM owner + the admin webhook, evaluated on the existing 5-minute
   sampling tick (no extra Proxmox calls). Managed from an **Alerts** card on the VM Settings tab.
   _Done._
2. **Rescue mode** — one-click boot from an admin-designated rescue ISO with an
   "exit rescue" that restores the original boot order (QEMU).
3. **Reset guest password** — via the guest agent's dedicated `set-user-password` call
   (QEMU + agent), for locked-out users on key-only cloud images.
4. **Duplicate VM** — self-service clone of your own (stopped) VM: quota-checked,
   auto-placed, isolation firewall before first boot.
5. **Cloud image freshness** — per-template refresh + optional monthly schedule:
   re-import the upstream cloud image as a new template and repoint the store entry, so
   new deploys always boot a patched base (superseded templates kept until clone-free).
6. **Backup download links** — when the deployment mounts the backup share
   (`BACKUP_DOWNLOAD_DIR`), tenants can request a MateState download and receive a
   **single-use, expiring link by email**. (Direct vzdump streaming stays impossible in
   the API-only model — see candidate idea #4.)
