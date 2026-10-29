# ProxMate Security Model

This document explains how ProxMate isolates the people you invite from the rest of
your infrastructure, what you must do to **enforce** that isolation, and the broader
security posture of the application.

> **TL;DR** — ProxMate gives every VM it creates a restrictive per-VM firewall that
> blocks the tenant from reaching your LAN, your other VMs, and the Proxmox host
> (while still allowing the internet). **Those rules only take effect once you enable
> the Proxmox cluster firewall.** For the strongest isolation, put tenant VMs on a
> dedicated VLAN/bridge (see [Gold-standard isolation](#gold-standard-isolation)).

---

## 1. The isolation goal

You want to share CPU/RAM/disk with friends and family so they can run their own VMs —
but they must **never** be able to reach:

- your other virtual machines on the cluster,
- the Proxmox host / management interface,
- anything else on your local network (NAS, router admin, IoT, other PCs).

There are two layers to this: **application authorization** (can a tenant see/control
*another tenant's* VM through ProxMate?) and **network isolation** (can a tenant's VM
reach your infrastructure over the network?).

---

## 2. Application-layer authorization

This is enforced in code and is always on:

- Every per-VM API call resolves the guest through `getVmWithCap(vmId, user, cap)`, which
  returns it only if the caller holds the **capability** that route requires. A tenant
  cannot view, start, stop, delete, or open a console to a VM they have no access to.
- **Share a VM** grants another ProxMate user access at one of three preset levels:
  **Viewer** (see the VM and its status, and watch its console view-only), **Operator** (+ power
  actions and an interactive console), and **Manager** (+ config, resize, backups). The ProxMate IDE opens only for a VM's owner, never through a share (or for an admin on another user's VM). No share level of any kind can delete,
  rebuild, migrate, re-share, or change passthrough — those stay with the owner and admins.
- **Guest ownership tags.** Every guest ProxMate manages carries a Proxmox tag naming its
  machine (`proxmate-<id>`; Store templates `proxmate-template-<id>`). Start, stop, console,
  IDE, backups, restores, resize and delete act only on a guest carrying its own machine's
  tag, so a stale or reused VMID never points an action at another guest. Machines without a
  tagged guest, and machines held after a create, rebuild or restore that didn't finish, are
  refused until an admin settles them (**Settings → Maintenance → Unconfirmed machines**).
- VM listings return the VMs a caller owns **or has been shared** (admins see all), each row
  annotated with the caller's access level and capability set so the UI can gate controls.
- **Compute access windows** bound how long an invited person may use the cluster at all.
  The term is anchored at sign-up (or `never`); when it lapses the account is **suspended,
  not deleted** — VMs are stopped and every auth path refuses the session, including the
  console WebSocket, the IDE proxy, and both API-token families. Admins never expire.
- Resource **quotas** from the invite are enforced on every create, resize and restore —
  including several running at once for the same owner; a tenant cannot exceed the
  CPU/RAM/disk you granted.
- The Proxmox **API token never leaves the backend** — tenants talk only to ProxMate.
- VM `name`, `os` (ISO filename), and target `node` are strictly validated so a tenant
  cannot inject extra Proxmox parameters or alter API paths.

---

## 3. Network isolation (the important layer)

By default a Proxmox VM lands on your main bridge (e.g. `vmbr0`), which is your flat LAN —
**L2-adjacent to everything**. ProxMate addresses this in two ways.

### 3a. Per-VM firewall (applied automatically)

When **Tenant network isolation** is enabled (Admin → Settings ▸ Proxmox tab, on by default), every VM
ProxMate creates is configured with:

- `firewall=1` on its network device,
- guest firewall `enable=1`, `policy_in=DROP` (nothing on the LAN can initiate to the VM),
  `policy_out=ACCEPT` (further restricted below), `macfilter=1` (the VM can't spoof
  another machine's MAC), `dhcp=1` (so it can still lease an address), and `ndp=1` (IPv6
  neighbour discovery, needed for the guest to function on an IPv6-enabled bridge).
  `ipfilter` is left
  **off** — turning it on requires registering each VM's DHCP-assigned IP in an
  `ipfilter-net*` ipset, and without that Proxmox drops *all* of the VM's traffic.
- outbound firewall rules, evaluated top-to-bottom:
  1. `ACCEPT` → DNS (port 53) to your configured resolver(s) — or to **any** destination
     when none are set (see note), so tenant VMs always resolve names,
  2. `DROP` → `10.0.0.0/8`,
  3. `DROP` → `172.16.0.0/12`,
  4. `DROP` → `192.168.0.0/16`,
  5. `DROP` → IPv6 router advertisements the guest sends (so it can't redirect its
     neighbours' traffic; it still receives them),
  6. `DROP` → UDP port 68 (so the guest can't act as a DHCP server for its neighbours; its
     own DHCP client keeps working),
  7. (default `ACCEPT` → the public internet).

Net effect: the tenant VM can reach **the internet and DNS**, but **cannot reach any
RFC1918 address** — that includes your LAN, your other VMs, and the Proxmox host.

> **DNS servers (Admin → Settings ▸ Proxmox tab → Tenant network isolation).** Your resolver is often *not*
> your gateway — a Pi-hole/AdGuard box, a dedicated DNS server, or one on a separate
> VLAN. By default the isolation rules allow DNS to **any** destination so name
> resolution always works (the rest of RFC1918 stays blocked, so tenants still can't
> reach any other internal service). To tighten it, list your DNS server IP(s) in the
> **DNS servers** field and isolation will permit DNS *only* to those.

### 3b. You must enable the Proxmox cluster firewall

> **Per-VM firewall rules do nothing until the Proxmox *cluster* firewall is enabled.**
> Until then, VMs share your LAN with no isolation.

Admin → Settings shows whether isolation is **Enforced**. If it says *"Not enforced yet,"*
the cluster firewall is off. Enable it carefully:

**Safe enable (preserves your management access):**

1. Add a datacenter rule allowing your admin network to reach the host, **before** enabling
   the firewall, so you don't lock yourself out. On the Proxmox host shell:
   ```bash
   # allow your LAN admin subnet to the Proxmox web UI + SSH (adjust the CIDR)
   pvesh create /cluster/firewall/rules -type in -action ACCEPT -source 192.168.1.0/24 -dport 8006 -enable 1 -comment "mgmt web"
   pvesh create /cluster/firewall/rules -type in -action ACCEPT -source 192.168.1.0/24 -dport 22   -enable 1 -comment "mgmt ssh"
   ```
2. Enable the cluster firewall:
   ```bash
   pvesh set /cluster/firewall/options -enable 1
   ```
   Proxmox automatically permits cluster/corosync traffic between nodes, so quorum is not
   affected. Verify you still have web/SSH access immediately. To revert: `pvesh set /cluster/firewall/options -enable 0`.

Once enabled, ProxMate's per-VM rules are enforced and the Settings page shows **Enforced**.

### 3c. A Tailscale subnet router on a Proxmox node

If one of your Proxmox nodes is a **Tailscale subnet router**, traffic from your tailnet to
guests **on that node** skips their firewall: Tailscale marks the packets it forwards, and its
`ts-forward` rule accepts marked packets before the Proxmox firewall runs, including on the
second pass through the guest's firewall bridge. Guests on other nodes are not affected.

Copy `deploy/proxmox-tailscale-guard.sh` to that node and install the guard (as root):

```bash
bash proxmox-tailscale-guard.sh            # install and apply now
bash proxmox-tailscale-guard.sh --check    # does this node need it, and is it in place?
```

It clears Tailscale's mark on bridged traffic, so each guest's own firewall decides again. It
keeps the rule in place at boot, whenever `tailscaled` restarts, and every 2 minutes;
`--uninstall` removes it. See
[docs/proxmate-ide.md](docs/proxmate-ide.md) → *Tailscale subnet router on a Proxmox node*.

### Gold-standard isolation

Defense-in-depth beyond the firewall — put tenant VMs on a network that is isolated
**by construction**, so isolation doesn't depend on per-VM rules:

- **Dedicated VLAN / bridge with no route to your LAN.** Create a separate bridge (e.g.
  `vmbr1`) on a VLAN that your router NATs straight to the internet but gives **no route**
  to your management VLAN. Point ProxMate's *default network bridge* (Admin → Settings) at it.
- **Proxmox SDN isolated VNet.** Create an SDN *Simple* zone + VNet with its own subnet and
  SNAT; tenant VMs get internet via NAT and are L2/L3-isolated from your management network.
  Set ProxMate's default bridge to that VNet.

With either approach, even a misconfigured or disabled per-VM firewall cannot expose your
infrastructure, because the tenant network is physically/virtually separate.

### Containers

ProxMate provisions both **QEMU VMs** and **LXC containers** (containers since v0.4.0). The
same tenant-isolation model applies to containers — the per-VM firewall, quotas, ownership
and share capabilities all treat them the same way — and LXC additionally benefits from
running **unprivileged**. Note that LXC has **no live migration** in the API-only model, so
the cluster balancer pins containers and node-drain lists them as blockers.

---

## 4. Other security considerations

| Area | Posture |
|------|---------|
| Proxmox API token | Stored AES-256-GCM encrypted in the DB; never sent to the browser. **Scope it down** — see below. |
| Secrets at rest | `proxmox_token_secret`, `jwt_secret`, the SMTP/SSO secrets, the notification webhook URL and ntfy/Telegram tokens, TOTP secrets, saved AI keys and IDE per-install secrets are encrypted with `ENCRYPTION_KEY` (AES-256-GCM, random 12-byte IV + auth tag). The key must be a **64-hex (32-byte)** string, and secret operations **fail closed** if it is missing (no static fallback). Admins see a banner until one of them confirms the key is backed up off the host; the key itself is never shown. |
| Passwords | bcrypt (cost 12). Login runs bcrypt even for unknown emails to prevent timing-based account enumeration. |
| Sessions / JWT | 24h JWTs with a random `jti`, **verified with a pinned `HS256` algorithm**; every token is backed by a `Session` row, so logout / revocation is server-side. A password reset (self-service or by an admin) ends every session and revokes every API token of the account. |
| Personal API tokens | The second auth path, for the public REST API (see [`docs/api.md`](docs/api.md)). Tokens are `pm_` + CSPRNG random; **only an HMAC-SHA256 hash is stored**, so the plaintext is shown once and is unrecoverable. Each token carries its owner's identity and is subject to the same capability checks, quotas, and compute-access-window enforcement as a browser session; owners can revoke individual tokens. Routes that change how an account signs in or is secured (2FA, passkeys, token management, invites, session refresh, kiosk exit, the admin SSO / kiosk / reset-password settings and the `ENCRYPTION_KEY` backup confirmation) refuse API tokens and need a browser session; the full list is in [`docs/api.md`](docs/api.md#session-only-routes). |
| Brute-force lockout | After `AUTH_LOCKOUT_MAX` (default 10) consecutive failed passwords an account is locked for `AUTH_LOCKOUT_MINUTES` (default 15), auto-unlocking. The locked response is identical to a normal failure (no enumeration), and admins are emailed when SMTP is configured. Complements the IP rate limiter (targeted vs. noisy-source protection). Attempts are reserved before they're checked, so concurrent guesses can't exceed the limit. Wrong 2FA codes are counted per account on their own counter (a correct password doesn't reset it) and capped per challenge; passkey challenges are held server-side and single-use, as are password-reset links, backup download links and recovery codes. Re-running 2FA setup on an account that already has it needs a current code. |
| Invites | 32-byte URL-safe random tokens, single-use (claimed atomically), with an expiry. An invite sent to an email address can only be registered with that address; sending it to a different address issues a new link and the old one stops working. |
| SSO account linking | A first SSO login links to an existing local account by email only when the ID token carries `email_verified: true` **and** the account's address was bound by ProxMate (registered through an invite emailed to it, or the setup-wizard admin). Otherwise the login is refused and the user keeps signing in with their password. Accounts that predate this rule and were registered with a self-typed address, and any IdP that omits `email_verified`, never auto-link. |
| Input validation | All request bodies validated with Zod; Prisma parameterizes all queries. Request bodies are capped (1 MB). |
| Transport | Run ProxMate behind HTTPS in production (reverse proxy). Set `verifySsl=true` once Proxmox has a valid cert — or keep verification **on** against a private CA via `PROXMOX_CA_CERT_FILE`/`PROXMOX_CA_CERT` (preferred over disabling it). |
| Browser headers | The frontend sends `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS, and a strict **nonce-based Content-Security-Policy** (`script-src 'self' 'nonce-…' 'strict-dynamic'`) so injected inline scripts can't execute. |
| CORS | Restricted to `FRONTEND_URL`. |
| Console tickets | One-time, short-lived Proxmox VNC tickets. The console WebSocket authenticates via the **httpOnly session cookie** (no token in the URL) and checks `Origin` against `FRONTEND_URL`. The ticket must be one ProxMate minted for the same VM, user, console type and port (single use, one minute), and the session's mode is the one recorded at the mint, never a browser flag: the **`console` capability** (owner, admin, Operator, Manager) gives an interactive session, **`console_view`** alone (Viewer) a view-only one. |
| View-only consoles | Enforced in the relay, not just the browser. For the graphical console the relay parses the client's RFB stream across frame boundaries: the handshake passes (protocol 3.7/3.8; None, VNC auth, or VeNCrypt with a None, VNC-auth or Plain subtype) with ClientInit forced to **shared**, so a viewer never disconnects other sessions; after it only SetPixelFormat, SetEncodings, FramebufferUpdateRequest, EnableContinuousUpdates and ClientFence pass, while KeyEvent, PointerEvent, ClientCutText, xvp power requests, SetDesktopSize and QEMU key/audio messages are dropped. For the text console only the `user:ticket` line and keepalives (`2`, at most one a second) pass; input (`0:len:data`) and resizes (`1:cols:rows:`) are both dropped. Resizes are dropped because termproxy parses each buffer it reads rather than a stream: a message cut at its buffer's end is re-parsed, and a `0` landing at the front would start the input path. A view-only stream after the auth line holds only `2` bytes, so no split can reach it. Anything the relay cannot frame closes the session. Messages the browser sends before the relay is attached are held and then passed through the same filter. |
| Guest-agent tools | Password reset, SSH-key add and **file push** (QEMU only) need the **`configure` capability** (owner, admin, Manager share); Viewer and Operator shares are refused. Each first confirms the guest carries the row's ownership tag. Request values reach the guest only as argv entries or `file-write` content, never as shell text. A pushed file's path must be absolute and normalized (no `..`, no control characters, not under `/proc`, `/sys` or `/dev`), it is capped at 1 MiB by default (`GUEST_FILE_PUSH_MAX_BYTES`, at most 8 MiB), staged in a private temp directory and renamed into place. Root writes only into a folder it reaches without symlinks and that only root can change; in any other folder the file is written as the chosen owner (so a symlink planted there reaches only what that user could write), and without an owner such a push is refused. Every push is audited with path, size and SHA-256 (never the contents) and rate-limited per user. The **IDE install log** is read with a fixed `tail` command, for the VM's owner or an admin only, with control characters and ANSI escapes stripped and shown as plain text. |
| Rate limiting | Built-in `express-rate-limit` on `/auth/login`, `/auth/register`, and public token lookups (invite lookup, backup downloads); the setup wizard's mutating steps are throttled too (env-tunable). A separate **write limiter covers all of `/api`**, skipping safe `GET`/`HEAD`/`OPTIONS`, so every mutating request is throttled (default 60 per 60 s per IP, `API_WRITE_RATE_LIMIT_MAX` / `_WINDOW_MS`). Honors `trust proxy`. |
| Outbound requests (SSRF) | Admin-configured **notification webhooks** and **ntfy URLs** are validated against a private-address blocklist (loopback, link-local / cloud-metadata `169.254.169.254`, RFC1918, CGNAT, IPv6 ULA / link-local, IPv4-mapped IPv6): shape-checked on save, DNS-resolved and re-checked immediately before the request, and redirects refused. **Cloud-image URLs** are shape-checked against the same list before Proxmox is asked to download them (Proxmox makes that request). Telegram messages always go to `api.telegram.org`. Homelab installs that point at a LAN service can opt in with `ALLOW_PRIVATE_OUTBOUND_URLS=true` (scheme + no-credentials checks always stay enforced). |
| Metrics endpoint | `GET /metrics` is token-gated; in **production** it returns 404 unless `METRICS_TOKEN` is set — including for localhost, so there is no unauthenticated local scrape. Scrapers send `Authorization: Bearer <token>`. |
| MFA-setup enforcement | Where an invite required two-step auth, registration and password sign-in hand back only a scoped enrollment token, never a session, until a TOTP or passkey method is enrolled. As a backstop, seven protected routers (`/api/vms`, `/api/projects`, `/api/templates`, `/api/admin`, `/api/proxmox`, `/api/users`, `/api/passthrough-requests`) answer 403 `mfa_setup_required` until the user has a factor. |
| Containers | Both images run with **all Linux capabilities dropped** and `no-new-privileges`; the frontend runs as a non-root user and the backend drops to the unprivileged `node` user after fixing data-volume ownership. |
| Audit log | VM lifecycle (create/delete/start/stop/restart/restore), auth events, settings changes (without secret values), and **account lockouts** are recorded with actor + client IP; admin-viewable at `/admin/audit`. The client IP comes from `REAL_IP_HEADER` only when `TRUST_PROXY` ≥ 1 (`x-forwarded-for` is resolved through the trusted hop count); otherwise it is the socket address. Every console open is recorded (`vm.console_open`, or `vm.console_view_open` for a view-only session). The notification webhook URL and the ntfy/Telegram tokens are only ever shown masked. |
| Restores from an uploaded backup | Only an archive whose config describes the guest itself is accepted (no host devices or paths, raw QEMU/LXC keys, hook scripts or privileged containers; containers always restore unprivileged), and the restore counts against the owner's quota. When it ends, autostart, startup order and protection are removed, the firewall rules, IP sets and aliases that came with the backup are cleared, and the restored configuration (pending changes and snapshots included) is checked before the machine can be used. A guest that doesn't pass is deleted; if Proxmox refuses the delete it is held for an admin with its network links down. |
| Automatic snapshots | Before a resize, a data-disk grow or a rescue boot ProxMate takes a disk-only `pm-auto-…` snapshot and refuses the change if it fails. Retention only ever deletes snapshots ProxMate took itself (Admin → Settings → Maintenance). A rollback refuses a snapshot that holds host-level settings or another guest's disks. |

### ProxMate IDE (in-guest editor + AI agent)

The IDE is the one feature that reaches a guest **over the network** (`guest-ip:8080`, or `IDE_GUEST_PORT`) rather
than out-of-band through the Proxmox API, so it has its own guarantees (full model in
[`docs/proxmate-ide.md`](docs/proxmate-ide.md)):

| Area | Posture |
|------|---------|
| Editor transport | Reverse-proxied through the backend; every HTTP **and** WebSocket request is resolved through `getVmWithCap(vmId, user, 'ide')`, must come from the VM's **owner**, and is re-checked against the admin IDE policy. Admins and sharees are refused (403), because the guest's root user controls what the IDE serves on the ProxMate origin. ProxMate's own cookies and the `Authorization` header are stripped from every proxied request, and guest responses can't set ProxMate cookies or send `Service-Worker-Allowed`. The proxy refuses loopback/link-local/metadata targets, so a spoofed guest-reported IP can't point it at the host. |
| Guest authentication | Every install gets its own random secret (stored AES-256-GCM encrypted; the guest receives only its SHA-256), and `code-server` runs with password auth keyed to it. Only running VMs are proxied. Before relaying anything, the proxy reads the guest's current address from its guest agent and requires the `code-server` there to prove that secret, then authenticates each proxied request with it server-side; the browser never sees it. A different VM's `code-server` or any other service at that address can't prove it, so the proxy won't relay to it. This assumes the recorded address belongs to the VM and that the network path from ProxMate to the guest is trusted; the proof does not authenticate the network itself. Installs made before this have no secret and stay closed until the owner reinstalls the IDE (the UI does this on the next open). |
| Firewall pinhole | Reaching `code-server` needs one inbound hole in the guest's isolation firewall — added as a **managed, infra-scoped** ACCEPT via the Proxmox firewall API (like the isolation rules), scoped to `ide_ingress_cidr` (a wildcard `0.0.0.0/0` is rejected). The guest keeps `policy_in=DROP`, so **tenant-to-tenant isolation is unchanged** — only ProxMate's address can reach the port. |
| LLM gateway | The in-guest AI agent authenticates with a **per-VM bearer token** (sha-256 hashed at rest), issued only to the VM's **owner** (whoever triggers the install), that re-checks ownership + policy live on every call; a token held by anyone else is rejected. `resolveModelRoute` is the single allow-list choke point: a tenant can reach only admin-shared models, or their own BYO keys when enabled — never an un-shared model, even by editing the in-guest config. Admin upstream endpoints/keys never leave the server. |
| BYO-key SSRF | Tenants may only use OpenAI or the fixed preset OpenAI-compatible bases (OpenRouter, Groq) — a free-form custom base URL is **admin-only**. Tenant-supplied endpoints additionally go through the same outbound guard as webhooks (shape-check on save, DNS re-check at forward). Admins are exempt so they can source models from a **LAN** endpoint (e.g. a local Ollama). |
| Gateway limits | Body-capped (large chat contexts allowed but bounded) and rate-limited **per VM**, so a stolen or runaway token can't flood the upstream. |
| Base URL | The gateway URL handed to the guest comes from the operator-configured `BACKEND_PUBLIC_URL` and **must be https** — an http URL gets 301'd, which breaks the agent's POST. Since v0.8.0 the configured value wins outright; deriving the scheme from forwarded headers is only a fallback for bare dev setups, having proved unreliable behind a proxy that rewrites `X-Forwarded-Proto`. |

### Recommended: scope the Proxmox API token

ProxMate works with a `root@pam` token, but for least privilege run
`deploy/proxmox-token.sh` on a Proxmox node. It creates a `proxmate@pve` user with no
password, a `ProxMate` role and a privilege-separated token, granted on `/` (the cluster
firewall, cluster status and cloud-image downloads are checked there). The role holds:

- `VM.Allocate`, `VM.Audit`, `VM.Backup`, `VM.Clone`, `VM.Console`, `VM.Migrate`,
  `VM.PowerMgmt`, `VM.Snapshot`, `VM.Snapshot.Rollback`
- `VM.Config.CDROM`, `.CPU`, `.Cloudinit`, `.Disk`, `.HWType`, `.Memory`, `.Network`,
  `.Options` (the guest ownership tags)
- `Datastore.Allocate`, `Datastore.AllocateSpace`, `Datastore.AllocateTemplate`,
  `Datastore.Audit`
- `SDN.Audit`, `SDN.Use`, `Sys.Audit`, `Sys.Modify` (cluster firewall isolation)
- the guest agent: `VM.Monitor` on Proxmox VE 8; `VM.GuestAgent.Audit`,
  `VM.GuestAgent.Unrestricted` and `VM.GuestAgent.FileWrite` on 9 (`file-write` carries
  the IDE bootstrap and files pushed into a VM; on PVE 9.2.3 `Unrestricted` already
  covers it, so `FileWrite` is belt-and-braces)
- for GPU/PCI passthrough only: `Mapping.Audit`, `Mapping.Use`

It needs no user or permission management, and never the node shell. The connection
test warns about each missing privilege.

With the role on `/`, the per-guest boundary is ProxMate's ownership-tag check: the token itself
may act on every guest in the cluster. For a boundary Proxmox enforces, run the script with
`--pool <name>` and set the same **Proxmox pool** in ProxMate. The guest privileges are then
granted only on `/pool/<name>` (role `ProxMate-Guest`, which adds `Pool.Audit` and `Pool.Allocate`
so ProxMate can see the pool, create containers in it and move its own guests into it), and
ProxMate creates, clones, restores and imports every guest into that pool. What is still needed
outside the pool is granted on the narrowest path Proxmox checks it on: `Sys.Audit` (and, on 8.2+,
`Sys.AccessNetwork` for cloud-image downloads) on `/nodes`; `Datastore.Audit`, `.AllocateSpace`
and `.AllocateTemplate` on `/storage`; `Datastore.Allocate` nowhere unless asked for (only on a
named snippet or import storage); `SDN.Audit`/`SDN.Use` on `/sdn/zones`; the mapping privileges on
`/mapping` (only for passthrough); and `Sys.Audit` on `/` without propagation.

Two grants reach past the pool, so they are left out or narrowed: `Sys.Modify` on `/` (cluster
backup jobs, the cluster firewall's groups and IP sets, cluster options) is granted only with
`--with-cluster-firewall`, or before Proxmox VE 8.2 where cloud-image downloads need it; while the
token holds it the pool does not fully contain it, and the script and the connection test say so.
`Datastore.Allocate` (delete any volume, edit storage definitions) is never granted on all of
`/storage`. The connection test also warns while the token still holds guest privileges on `/`
(the pool limits nothing until that grant is removed with `--drop-root-grant`) and while guests
ProxMate manages are outside the pool. See DEPLOYMENT.md §2.2 for the switch-over steps.

> Note: Proxmox API tokens default to **Privilege Separation ON**, which gives the token an
> empty permission set. Either disable privilege separation on the token or grant it a role
> explicitly (see the README).

### Production hardening checklist

- [ ] Serve frontend + API over **HTTPS** (reverse proxy / TLS).
- [ ] Set a strong, persistent `ENCRYPTION_KEY` and back it up (losing it makes encrypted config unreadable).
- [ ] Enable the **Proxmox cluster firewall** (§3b) — required for tenant isolation.
- [ ] Prefer a **dedicated tenant VLAN/SDN** (§ Gold-standard).
- [ ] Use a **least-privilege** Proxmox token, not `root@pam`.
- [x] **Rate limiting** on login/register/invite is **built in** (`express-rate-limit`). Behind a reverse proxy, set `TRUST_PROXY` to the trusted hop count so it keys on the real client IP.
- [x] **Per-account brute-force lockout** is built in (env-tunable; admin email alerts when SMTP is set).
- [x] **Browser security headers + nonce CSP** ship by default; pin `CSP_CONNECT_SRC` to your exact API origin to tighten `connect-src`.
- [x] **Hardened containers** (cap-drop, no-new-privileges, non-root) ship by default. The backend auto-`chown`s its data volume on start, so existing deployments need no manual migration.
- [x] **Outbound SSRF guards** on admin webhooks and cloud-image URLs ship by default (set `ALLOW_PRIVATE_OUTBOUND_URLS=true` only if you deliberately target a LAN service).
- [ ] Set **`METRICS_TOKEN`** if you scrape `/metrics` in production (otherwise it returns 404); or keep the scrape on localhost only.
- [ ] Prefer a private-CA `PROXMOX_CA_CERT_FILE` over `verifySsl=false` so the API token can't be MITM'd on an untrusted segment.
- [ ] Keep Proxmox VE patched (guest→host isolation ultimately depends on the hypervisor).

## 5. Supported versions and reporting a security issue

Security fixes go into the latest release line. Upgrade to it before reporting.

| Version | Security fixes |
|---|---|
| 1.3.x | ✅ |
| 1.2.x and earlier | ❌ — upgrade to 1.3.x |

Please **don't open a public issue** for a security problem. Report it privately from the
repository's **Security** tab → **Report a vulnerability** (GitHub private vulnerability
reporting). Include the version, what you did, what happened and what you expected; a
minimal reproduction helps most. You'll get a reply there, and a fix ships in a release
with credit if you'd like it.
