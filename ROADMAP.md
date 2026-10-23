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

### Placement & reliability

- **Background reconciler for Proxmox tasks.** A create that *fails* is already handled (the machine
  is held and its page says why). The gap is a backend *restart* in the middle of a create, restore
  or rebuild: the rest of that work is lost, and the status sync deliberately skips rows still in
  `creating`, so the machine stays `creating` forever. A startup and periodic sweep that inspects
  Proxmox and settles each stuck row closes it; the passthrough startup recovery
  (`reconcileInterruptedPassthroughApplies`) is the pattern to follow.
- **First-class Postgres support.** The Prisma schema is portable but the shipped migration history
  is SQLite-locked (`migration_lock.toml`), and the built-in app-DB backup uses SQLite's
  `VACUUM INTO`. Postgres today means `db push` + `pg_dump`; proper support wants a migration
  history and a backup path of its own. SQLite stays the default.

### Production hardening & ops

- **`ENCRYPTION_KEY` loss-safety.** Losing the key means losing the Proxmox token, SMTP creds,
  tenant AI keys, and TOTP secrets in one stroke. The docs runbook pairs key backup with DB backups
  explicitly, and the app-database backup card already carries a static reminder. Still open: an
  admin warning that stays visible until an admin confirms the key is backed up.
- **Pool-scoped Proxmox token (optional).** The `ProxMate` role is granted on `/`, because placement,
  migration and the balancer work across every node, so the per-guest boundary today is ProxMate's
  ownership-tag check rather than a Proxmox permission. Offer a mode where the role is granted on a
  Proxmox resource pool instead: ProxMate puts every guest it creates, clones or restores into that
  pool, and Proxmox itself denies the token any guest outside it. Needs the node, storage and SDN
  paths the role still requires outside the pool worked out, a connection-test check that the pool
  exists, and `deploy/proxmox-token.sh` support.
- **Production validation passes.** The shipped OIDC SSO flow and the full 2FA/passkey matrix
  (TOTP, recovery codes, passkeys, invite-enforced 2FA) each need a documented end-to-end QA pass
  on a live deployment.

### Tenant-experience follow-ups

- **Notify the tenant on admin deploy-for-tenant** — a granted VM just appears in their account
  today; send the branded "you've been granted a VM" email + in-app note.
- **Share notifications** — email the recipient when a VM is shared with them or their preset level
  (Viewer / Operator / Manager) changes.
- **Surface admin-managed / quota-exempt to the owner** — partly built: the disks panel already says
  the VM was set up by an admin and its disks can't be changed here. Still open: a page-level badge
  and one-line explainer on the VM detail, since resize and rebuild are otherwise just hidden.

### IDE follow-ups

- **Wire the gateway as a provider for code-server's built-in Chat view** (inert today; OpenCode
  runs as a terminal TUI instead). Needs a decision first: the IDE settings deliberately turn the
  built-in chat off so OpenCode is the focus.

### Mobile

- **Android app.** A native app: enter the server's web address, sign in (including 2FA; SSO and
  passkeys through the web login), then the full ProxMate UI with the session carried over. Built
  on GitHub Actions so the APK can be downloaded from each run.

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

1. **Adopt an existing (unmanaged) Proxmox VM.** ProxMate only manages guests it created. An
   admin-only **import** flow would let an operator onboard an existing cluster: pick an unmanaged
   guest, assign an owner + quota accounting, apply the per-VM isolation firewall, and start managing
   it — no rebuild. Closes the biggest "I already have VMs" adoption gap. _CE._
2. **Bulk deploy from a template (class provisioning).** Deploy *N* VMs from one template in a single
   action — for a tenant, or one-per-tenant across a selected group — each auto-placed and
   isolation-firewalled. The concrete primitive behind EDU "assignment templates." _CE primitive, EDU UX._
3. **Auto-snapshot before risky ops.** Optionally take a snapshot right before a rebuild/resize/rescue
   (QEMU) so a bad change is one rollback away. Snapshots already exist; this just wires a safety net
   into the destructive paths, with a retention cap. _CE._
4. **More notification channels.** The webhook engine supports Discord/Slack/Mattermost/generic; add
   **ntfy** and **Telegram** presets, plus a weekly per-tenant **usage digest** email. _CE._
5. **Two-person approval for destructive admin actions.** Optional policy: a second admin must confirm
   a bulk-delete / node-drain / firewall-disable before it runs. Rides the existing audit log. _EDU._
6. **Status page / scheduled reports.** A lightweight public/authed status page (node health, capacity,
   incidents) and optional scheduled admin reports (capacity trend, top consumers) off the existing
   `ResourceSample` + cluster-health data. _EDU._

---

## ✅ Shipped — condensed index

Full detail + dates in [`completed-tasks.md`](completed-tasks.md).

### Unreleased

- **Number fields can be cleared and retyped.** Emptying a numeric field no longer leaves a stuck
  `0` that turns the next digit into "02"; min/max apply when the field loses focus.
- **Projects (tag rollups).** A **Projects** page groups a tenant's VMs by a `project:<name>` tag:
  VM and running counts, allocated vCPU/RAM/disk and average CPU/RAM use from the usage samples per
  project, with start/stop/restart for the whole project through the existing bulk route. Set a
  project on the VM page or with **Move to project…** on the VM list (owner/admin only). VMs shared
  with you are listed apart, without their owner's tags; admins see every owner's projects.
- **View-only console for Viewer shares.** A Viewer share can watch a VM's graphical and text
  consoles. The relay enforces it: it parses the browser's RFB and termproxy streams and drops
  every keyboard, mouse, clipboard, resize-desktop and power message before Proxmox sees it, and
  forces a shared VNC session so a viewer never disconnects anyone else. Console opens are audited
  (`vm.console_open`, or `vm.console_view_open` for a view-only session).
- **View the IDE install log.** While the IDE installs, or after it failed, the VM's owner (or an
  admin) opens **View install log**: the tail of `/var/log/pmide-provision.log` read through the
  guest agent with a fixed command, cleaned of terminal control codes, with refresh and download.
- **Push a file into a VM.** Owner, admin or Manager share (the `configure` capability, like SSH-key
  add) uploads a small file (1 MiB default, up to 8 MiB via `GUEST_FILE_PUSH_MAX_BYTES`) to a strictly
  validated path with a chosen mode and owner, through the guest agent; audited with path, size and
  SHA-256, rate-limited per user. QEMU only.

### Released

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
