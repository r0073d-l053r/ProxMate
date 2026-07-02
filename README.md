<div align="center">

![ProxMate Banner](docs/images/banner.png)

<br/>

<p>
  <a href="https://github.com/r0073d-l053r/ProxMate/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="License: AGPL v3"/></a>
  <img src="https://img.shields.io/badge/Node.js-20%2B-brightgreen" alt="Node.js 20+"/>
  <img src="https://img.shields.io/badge/Next.js-16-black" alt="Next.js 16"/>
  <img src="https://img.shields.io/badge/Proxmox%20VE-9%2B-e57000" alt="Proxmox VE 9+"/>
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?logo=docker" alt="Docker ready"/>
  <a href="https://github.com/r0073d-l053r/ProxMate/actions/workflows/ci.yml"><img src="https://github.com/r0073d-l053r/ProxMate/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
</p>

**A lightweight, invite-only cloud dashboard built on Proxmox VE.**

ProxMate gives you a DigitalOcean-style WebUI on top of your existing Proxmox cluster.
Hand out invite links with resource quotas, let users spin up VMs and LXC containers —
from an ISO, a template, or a one-click cloud image (paste an SSH key → a ready-to-SSH
box in ~60 s) — and access them via an in-browser console, all without exposing your
Proxmox admin panel.

