# 🚀 ProxMate

**A lightweight, invite-only cloud dashboard built on Proxmox VE.**

ProxMate gives you a DigitalOcean-style WebUI on top of your existing Proxmox cluster. Generate invite links with resource quotas, let users spin up VMs, and access them via an in-browser noVNC console — all without exposing your Proxmox admin panel.

---

## Features

- **Invite-Only Registration** — Admin-generated invite links with CPU/RAM/Storage quotas baked in
- **VM Lifecycle Management** — Create, start, stop, restart, and delete VMs from a sleek dashboard
- **In-Browser Console** — noVNC remote access directly in the browser, proxied securely through the backend
- **Resource Quotas** — Users can only provision resources within their assigned limits
- **First-Time Setup Wizard** — Guided OOBE to configure admin credentials and Proxmox connection
- **Open Source** — Self-host on any server with access to your Proxmox cluster

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 (App Router), TailwindCSS v4, Shadcn/UI (Base UI) |
| Backend | Node.js, Express 5, `ws` (WebSocket relay) |
| Database | SQLite via Prisma ORM |
| Auth | JWT + bcrypt, invite-token system |
| Proxmox | REST API with API Token authentication |
| Console | noVNC WebSocket proxy |

## Getting Started

### Prerequisites

- **Node.js** 20+ and **npm**
- **Proxmox VE** cluster with API access (tested against PVE 9.2)
- A **Proxmox API Token** ([how to create one](https://pve.proxmox.com/wiki/User_Management#pveum_tokens))

> ⚠️ **Important — API token permissions.** Proxmox creates API tokens with **Privilege Separation enabled** by default, which gives the token an *empty* permission set (even for `root`). ProxMate needs the token to actually have privileges, so either **uncheck "Privilege Separation"** when creating the token, or grant the token a role:
> ```bash
> # Option A: disable privilege separation (simplest)
> pveum user token modify root@pam proxmate --privsep 0
>
> # Option B: keep privsep, grant the token Administrator on /
> pveum acl modify / --tokens 'root@pam!proxmate' --roles Administrator
> ```
> Symptoms of a privilege-separated token: the connection test passes but storage lists come back empty and VM creation fails with a 403.

### Installation

```bash
# Clone the repo
git clone https://github.com/your-org/proxmate.git
cd proxmate

# Install backend dependencies
cd backend
npm install
cp .env.example .env  # Edit with your settings
npx prisma db push    # Create the SQLite database

# Install frontend dependencies
cd ../frontend
npm install

# Start both servers (in separate terminals)
cd ../backend && npm run dev   # Express API on :4000
cd ../frontend && npm run dev  # Next.js on :3000
```

### First-Time Setup

1. Open `http://localhost:3000` in your browser
2. You'll be redirected to the **Setup Wizard**
3. Follow the 4 steps:
   - **Step 1:** Create your admin account
   - **Step 2:** Enter your Proxmox host URL and API token credentials, then test the connection
   - **Step 3:** Select default storage pool, network bridge, and ISO storage from your cluster
   - **Step 4:** Review and finalize

You'll be logged in as admin and ready to generate invite links for your users.

## Production Deployment (Docker)

ProxMate ships with a production `docker-compose.yml` (multi-stage builds; the API runs
migrations on startup, the frontend is a Next.js standalone server, and the SQLite DB
lives on a named volume).

```bash
# 1. Configure
cp .env.docker.example .env
#    - generate a stable encryption key:
openssl rand -hex 32          # paste into ENCRYPTION_KEY in .env
#    - set FRONTEND_URL and NEXT_PUBLIC_API_URL to the URLs your users will hit

# 2. Build and start
docker compose up -d --build

# Frontend → http://localhost:3000   API → http://localhost:4000
```

> **`ENCRYPTION_KEY` must stay constant** across restarts — it decrypts your stored Proxmox
> token and JWT secret. Back it up. `NEXT_PUBLIC_API_URL` is baked into the frontend at
> **build time**, so rebuild the frontend image if it changes.

**For a real public deployment**, put a reverse proxy (Caddy/nginx/Traefik) in front to
terminate **HTTPS**, set `NEXT_PUBLIC_API_URL` to `https://<your-domain>/api`, proxy `/api`
to the backend, and add rate limiting. See [SECURITY.md](./SECURITY.md).

## Security

ProxMate is designed for sharing resources with people you don't fully trust (friends,
family). Before going public, read **[SECURITY.md](./SECURITY.md)** — it covers tenant
**network isolation** (keeping guests off your LAN and away from your other VMs/host), the
required Proxmox cluster-firewall step, least-privilege API tokens, and a production
hardening checklist.

## Project Structure

```
ProxMate/
├── frontend/    # Next.js dashboard + setup wizard
├── backend/     # Express API + Proxmox proxy + WebSocket relay
└── project-architecture.md  # Full architecture spec
```

See [project-architecture.md](./project-architecture.md) for the complete specification.

## License

MIT

---

*Built with ☁️ by the ProxMate team.*
