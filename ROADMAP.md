# ProxMate Roadmap

A living, prioritized list. ProxMate is a mature, production-ready multi-tenant Proxmox dashboard
running in production — this roadmap is about **closing cloud-provider parity gaps and
hardening for scale**, not fixing breakage. Tiers are rough priority bands, not commitments. Have an
idea? Open a [discussion](https://github.com/r0073d-l053r/ProxMate/discussions/categories/ideas).

The detailed, dated log of everything already built lives in [`completed-tasks.md`](completed-tasks.md).
This file leads with **what's still open**, then **new ideas**, then a condensed **shipped** index.

---

## 🔜 Open — up next (pulled to the top)

### Live-cluster checks (lab session)

- **Verify the least-privilege role on Proxmox VE 8.** `deploy/proxmox-token.sh` was run end to end
  on a Proxmox VE 9.2 cluster with every feature passing. The PVE 8 variant (`VM.Monitor` instead of
  the `VM.GuestAgent.*` privileges) has not been run on real hardware yet.
- **Restore of an archive that names another guest's disk.** Restores refuse any disk that isn't the
  guest's own; covered by tests, not yet exercised against a real archive on a live cluster.
- **Guest owner check on delete.** Delete confirms the guest carries the machine's own ownership tag;
  covered by tests, not yet exercised on a live cluster. Both checks refuse when in doubt.

- **Pool-scoped token end to end.** `deploy/proxmox-token.sh --pool` on PVE 8.0, 8.1 and 8.2+ and
  PVE 9: confirm Proxmox refuses the token on a guest outside the pool while every feature works inside
  it, and that the restart reconciler can read every node's task list with that token.
- **v1.3.0 features on real hardware.** Android consoles over a pinned self-signed certificate,
  view-only consoles (no input reaches the guest), file push on Debian and Alpine guests, upload
  restore in pool mode, backend restarts mid-create and mid-restore, and automatic snapshots on
  LVM-thin and ZFS.

### Placement & reliability

- **First-class Postgres support.** The Prisma schema is portable but the shipped migration history
  is SQLite-locked (`migration_lock.toml`), and the built-in app-DB backup uses SQLite's
  `VACUUM INTO`. Postgres today means `db push` + `pg_dump`; proper support wants a migration
  history and a backup path of its own. SQLite stays the default.

### Production hardening & ops

- **Pool mode: recovering a machine whose guest is gone.** With a pool-scoped token, a guest's
  backups leave the pool when the guest is destroyed, so a rebuild that fails after destroying the
  old guest leaves backups the token cannot list or restore (root can). Keep the old guest until the
  new one exists, or give rebuild a restore path that works before the VMID is back in the pool.
- **Production validation passes.** The shipped OIDC SSO flow and the full 2FA/passkey matrix
  (TOTP, recovery codes, passkeys, invite-enforced 2FA) each need a documented end-to-end QA pass
  on a live deployment.

### IDE follow-ups

- **Wire the gateway as a provider for code-server's built-in Chat view** (inert today; OpenCode
  runs as a terminal TUI instead). Needs a decision first: the IDE settings deliberately turn the
  built-in chat off so OpenCode is the focus.

### Mobile

- **Android release signing and store listing.** The app ships in v1.3.0 as a debug build from CI; a
  signed release APK is built on version tags once the four `ANDROID_*` signing secrets are set.
  Still open: set those secrets, and decide on a Play Store or F-Droid listing.

### Deferred pending hardware

- **ARM guest builds (Phase 2).** The arch-aware *placement* guardrail shipped; building an ARM VM
  doesn't yet set the ARM-specific Proxmox settings. The aarch64 VM-build path (`arch=aarch64`, `machine=virt`, OVMF + EFI disk) and an arch selector need a real ARM
  (Pimox) node to validate.
- **The GPU on pve-4 (host project)** — the host is vfio/IOMMU-ready and the card is bound; running it
  needs a fresh **q35 + OVMF + EFI-disk** VM (108 was installed under SeaBIOS). Owner's call when wanted.

### EDU / commercial layer (post-CE)

- **Usage-based billing & showback** — turn the `ResourceSample` history into per-tenant monthly
  cost/showback reports (configurable $/vCPU-hr, $/GB-RAM, $/GB-disk) with CSV/PDF export.
