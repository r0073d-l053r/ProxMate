## Highlights

**ProxMate IDE (beta).** Every VM gets a one-click, in-browser VS Code editor that
runs **inside the tenant's own virtual machine**, with an in-guest AI coding agent
(OpenCode) wired to models the admin controls. No SSH setup, no separate login —
open a VM's console menu, click **Open IDE**, and you're editing at that machine's
root with a real terminal on that machine. The feature is fully opt-in and ships
**off by default**: existing deployments see no change until an admin enables it.

Also in this release: a **cloud-init deploy lock** (freshly created VMs can't be
stopped or deleted mid-provision), an **agent-guided production deploy** method
(`DEPLOY_WITH_CLAUDE.md` — point Claude Code at it and it stands up a production
install with you approving every step), a substantial **security-hardening pass**
around the new surfaces, and a fix for three documented Docker environment
variables that were silently ignored.

## ProxMate IDE (beta)

### For tenants

- **Open IDE** on any of your VMs (Console menu, desktop browsers). First open
  installs the editor into the guest in about a minute — you can navigate away and
  come back; the VM is locked against stop/restart/delete while it installs.
- You get VS Code (code-server) opened at the VM root, an integrated terminal that
  **is** your VM (real users, real hostname, real services), and the OpenCode AI
  agent started automatically in an editor tab.
- The agent's model picker shows what your admin shared. If your admin allows it,
  add your own provider keys under **Security → AI keys** — keys are encrypted at
  rest and used only through ProxMate's gateway, never exposed to the guest.

### For admins

- **Settings → ProxMate IDE**: availability tier (off / admins only / all tenants),
  model sources (any OpenAI-compatible endpoint — a local Ollama, vLLM,
  OpenRouter…), per-model visibility (shared / admin-only), and a
  bring-your-own-keys toggle. Test buttons verify a source lists models before you
  commit to it.
- **How it reaches the guest:** the backend reverse-proxies to code-server on
  `guest-ip:8080`, gated by the ProxMate session and VM ownership (the same gate as
  the noVNC console). The ProxMate host must be able to reach tenant VM IPs on TCP
  8080 — automatic on a flat network; on a routed/non-flat network you provide the
  route (VPN, subnet route). With tenant isolation enabled, ProxMate opens a
  **managed, infrastructure-scoped firewall pinhole** per IDE VM, restricted to
  `ide_ingress_cidr` (wildcards are rejected) — guests keep `policy_in=DROP`, so
  tenant-to-tenant isolation is unchanged.
- **LLM gateway:** the in-guest agent talks to ProxMate's OpenAI-compatible gateway
  with a per-VM token — ownership and policy are re-checked on every call, tenants
  can only reach admin-shared models or their own keys, and your upstream endpoints
  and API keys never leave the backend. Streaming (SSE) passes straight through.

### Guest requirements (checked automatically at IDE-enable)

- QEMU **guest agent** running (the install goes through it).
- **At least 8 GB RAM** (configurable floor, `ide_min_ram_mb`) — the install OOMs
  smaller guests.
- A CPU exposing **AVX** (the agent runtime needs it). ProxMate sets `cpu: host`
  automatically and asks for one reboot if AVX was masked by the default vCPU type.

## Deploy locks

- **Cloud-init deploy lock (new):** a template-deployed VM reports *running* the
  moment it boots, but cloud-init is still building it inside. ProxMate now tracks
  `deployState` and blocks stop / restart / pause / delete / migrate (HTTP 409 + a
  "Finishing setup" banner) until cloud-init settles, with an 8-minute fail-safe so
  a guest without an agent can never stay locked. Rebuilds re-arm the lock.
- The existing IDE **install lock** now also disables the power/delete/migrate
  buttons in the UI while active (previously they were clickable and failed).

## Security hardening

- **Gateway rate limiting, two layers:** a pre-auth, per-IP limiter (600/min
  default, `IDE_GATEWAY_RATE_LIMIT_MAX`/`_WINDOW_MS`) in front of token
  verification — closing a CodeQL-flagged brute-force/DoS surface — plus a per-VM
  fixed window (120/min) after auth so one stolen token can't flood an upstream.
- **Gateway body cap:** LLM requests accept up to 15 MB (chat context) while the
  rest of the API keeps its 1 MB cap; streaming responses are never throttled
  mid-conversation.
