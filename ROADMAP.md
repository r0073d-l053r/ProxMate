# ProxMate Roadmap

A living, prioritized list. ProxMate is a mature, production-ready multi-tenant Proxmox dashboard
(live at proxmate.myhomelab.pro) — this roadmap is about **closing cloud-provider parity gaps,
hardening for scale, and the EDU/commercial layer**, not fixing breakage. Tiers are rough priority
bands, not commitments. Have an idea? Open a
[discussion](https://github.com/r0073d-l053r/ProxMate/discussions/categories/ideas).

The detailed, dated log of everything already built lives in [`completed-tasks.md`](completed-tasks.md).
This file leads with **what's still open**, then **new ideas**, then a condensed **shipped** index.

---

## 🔜 Open — up next (pulled to the top)

### In flight

- **Tenant controls & admin management pack (v0.8.0, in testing).** Built + on branch
  `feat/tenant-admin-controls`, deployed to musebot for live testing; not yet released. Adds:
  share **permission presets** (Viewer / Operator / Manager), **admin deploy-for-tenant** (into a
  chosen tenant's account, optional node pin, optional quota-exempt grant), **admin-managed VMs are
  resize-locked to admins**, tenant **activity feeds hide admin actions**, **IDE one-click relocate**
  to an AVX-capable node, and **custom AI-key endpoints restricted to admins**. Breaking: share
  `access` values renamed; tenants lose raw-API node pinning + shared-VM rebuild/passthrough.

### IDE follow-ups (v0.7.0 deferred)

- ✅ **Admin Settings field for `ide_ingress_cidr` + reachability test — BUILT (in testing).**
  Validated CIDR field in Admin → Settings → ProxMate IDE, plus a "Test reachability" button that
  dials a running VM's IDE port from the backend (the proxy's exact path) and names the likely
  cause on failure.
- ✅ **Pin code-server / OpenCode installer versions — BUILT (in testing).** The bootstrap installs
  exactly the live-verified pair (code-server 4.128.0 / OpenCode 1.17.18), overridable via
  `IDE_CODE_SERVER_VERSION` / `IDE_OPENCODE_VERSION`.
- **Wire the gateway as a provider for code-server's built-in Chat view** (inert today; OpenCode
  runs as a terminal TUI instead).
- **Surface the in-guest provision log** — an `ideState: failed` today means shelling into the guest
  to read `/var/log/pmide-provision.log`; add a "view install log" action (owner/admin, via the guest
  agent) on the failed state so installs are debuggable from the browser.

### Production hardening & ops

- ✅ **Scheduled app-DB backup — BUILT (in testing).** Nightly `VACUUM INTO` snapshot of ProxMate's
  own database to an admin-configured directory (point it at an off-host mount), rolling retention,
  "Back up now" verification button in Admin → Settings.
- **`ENCRYPTION_KEY` loss-safety** — losing the key means losing the Proxmox token, SMTP creds,
  tenant AI keys, and TOTP secrets in one stroke. The docs runbook now pairs key backup with DB
  backups explicitly; still open: an admin Settings warning that persists until the key is
  confirmed backed up.
- **Production validation passes** — the shipped OIDC SSO flow and the full 2FA/passkey matrix
  (TOTP, recovery codes, passkeys, invite-enforced 2FA) each need a documented end-to-end QA pass
  on a live deployment.

### v0.8 pack follow-ups

- ✅ **Size-lock extended to rebuild — BUILT (in testing).** A tenant rebuild of an admin-managed /
  quota-exempt VM is 403'd (it wipes the admin's deployment, and template disk growth would bypass
  quota on exempt grants); both Rebuild UI surfaces hidden for non-admins.
- ✅ **Resize/rebuild quota billed to the OWNER — BUILT (in testing).** A Manager-share resize is
  now checked against the owner's caps + usage (`quotaAccountFor`), not the caller's; admin bypass
  unchanged; data disks already resolved the owner.
- **Notify the tenant on admin deploy-for-tenant** — a granted VM just appears in their account
  today; send the branded "you've been granted a VM" email + in-app note.
- **Share notifications** — email the recipient when a VM is shared with them or their preset level
  (Viewer / Operator / Manager) changes.
- **Surface admin-managed / quota-exempt to the owner** — a badge + one-line explainer on the VM
  detail ("set up by your admin — only an admin can resize it") instead of just the 403 on attempt.

### Recorded follow-ups

- **Read-only console (input-blocked viewing)** — a Viewer share gets no console today; the noted
  follow-up is a view-only, input-blocked console stream.
- **Node-drain migratability guard** — the balancer's migrate planner reads Proxmox's `allowed_nodes`
  preflight and pins un-migratable guests; apply the *same* guard to the **node-drain** planner so it
  can't propose an impossible evacuation (its apply error is already legible).
- **Resize/rebuild quota vs owner** — a Manager-share resize is checked against the *caller's* quota
  while the footprint counts against the *owner*. Load the owner's account for the quota check when
  caller ≠ owner.
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
4. **Projects (tag rollups).** Tags exist per-VM; add a **project view** that groups a tenant's VMs by
   a `project:<name>` tag with a per-project resource + cost rollup and bulk actions scoped to the
   group. Low-risk, high polish. _CE._
5. **Guest-agent file push.** Reuse the exact trust model as password-reset / SSH-key-inject (QEMU
   guest agent, argv-safe) to let an owner upload a small file into a VM (e.g. a config or starter
   script) from the browser — no SSH. Size-capped, owner/Manager only. _CE._
6. **More notification channels.** The webhook engine supports Discord/Slack/Mattermost/generic; add
   **ntfy** and **Telegram** presets, plus a weekly per-tenant **usage digest** email. _CE._
7. **Two-person approval for destructive admin actions.** Optional policy: a second admin must confirm
   a bulk-delete / node-drain / firewall-disable before it runs. Rides the existing audit log. _EDU._
8. **Status page / scheduled reports.** A lightweight public/authed status page (node health, capacity,
   incidents) and optional scheduled admin reports (capacity trend, top consumers) off the existing
   `ResourceSample` + cluster-health data. _EDU._

---

## ✅ Shipped — condensed index

Full detail + dates in [`completed-tasks.md`](completed-tasks.md).

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