[Quick start](#-quick-start) · [Features](#-features) · [Screenshots](#-screenshots) · [Production](#-production-deployment) · [Docs](#-documentation)

</div>

---

## ✨ Features

- 🔒 **Invite-only multi-tenancy** — invite links carry CPU/RAM/disk quotas; per-VM firewall keeps tenants off your LAN, your other guests, and the host
- 🖥️ **VMs & LXC containers** — create from an ISO, the Template Store, or 16 curated cloud images; resize, rebuild, rename, snapshots, power schedules, tags & bulk actions
- 🌐 **In-browser consoles** — graphical (noVNC) *and* a text console with clickable links, real copy/paste, and scrollback — no SSH, no open ports
- 🛡️ **Serious auth** — TOTP 2FA, passkeys (WebAuthn), bring-your-own OIDC SSO, SMTP password resets, optional invite-enforced 2FA
- 💾 **MateStates backups** — scheduled backups with rolling retention, one-click in-place restore, per-VM policies, quick snapshots
- ⚖️ **Cluster operations** — automatic VM placement, live migration, DRS-style memory balancer, maintenance node-drain, GPU/PCI passthrough requests
- 📈 **Operator visibility** — live admin monitor (1 Hz sparklines), rack-panel kiosk mode, audit log, Prometheus `/metrics`
- 🔄 **In-app updates** — check the latest GitHub release and one-click rebuild onto it

<details>
<summary><b>📋 Full feature matrix</b> — every feature, one table</summary>
<br/>

| Feature | Description |
|---|---|
| 🔒 **Invite-Only Registration** | Admin-generated invite links with CPU/RAM/Storage quotas, with optional **enforced 2FA** on registration |
| 🛡️ **Multi-Factor Auth (MFA/2FA)** | Secure accounts via TOTP (authenticator apps) with recovery codes, or passwordless **Passkeys (WebAuthn)** using biometric keys |
| 🔑 **Single Sign-On (OIDC SSO)** | Bring-your-own SSO (Keycloak, Authentik, etc.) with custom group-to-admin mapping and optional JIT user provisioning |
| ✉️ **SMTP & Password Recovery** | Email-based secure password resets, with a database-backed "contact admin" request queue if SMTP is disabled |
| 🖥️ **VM Lifecycle Management** | Create, start, stop, restart, **rename**, and delete VMs — each VM page has editable **notes**, an **activity timeline**, and **CPU/memory history charts**. The create wizard offers one-click **size presets** (Small → X-Large) |
| 📦 **LXC Containers** | Spin up lightweight **LXC containers** alongside full VMs — create from an OS template, start/stop/restart, in-browser console, tenant isolation, quotas, cpu/RAM/rootfs resize, and MateStates backups. Shares the host kernel, boots in seconds |
| ☁️ **Cloud-Init Deploys** | One-click cloud images (16 curated distros + custom URLs), imported entirely through the Proxmox API — paste an SSH key for a ready-to-SSH box in ~60s, with optional first-boot **Docker** / **Tailscale** installs. **Save SSH keys** to your profile and pick them on deploy |
| 📦 **Template Store** | Publish Proxmox templates as one-click OS builds — cloned and autoscaled on deploy, with OS-matched (or custom-uploaded) icons and admin-authored login notes |
| ⚖️ **Automatic VM Placement** | Tenants never pick a node — the scheduler auto-places each VM on a node that has the chosen image, with the most free capacity |
| 🔀 **Live VM Migration** | Admins move a VM to another cluster node with **no downtime** — live for running guests (incl. those on node-local storage), offline for stopped ones — and the VM's owner gets an emailed heads-up. Architecture-guardrailed (never x86↔ARM) |
| 🧭 **Cluster Balancer & Maintenance** | DRS-style **memory-load balancing** (recommend-only or auto) that live-migrates guests off the busiest node, plus one-click **maintenance node-drain** to evacuate a host before downtime — with anti-affinity (`aa:` tags) and pinning guardrails |
| 🎮 **GPU / PCI Passthrough** | Tenants request a GPU or other PCI device; admins review and attach an available device — with balancer/migration guardrails once attached |
| 🌐 **In-Browser Console** | A **graphical (noVNC)** console *and* an **xterm.js text console** with **Ctrl/⌘-clickable links**, real copy/paste, and scrollback — both proxied securely through the backend, no SSH or open ports |
| 💾 **MateStates Backups** | Scheduled weekly backups + one-click in-place restore, with rolling retention |
| 📸 **Quick Snapshots** | Instant Proxmox snapshots — take / roll back / delete, with optional RAM-state capture — for "before I change something" restore points (distinct from durable MateStates backups) |
| ⏰ **Power Schedule** | Auto start/stop any VM on a weekly schedule — handy for dev boxes that don't need to run overnight |
| 🔄 **In-App Updates** | Admins check the latest GitHub release, see what's new, and (opt-in) one-click rebuild + restart onto the new version |
| 📈 **Live Admin Monitor** | Per-VM CPU / memory / network sparklines at 1 Hz, with power controls, grouped by owner |
| 🖥️ **Kiosk Mode** | A full-screen, touch-friendly command center for a rack-mounted panel — cluster gauges, quorum tile, per-node strip, activity ticker |
| 🛡️ **Tenant Network Isolation** | Per-VM Proxmox firewall — MAC filtering, RFC1918 drop rules, and a configurable DNS allow-list — keeps guests off your LAN, your other VMs, and the host |
| 📝 **Audit Log** | Who created / deleted / restored / started which VM, plus sign-ins — an admin-viewable activity trail |
| 🚦 **Rate Limiting** | Built-in brute-force protection on the login / register / invite endpoints, plus per-account lockout with admin alerts |
| 📊 **Resource Quotas** | Users can only provision resources within their assigned limits — with a built-in quota-increase request workflow |
| 🧙 **First-Time Setup Wizard** | Guided OOBE to configure admin credentials and the Proxmox connection |
| 🐳 **Docker + CI** | Multi-stage production images, plus GitHub Actions CI (typecheck, tests, image builds) and an automated test suite |

</details>

<details>
<summary><b>🛠️ Tech stack</b></summary>
<br/>

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 16 (App Router), TailwindCSS v4, Shadcn/UI (Base UI), react-icons |
| **Backend** | Node.js, Express 5, `ws` (WebSocket relay), `express-rate-limit`, `node-cron`, `nodemailer` |
| **Database** | SQLite via Prisma ORM (migrations); PostgreSQL supported for scale-out |
| **Auth** | JWT + bcrypt, OIDC SSO (`openid-client`), Passkeys (`@simplewebauthn/server`), TOTP 2FA (`otplib`), SMTP |
| **Proxmox** | REST API with API Token authentication |
| **Console** | noVNC (graphical) + xterm.js (text) over a WebSocket proxy |
| **Testing / CI** | Vitest, Playwright, GitHub Actions (CodeQL, Trivy, SBOM) |

</details>

---

## 📸 Screenshots

<div align="center">

![ProxMate Dashboard](docs/images/screenshot-dashboard.png)
*Live cluster capacity and every virtual machine at a glance*

</div>

<details>
<summary><b>🖼️ More screenshots</b> — create wizard, Template Store, console, live monitor, setup (5)</summary>
<br/>
<div align="center">

### Create a VM
![ProxMate New VM Wizard](docs/images/screenshot-newvm.png)
*One wizard for custom (ISO), template, and cloud-init deploys — paste an SSH key and tenants are auto-placed on the best node*

### Template Store
![ProxMate Template Store](docs/images/screenshot-templates.png)
*Add cloud images in one click and publish ready-made OS builds — OS-matched icons, login notes, deploy in seconds*

### In-Browser Console
![ProxMate noVNC Console](docs/images/screenshot-console.png)
*A live, interactive noVNC session on your VM — copy/paste and Ctrl+Alt+Del, no SSH or open ports needed*

### Live Monitor
![ProxMate Admin Monitor](docs/images/screenshot-monitor.png)
*Per-VM CPU / memory / network sparklines at 1 Hz, with power controls*

### First-Time Setup
![ProxMate Setup Wizard](docs/images/screenshot-setup.png)
*Guided wizard to create the admin account and connect your Proxmox cluster*

</div>
</details>

---

## 🚀 Quick start

**Prerequisites:** Node.js 20+, a Proxmox VE cluster (tested on PVE 9.2), and a
[Proxmox API token](https://pve.proxmox.com/wiki/User_Management#pveum_tokens).

> ⚠️ **The #1 setup pitfall:** Proxmox creates API tokens with *Privilege Separation*
> enabled, which leaves the token with an **empty permission set** (even for `root`) —
> the connection test passes but storage lists come back empty and VM creation 403s.
> Uncheck it, or grant the token a role — see the
> [admin guide §1.1](./docs/admin-guide.md#11-create-the-api-token).

```bash
git clone https://github.com/r0073d-l053r/ProxMate.git
cd ProxMate

# Backend (Express API on :4000)
cd backend
npm install
cp ../.env.example .env        # edit if needed
npx prisma migrate deploy
npm run dev

# Frontend (Next.js on :3000) — second terminal
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000` — the **setup wizard** walks you through creating the
admin account, connecting Proxmox, and picking storage/network defaults. Then generate
invite links for your users from **Admin → Invites**.

---

## 🐳 Production deployment

```bash
cp .env.docker.example .env
openssl rand -hex 32           # → paste into ENCRYPTION_KEY in .env
docker compose up -d --build   # frontend :3000, API :4000
```

> **`ENCRYPTION_KEY` must stay constant** across restarts — it decrypts your stored
> Proxmox token and JWT secret. Back it up. `NEXT_PUBLIC_API_URL` is baked into the
> frontend at **build time**, so rebuild the frontend image if it changes.

For a real public deployment, serve ProxMate from a **single HTTPS origin** (passkeys,
`Secure` cookies, and OIDC SSO require it) behind Caddy / nginx / Traefik or a
Cloudflare Tunnel. The complete runbook — reverse-proxy topology, env reference,
tenant isolation, Keycloak SSO, SMTP, and the 2FA test matrix — is in
**[DEPLOYMENT.md](./DEPLOYMENT.md)**; the hardening guide is
**[SECURITY.md](./SECURITY.md)**.

---

## 🧪 Testing & CI

The backend ships a Vitest suite (~300 tests) covering the security-critical logic —
quotas, the per-VM firewall builder, placement, retention, ownership, balancer/drain
planning — against a mocked Proxmox API (no live cluster needed):

```bash
cd backend && npm test
```

Every push and PR runs [GitHub Actions](.github/workflows/ci.yml): backend typecheck +
tests, frontend lint + build, Playwright, and Docker builds of both images, plus a
separate [security workflow](.github/workflows/security.yml) (CodeQL, Trivy, SBOM).

---

## 📚 Documentation

All guides are also surfaced in-app under **Help & Docs**.

| Guide | Audience | What's inside |
|---|---|---|
| [Production runbook](./DEPLOYMENT.md) | Owners | HTTPS origin, Caddy/Cloudflare Tunnel, Keycloak SSO, SMTP, 2FA matrix, kiosk autostart |
| [Security guide](./SECURITY.md) | Owners | Tenant isolation model, cluster firewall step, least-privilege tokens, hardening checklist |
| [Admin guide](./docs/admin-guide.md) | Owners | Cluster prep, API tokens, isolation enforcement, cloud images, auth settings, troubleshooting |
| [External access overview](./docs/external-access.md) | Tenants | The "no port forwarding" rule and which tool fits each use case |
| [Tailscale for SSH](./docs/tailscale-ssh.md) | Tenants | SSH into your VM from anywhere, no public IP |
| [Cloudflare Tunnels](./docs/cloudflare-tunnels.md) | Tenants | Publish a public website from your VM without opening ports |
| [REST API & scaling](./docs/api.md) | Developers | Personal `pm_…` tokens, OpenAPI spec, `/metrics`, PostgreSQL |
| [Roadmap](./ROADMAP.md) | Everyone | Shipped, planned, and proposed features |
| [Architecture spec](./project-architecture.md) | Contributors | Full system design — request flows, schema, security model |

---

## 🤝 Community

Questions, ideas, or a homelab to show off? Join the
[Discussions](https://github.com/r0073d-l053r/ProxMate/discussions):
[Q&A](https://github.com/r0073d-l053r/ProxMate/discussions/categories/q-a) ·
[Ideas](https://github.com/r0073d-l053r/ProxMate/discussions/categories/ideas) ·
[Show & Tell](https://github.com/r0073d-l053r/ProxMate/discussions/categories/show-and-tell) ·
[General](https://github.com/r0073d-l053r/ProxMate/discussions/categories/general)
— and see the [Contributing Guide](CONTRIBUTING.md) for how to get involved.

---

## 📄 License

Copyright © 2026 Brandon Jewell.

ProxMate is **open core**:

- **Community Edition** (this repository) — free and open source under the **GNU Affero
  General Public License v3.0 (AGPLv3)**; see [LICENSE](./LICENSE).
- **EDU Edition** — organization-scale features for schools and institutions, offered
  under a separate [commercial license](./COMMERCIAL-LICENSE.md).

See [LICENSING.md](./LICENSING.md) for the full picture, including dual-licensing
options for businesses. "ProxMate" is a trademark of Brandon Jewell.

---

<div align="center">
  <sub>Built by the ProxMate team.</sub>
</div>