- **BYO-key SSRF guard:** tenant AI-key endpoints must be public addresses
  (checked at save and again at forward time); admins are exempt so LAN model
  servers keep working as sources.
- **Proxy target safety:** the IDE proxy refuses loopback/link-local targets, so a
  spoofed guest-reported IP can't point the proxy at the ProxMate host itself.
- **Correct https behind proxies/tunnels:** gateway URLs are built from
  `x-forwarded-proto`, fixing an edge 301 that silently downgraded the agent's
  POST to a GET (symptom: "Unauthorized — missing session" from the agent).
- Per-VM gateway tokens are stored **hashed (sha256)**; the CodeQL / Trivy /
  npm-audit / SBOM pipeline is green with **zero open code-scanning alerts**.

## Fixes and improvements

- **Docker: three documented env vars now actually work.** `METRICS_TOKEN`,
  `REAL_IP_HEADER`, and `ALLOW_PRIVATE_OUTBOUND_URLS` were documented in
  `.env.docker.example` but never passed into the backend container by
  `docker-compose.yml`. If you set them before and wondered why nothing changed —
  they apply now (see upgrade notes).
- **Faster VM lists for agentless guests:** the guest-agent IP probe no longer
  retries on a guest whose agent is enabled-but-not-running — VM list ~6.8s → ~1.5s,
  agentless VM detail ~10.4s → ~1.5s in our measurements.
- **UI polish:** saved SSH keys are masked with a reveal toggle; the admin IDE
  model list got a cleaner per-model card layout; the IDE entry is desktop-only
  (hidden on mobile, where a pop-out editor can't work).

## New documentation

- `docs/proxmate-ide.md` — full IDE guide (tenant usage, admin setup, networking,
  the security model, troubleshooting), plus a new **ProxMate IDE** page on the
  docs site and IDE sections in `SECURITY.md`, `DEPLOYMENT.md`, and the admin guide.
- `DEPLOY_WITH_CLAUDE.md` — a new deployment method: an executable runbook for
  Claude Code that stands up a production ProxMate (HTTPS, isolation, optional IDE)
  under a strict safety contract — the operator approves every production action
  and secrets never pass through the agent.

## Upgrade notes

- **Two additive database migrations** (`ideState`/`deployState` columns and the
  gateway-token table) apply automatically on container start — no manual steps,
  no breaking changes.
- **The IDE is off by default.** To offer it: enable a tier and add a model source
  in **Settings → ProxMate IDE**, make sure the backend can reach tenant VMs on TCP
  8080, and — if tenant isolation is on — set `ide_ingress_cidr` to the address
  your ProxMate traffic reaches guests from. Details in `docs/proxmate-ide.md`.
- For the IDE gateway to hand guests correct URLs you need an **https public
  origin** with `TRUST_PROXY=1` (the documented production setup already does this).
- If you previously set `METRICS_TOKEN`, `REAL_IP_HEADER`, or
  `ALLOW_PRIVATE_OUTBOUND_URLS` in a Docker `.env`, they now take effect — review
  them before updating (e.g. `/metrics` switches from 404 to token-gated once
  `METRICS_TOKEN` applies; behind plain Caddy/nginx set
  `REAL_IP_HEADER=x-forwarded-for`).
- Standard update: **Admin → Settings → Updates → Install update**, or pull +
  rebuild (`docker compose up -d --build`).

## Verification

- Backend suite green: **590 tests** (+85) — new suites cover the deploy-lock state
  machine, the firewall pinhole builder (including wildcard rejection), per-VM
  proxy target resolution, the min-spec guardrail, and extended URL-safety cases.
  Typecheck and lint clean on both apps; frontend production build green.
- **Live-verified on a production multi-node cluster:** per-VM routing lands each
  IDE on its own guest with a stable WebSocket; the AI agent completes real chats
  through the gateway against a local model server; the deploy lock was observed
  engaging and releasing on real cloud-init deploys across two accounts.
- **From-scratch install proven:** a clean-room sandbox followed
  `DEPLOY_WITH_CLAUDE.md` end-to-end — fresh compose build, all 39 migrations, one
  HTTPS origin, full setup wizard, final verification checklist — which is also
  what surfaced the Docker env passthrough bug fixed in this release.
- Full pipeline green on the release PR: CI (backend, frontend, Docker builds,
  Playwright) and Security (CodeQL, Trivy, npm audit, SBOM) with two CodeQL
  high-severity findings raised during review and fixed before merge.