- **Ephemeral / TTL VMs (auto-expiry)** — a VM (or an invite's VMs) gets a lifetime: auto-stop, then
  auto-delete at expiry, with warning emails first. Builds on invites + power schedules + notifications.
- **IDE institutional layer** — instructor dashboards (visibility into student IDE sessions/activity),
  per-class + per-student LLM-gateway quotas + token budgets, **assignment templates**
  (pre-provisioned VMs with IDE + starter repos), bulk provisioning, LMS/roster + SCIM, support + SLAs.

---

## 💡 New ideas — proposed 2026-07-11

Fresh proposals; none built yet. Each stays inside the API-only + tenant-isolation model.

1. **Two-person approval for destructive admin actions.** Optional policy: a second admin must confirm
   a bulk-delete / node-drain / firewall-disable before it runs. Rides the existing audit log. _EDU._
2. **Status page / scheduled reports.** A lightweight public/authed status page (node health, capacity,
   incidents) and optional scheduled admin reports (capacity trend, top consumers) off the existing
   `ResourceSample` + cluster-health data. _EDU._

---

## ✅ Shipped — condensed index

Full detail + dates in [`completed-tasks.md`](completed-tasks.md).

### Unreleased

_Nothing yet._

### Released

- **v1.3.0 — projects, Android, notifications and reliability.** Projects with per-project usage and
  power actions; a native Android app; view-only consoles for Viewer shares; the IDE install log and
  file push through the guest agent; tenant emails, ntfy/Telegram and a weekly usage digest; importing
  existing Proxmox guests and bulk deploys from a template; restored backups checked before use;
  interrupted operations settled after a restart; automatic snapshots before risky changes; an
  `ENCRYPTION_KEY` backup reminder; and an optional pool-scoped Proxmox token (not yet verified on a
  live cluster).

- **v1.2.0 — sharing, placement and least privilege.** Share a VM with someone before they sign
  up (pending shares, claimed only by a confirmed address); template deploys on shared storage
  spread across nodes, respecting the cloud-init snippet storage; `deploy/proxmox-token.sh` for a
  least-privilege Proxmox token, verified on a 7-node PVE 9.2 cluster, and a connection test that
  checks every privilege ProxMate uses; start and restart wait for Proxmox like stop.
- **v1.1.1 — follow-up.** Personal API tokens of an account whose access window has ended answer
  `403 access_expired`; Compose forwards `ALERT_COOLDOWN_MIN` and the public-token rate-limit
  settings; non-numeric `PORT` / `RESTORE_UPLOAD_MAX_GB` fall back to defaults; the access-expiry
  sweep is covered by tests.
- **v1.1.0 (2026-10-19) — security and reliability release.** A full code review, every finding closed:
  **guest ownership tags** gate every guest action (existing guests tagged on upgrade, admin
  **Unconfirmed machines** card for the rest); **owner-only IDE** with per-machine guest proof;
  hardened sign-in (concurrent-safe lockout, per-account 2FA limits, server-side passkey
  challenges, single-use links and codes); session-only account-security routes; verified-email SSO
  linking; allowlisted upload restores with disk-ownership checks; quota-safe concurrent changes;
  **SDN VNet and OVS bridge discovery** (#126); stop waits for Proxmox's verdict; delta resize; a
  safer host updater with compose overrides; Node 22 images.
- **v1.0.0 (2026-08-11) — isolation milestone.** Per-tenant **VLAN placement** (network-layer
  isolation beyond the per-VM firewall) + rogue-DHCP and IPv6-RA egress drops + firewall rule
  reconciliation; **cloud-init passwords applied in-guest** via the QEMU guest agent (never written
  to the seed drive); compute-access windows enforced on **passkey and SSO** login, not only
  password; template deploys honour the admin default bridge/storage; built cloud-image templates
  ship `qemu-guest-agent` (agentless builds recorded and flagged); the connection test rejects a
  privilege-separated token that can authenticate but do nothing; axios client error objects are
  sanitized before logging; a minimal **module seam** (`PROXMATE_MODULES`) for mounting optional API
  routers; `deploy.agent_missing` notification; an admin storage-pinning/migratability report.
- **v0.9.0 / v0.9.1 (2026-08-01/02) — the installer arc.** One-command `install.sh` (dependency
  bootstrap incl. Docker with explicit consent, LAN-IP autodetect, `--domain` mode, safe re-run over
  an existing install), verified end-to-end on clean hardware; plain-HTTP CSP fix (+ scheme
  detection behind proxies); **migration guardrails** in preflight (`cpu=host` across heterogeneous
  CPU models, missing `cicustom` snippet storage on the target); placement/migration diagnostics;
  app-DB backups fixed for `sudo` installs (backup dir ownership); `.gitattributes` pins LF so a
  CRLF commit can't ship a dead installer.
- **v0.8.x (2026-07-16 → 07-29) — tenant controls + admin management + kiosk.** Share **permission
  presets** (Viewer / Operator / Manager), **admin deploy-for-tenant** (node pin, optional
  quota-exempt), admin-managed VMs **resize/rebuild-locked** to admins, Manager-share resizes billed
  to the **owner's** quota, tenant activity feeds hide admin actions, IDE one-click **relocate** to
  an AVX-capable node, custom AI-key endpoints admin-only; **compute access windows**
  (invite-granted terms, suspend-never-delete, warning emails, enforcement across every auth path);
  tabbed admin Settings; kiosk mode locked to **monitoring-only** with exit-gate hardening;
  **scheduled app-DB backups** (nightly `VACUUM INTO`, rolling retention, host-directory support via
  `PROXMATE_BACKUP_DIR`); `ide_ingress_cidr` admin field + reachability test; pinned
  code-server/OpenCode installer versions.
- **v0.7.0 — ProxMate IDE (beta).** In-browser code-server + OpenCode AI agent installed natively in
  each tenant VM; per-VM LLM gateway (allow-list, per-VM tokens, streaming, two-layer rate limiting);
  managed isolation-consistent `:8080` firewall pinhole; min-spec guardrails (RAM floor, `cpu:host`/AVX);
  install + cloud-init **deploy locks**; `DEPLOY_WITH_CLAUDE.md` agent-guided deploy runbook. Off by
  default. See `docs/proxmate-ide.md`.
- **v0.6.x — GPU/PCI passthrough hardening + cluster ops.** Passthrough request→admin-attach workflow
  with auto-migration to the device's node, live migration progress bar, and a pre-flight
  host-readiness check (won't auto-start a GPU unless q35+OVMF — after two live node wedges);
  migratability-aware balancer planning + migrate picker; backend security-hardening pass (SSRF guards,
  fail-closed secrets, `/metrics` 404-in-prod, gateway rate limiting).
- **v0.5.0 — tenant-experience arc.** Console power actions + pop-out/keep-on-top terminal, live
  Insights, reset guest password, rescue mode, per-VM resource alerts, duplicate VM, cloud-image
  freshness/auto-refresh, single-use backup download links.
- **v0.4.x — LXC containers + passthrough requests.** Create/manage LXC alongside VMs (console,
  isolation, quota, resize, backups; balancer pins them); GPU/PCI passthrough request workflow.
- **v0.3.x — sharing, scale & ops.** Share-a-VM (roles), public REST API + `pm_…` tokens + OpenAPI,
  Cluster Balancer (DRS-style, memory-based, recommend→auto) + node-drain maintenance mode, VM
  migration between nodes, extra data disks, quota-increase requests, live SSE stats, per-tenant
  resource history, admin broadcast email, cloud-init "extras" + on-demand snippet writing.
- **v0.2.x — core platform.** Template Store + auto-scaling deploy, MateStates backups + retention,
  secure external access (Cloudflare Tunnel / Tailscale, zero port-forwarding), admin monitor,
  unified new-VM wizard, tags + bulk actions, event notifications, branded transactional email +
  admin email invites, live resize/rebuild/per-VM backup policy.
- **Cross-cutting (done).** Structured logging (pino) + request IDs, deep health checks, Prometheus
  `/metrics`, Proxmox retry/backoff on idempotent reads, write rate-limiting, Playwright E2E +
  Vitest/RTL, ESLint/Prettier, CI security scanning (CodeQL/Trivy/npm-audit/SBOM), append-only audit
  log, TOTP 2FA + passkeys + OIDC SSO, invite-enforced 2FA, AGPL open-core licensing (CE + CLA).

### Explicitly declined / not feasible (kept for the record)

- **Tenant self-service firewall rules** — declined by the owner (curated presets could revisit it).
- **Audit-log retention/export/SIEM streaming** — declined by the owner.
- **Custom cloud-init user-data editor** — dropped (arbitrary user-data needs a host snippet file the
  API can't write).
- **Automated public ingress** — left as documented manual setup (collides with API-only + isolation).
- **S3/restic backup targets** — not feasible (Proxmox has no API to read vzdump bytes; NFS/CIFS/PBS
  remote storage covers off-cluster backups instead).
