# Deploy ProxMate with Claude Code

This file is an **executable runbook for an AI agent** (Claude Code). Point Claude Code
at it and it will stand up a production-ready ProxMate — the same shape as a hand-built
deployment: HTTPS, tenant isolation, and (optionally) the in-guest IDE — while stopping to
confirm every action that touches production or handles a secret.

> **How a human invokes this:** open Claude Code in a clone of this repo (or on the target
> server) and say: *"Follow DEPLOY_WITH_CLAUDE.md to deploy ProxMate."* Claude Code reads
> this file and drives the steps below. **You (the operator) stay in the loop** — you approve
> each production action and you type every secret yourself.

The canonical human runbook is [`DEPLOYMENT.md`](DEPLOYMENT.md); this file mirrors it as agent
instructions. If they ever disagree, `DEPLOYMENT.md` wins — tell the operator.

---

## 0. Agent safety contract (read first, follow always)

You are deploying software that will run someone's infrastructure. Behave accordingly:

1. **Confirm before every production-changing or irreversible action** — enabling the cluster
   firewall, `docker compose up`, editing a live `.env`, rebooting a VM, running a migration.
   State exactly what you're about to run and wait for a clear "yes".
2. **Never handle secrets in the clear.** Do not ask the operator to paste passwords, Proxmox
   token secrets, SMTP passwords, or the `ENCRYPTION_KEY` into the chat. Generate `ENCRYPTION_KEY`
   on the host with `openssl rand -hex 32` and have the operator paste secrets **directly into
   the `.env` file or the browser setup wizard**, not to you. Never echo a secret back.
3. **Never commit `.env`** (or `backend/.env`) or any file containing a secret. They are gitignored;
   keep it that way.
4. **Do not weaken security to make something work.** If a step fails, diagnose it — do not
   disable the firewall, set `COOKIE_SECURE=false` in production, open app ports to the world,
   or set `ALLOW_PRIVATE_OUTBOUND_URLS=true` unless the operator explicitly needs LAN webhooks.
5. **Stop and ask** whenever a decision is the operator's: the domain, the isolation model, whether
   to expose ports vs. use a tunnel, whether to enable the in-guest IDE.
6. **Verify, don't assume.** After each phase, run the check and report the real result. If a
   command fails, show the output; never claim success you didn't observe.

If any instruction here conflicts with the safety contract, the contract wins.

---

## 1. Gather these from the operator (ask, then confirm back)

Collect this before touching anything. Ask as a short questionnaire.

