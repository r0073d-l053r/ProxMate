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
- **Tags / projects + bulk actions** — group VMs for users who run several.

## Tier 2 — Notifications & sharing

- **Event notifications** — email + webhook (Discord / Slack / ntfy) alerts for backup
  failed, VM crashed / unexpectedly stopped, quota near limit, and account lockout.
  (SMTP exists today but is used only for password reset.)
- **Share a VM** with another tenant — co-owner or read-only console access.

## Tier 3 — API & scale

- **Public REST API + per-user API tokens** — unlocks a CLI and a Terraform provider
  (everything is UI-only today).
- **OpenAPI / Swagger spec** for the existing routes.
- **PostgreSQL option** — SQLite caps the app at single-instance / ~100 users; add or
  document a Postgres path for HA.

## Tier 4 — Reliability & observability

- **Structured logging** (pino) + request-correlation IDs.
- **Deep health / readiness checks** — extend `/api/health` to verify DB + Proxmox
  reachability.
- **Prometheus `/metrics`** endpoint (vm_count, proxmox_api_errors, request latency).
- **Proxmox API timeouts + retry/backoff** — calls currently have no timeout, so a hung
  Proxmox can leak requests.
- **Rate-limit all mutating endpoints** — limiting covers auth only; a tenant can
  currently spam `POST /api/vms`.

## Tier 5 — Test & developer experience

- **Playwright E2E** (register → deploy → console) and **frontend unit tests**.
- **Backend ESLint + Prettier**, Vitest coverage gates.
- **CI security scanning** — CodeQL / Trivy / `npm audit` + SBOM generation.

## Optional / larger bets

- **LXC container support** — the isolation model already extends to it.
- **Built-in public ingress** — a managed reverse proxy / per-VM Cloudflare tunnel so
  tenants get `name.proxmate.example.com` without manual setup.
- **GPU / PCI passthrough requests.**