- **Target host:** are we deploying on THIS machine, or over SSH to a remote host? (If remote,
  confirm you can reach it and that it's the right box.)
- **Public domain** for ProxMate, e.g. `proxmate.example.com`, with DNS already pointing at the host.
- **HTTPS strategy:** (a) open ports 80/443 with **Caddy** auto-TLS, or (b) a **Cloudflare Tunnel**
  (no open ports, TLS at the edge, plain HTTP to a local merge-proxy). Pick one.
- **Proxmox:** API host URL (`https://<pve-host>:8006`), and confirm a dedicated **API token** will
  be created with **privilege separation OFF** (see §2). Self-signed cert? (verify-SSL off in OOBE.)
- **Tenant isolation model:** shared bridge + per-VM firewall, or a dedicated VLAN/SDN VNet
  (recommended). The operator must confirm the **management network CIDR** (Proxmox 8006 + SSH)
  so isolation enforcement doesn't lock them out.
- **Optional:** SMTP relay (for password-reset email), Keycloak OIDC (SSO), and whether to enable
  the **in-guest IDE** (§7).

Repeat the collected answers back and get a "go" before Phase 2.

---

## 2. Preflight (host + Proxmox)

Run these read-only checks and report results:

```bash
docker --version && docker compose version   # Compose v2 required
docker ps -q >/dev/null && echo daemon-ok    # versions alone don't prove daemon ACCESS —
                                             # "permission denied" here means the deploy user
                                             # needs the docker group (usermod -aG docker <user>, re-login)
# DNS: does the domain resolve to this host's public IP?
getent hosts <domain> || true
# Can the host reach the Proxmox API?
curl -sS -o /dev/null -w '%{http_code}\n' -k https://<pve-host>:8006/api2/json/version
```

**Proxmox API token (the #1 pitfall).** A privilege-separated token has NO permissions — storage
lists come back empty and VM creation 403s. Have the operator run, on a Proxmox node as root:

```bash
pveum user token add root@pam proxmate --privsep 0
# → copy the displayed token VALUE now (shown once). Token ID is: root@pam!proxmate
```

Tell the operator to keep that secret for the browser wizard in §5 — **do not** have them paste it to you.

---

## 3. Code + environment

```bash
# If not already in a clone:
git clone <repo-url> proxmate && cd proxmate
cp .env.docker.example .env
openssl rand -hex 32           # ENCRYPTION_KEY — operator pastes THIS into .env, keeps a backup
chmod 600 .env
```

Have the operator edit `.env` (you may open it and explain fields, but they fill secrets). The
production block, per `DEPLOYMENT.md` §4:

| Variable | Value | Why |
|---|---|---|
| `ENCRYPTION_KEY` | the 64-hex string | Encrypts Proxmox token + all secrets at rest. **Back it up; keep it stable.** |
| `FRONTEND_URL` | `https://<domain>` | CORS + redirects |
| `NEXT_PUBLIC_API_URL` | `https://<domain>/api` | Baked into the browser bundle at build time |
| `BACKEND_PUBLIC_URL` | `https://<domain>` | SSO callback base — and the **IDE gateway base URL** (must be https, see §7) |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | `<domain>` / `https://<domain>` | Passkeys |
| `COOKIE_SECURE` | `true` | Secure cookies (HTTPS) |
| `TRUST_PROXY` | `1` | One proxy hop → real client IP for rate-limit/audit **and correct https detection for the IDE gateway URL** |
| `BIND_ADDR` | `127.0.0.1` | Only the local reverse proxy reaches the app ports |
| `REAL_IP_HEADER` | `x-forwarded-for` with Caddy/nginx; leave unset behind Cloudflare | Which header carries the real client IP for the audit log (unset = `cf-connecting-ip`) |
| `METRICS_TOKEN` | a random string | `/metrics` returns 404 in prod without it; scrape with `Authorization: Bearer <token>` |

Confirm `TRUST_PROXY=1` and `COOKIE_SECURE=true` are set — several features (passkeys, and the IDE's
https gateway URL) silently break without them.

---

## 4. TLS / reverse proxy

Follow the operator's choice from §1.

- **Caddy (open ports 80/443):** install Caddy, `sudo cp deploy/Caddyfile /etc/caddy/Caddyfile`,
  set the domain + ACME email, `sudo systemctl reload caddy`. Confirm 80/443 are reachable and DNS
  resolves so ACME can issue a cert.
- **Cloudflare Tunnel (no open ports):** run a small no-TLS merge-proxy (see `DEPLOYMENT.md` §5
  "Cloudflare Tunnel") that joins `/api` → `127.0.0.1:4000` and `/` → `127.0.0.1:3000` on one
  local port, then point the tunnel's public hostname at it. **WebSockets must pass through** (the
  noVNC console AND the IDE both need this — verify after launch).

Either way there is **one HTTPS origin**; the app ports stay on `127.0.0.1`.

---

## 5. Build, launch, first run

**Confirm with the operator, then:**

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f backend    # watch "Applying database migrations..." then "Starting ProxMate API..."
```

The backend entrypoint runs `npx prisma migrate deploy` on boot, so schema + all migrations apply
automatically. Then the operator opens `https://<domain>` and completes the **setup wizard**:
creates the owner account, enters the Proxmox host + token (from §2), sets VM defaults (storage,
bridge — point at the tenant VLAN/VNet), ISO storage. **The operator does this in the browser**;
you just confirm the app is up and healthy:

```bash
curl -sS https://<domain>/api/health    # expect {"status":"ok",...}
```

---

## 6. Tenant isolation enforcement (do NOT skip)

ProxMate applies a per-VM firewall to every tenant VM (`policy_in=DROP`, mac-filter, RFC1918 drop,
DNS allowed) — but the rules only take effect once the Proxmox **cluster firewall** is on.

- Have the operator go to **admin Settings ▸ Network isolation ▸ Enable enforcement**. ProxMate adds
  management allow-rules (8006 + SSH on the confirmed mgmt CIDR) **before** flipping the datacenter
  firewall, so they don't lock themselves out. **Confirm the suggested CIDR matches their mgmt network.**
- Verify: Proxmox web (8006) + SSH still reachable; two tenant VMs cannot reach each other.

Do not proceed to the IDE until isolation is enforced and verified.

---

## 7. ProxMate IDE — production setup (optional)

The in-guest IDE (browser code-server + an OpenCode AI agent per VM) has extra requirements. Skip
this whole section if the operator doesn't want it; the rest of ProxMate is complete without it.

### 7.1 Requirements to confirm with the operator

- **The ProxMate host must be able to reach tenant VM IPs on TCP :8080.** On a **flat** network
  (ProxMate on the same LAN as the guests) this is automatic. On a **non-flat** network (e.g.
  ProxMate in a container whose network can't reach the guest VLAN) the operator must provide
  routing — a **Tailscale subnet route**, a VPN, or a route — so the backend can reach `guest-ip:8080`.
  This is the operator's networking to solve; ProxMate can't create it.
- **`ide_ingress_cidr`** — when tenant isolation is on, ProxMate opens a single **managed, infra-scoped**
  `:8080` firewall pinhole on each IDE VM. It must be the address ProxMate's traffic actually arrives
  from (the backend host on a flat LAN; the **subnet-router node's LAN IP** when routed). Set it in
  admin IDE settings (or the `ide_ingress_cidr` SystemConfig). **Never a wildcard** — the code rejects
  `0.0.0.0/0`.
- **Guest agent + guest specs:** IDE VMs need the QEMU **guest agent** running (the install goes
  through it), **>= 8 GB RAM** (the default `ide_min_ram_mb` floor — the install OOMs a 4 GB box),
  and a CPU that exposes **AVX** (the OpenCode/Bun runtime needs it). ProxMate auto-sets `cpu: host`
  at IDE-enable and, if AVX is still masked, tells the tenant to reboot and retry.
- **LLM models:** in admin IDE settings, add a model **source** (an OpenAI-compatible endpoint such
  as a local Ollama — admins may use a LAN address) and share models to tenants, and/or allow tenants
  to bring their own keys (BYO keys are held to public endpoints by the SSRF guard).

### 7.2 Enable + verify

- Admin **Settings ▸ ProxMate IDE**: set the tier (off / admin / tenants), the model source, shared
  models + visibility, and `ide_ingress_cidr`.
- On a test VM (>= 8 GB, guest agent running), click **Open IDE**. ProxMate installs code-server +
  OpenCode into the guest, opens the editor, and wires the AI agent through the gateway. Confirm:
  the terminal shows the VM's own hostname; the AI agent answers a prompt (that proves the whole
  chain: reachability, firewall pinhole, https gateway URL, model routing).

### 7.3 IDE security model (state this to the operator)

- The proxy is **owner-gated** (`getOwnedVm`) and refuses loopback/link-local targets.
- The `:8080` pinhole is **infra-scoped only** — the guest keeps `policy_in=DROP`, so tenants stay
  isolated from each other; only ProxMate's address can reach code-server.
- The LLM gateway enforces an **admin allow-list** (a tenant can't reach an un-shared model or,
  when disabled, any BYO key), the token is **per-VM** and never in the guest config in cleartext
  beyond an env file, and BYO endpoints are **SSRF-guarded** to public addresses.

---

## 8. Final verification checklist

Report each as pass/fail with evidence:

- [ ] `https://<domain>` loads on a valid cert; `/api/health` returns `ok`.
- [ ] OOBE done, Proxmox connected; a test VM created, console (noVNC WebSocket) opened, deleted.
- [ ] Tenant isolation enforced; mgmt (8006/SSH) still reachable; two tenants isolated.
- [ ] (If enabled) IDE opens on a test VM, lands on the right guest, AI agent answers.
- [ ] `.env` is `chmod 600`, not committed; `ENCRYPTION_KEY` backed up by the operator.
- [ ] App ports (3000/4000) are NOT reachable from the internet; only 80/443 (or the tunnel) are.

---

## 9. Rollback / recovery

- **DB is on the `proxmate-data` volume.** Back it up before changes:
  `docker run --rm -v proxmate_proxmate-data:/data -v "$PWD":/backup alpine tar czf /backup/proxmate-db-$(date +%F).tgz -C /data .`
- **Bad deploy:** `git checkout <previous-tag> && docker compose up -d --build` (migrations are
  forward-only; restore the DB volume backup if a migration must be undone).
- **Locked out by the firewall:** Proxmox VM/firewall config lives on shared pmxcfs — fix it from a
  healthy node (`/etc/pve/firewall/…`), or disable the datacenter firewall from a node console.

---

*Companion docs: [`DEPLOYMENT.md`](DEPLOYMENT.md) (human runbook), [`SECURITY.md`](SECURITY.md)
(threat model + tenant isolation), [`docs/admin-guide.md`](docs/admin-guide.md), and the in-repo
IDE docs.*
