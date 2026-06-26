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

- Every VM/console API call resolves the VM through `getOwnedVm()`, which returns the VM
  only if it belongs to the caller (admins may see all). A tenant cannot view, start,
  stop, delete, or open a console to a VM they don't own.
- VM listings are filtered to the caller's own VMs (admins see all).
- Resource **quotas** from the invite are enforced on every create; a tenant cannot
  exceed the CPU/RAM/disk you granted.
- The Proxmox **API token never leaves the backend** — tenants talk only to ProxMate.
- VM `name`, `os` (ISO filename), and target `node` are strictly validated so a tenant
  cannot inject extra Proxmox parameters or alter API paths.

---

## 3. Network isolation (the important layer)

By default a Proxmox VM lands on your main bridge (e.g. `vmbr0`), which is your flat LAN —
**L2-adjacent to everything**. ProxMate addresses this in two ways.

### 3a. Per-VM firewall (applied automatically)

When **Tenant network isolation** is enabled (Admin → Settings, on by default), every VM
ProxMate creates is configured with:

- `firewall=1` on its network device,
- guest firewall `enable=1`, `policy_in=DROP` (nothing on the LAN can initiate to the VM),
  `policy_out=ACCEPT` (further restricted below), `macfilter=1` (the VM can't spoof
  another machine's MAC), `dhcp=1` (so it can still lease an address). `ipfilter` is left
  **off** — turning it on requires registering each VM's DHCP-assigned IP in an
  `ipfilter-net*` ipset, and without that Proxmox drops *all* of the VM's traffic.
- outbound firewall rules, evaluated top-to-bottom:
  1. `ACCEPT` → DNS (port 53) to your configured resolver(s) — or to **any** destination
     when none are set (see note), so tenant VMs always resolve names,
  2. `DROP` → `10.0.0.0/8`,
  3. `DROP` → `172.16.0.0/12`,
  4. `DROP` → `192.168.0.0/16`,
  5. (default `ACCEPT` → the public internet).

Net effect: the tenant VM can reach **the internet and DNS**, but **cannot reach any
RFC1918 address** — that includes your LAN, your other VMs, and the Proxmox host.

> **DNS servers (Admin → Settings → Network isolation).** Your resolver is often *not*
> your gateway — a Pi-hole/AdGuard box, a dedicated DNS server, or one on a separate
> VLAN. By default the isolation rules allow DNS to **any** destination so name
> resolution always works (the rest of RFC1918 stays blocked, so tenants still can't
> reach any other internal service). To tighten it, list your DNS server IP(s) in the
> **DNS servers** field and isolation will permit DNS *only* to those.

### 3b. You must enable the Proxmox cluster firewall

> ⚠️ **Per-VM firewall rules do nothing until the Proxmox *cluster* firewall is enabled.**
> Until then, VMs share your LAN with no isolation.

Admin → Settings shows whether isolation is **Enforced**. If it says *"Not enforced yet,"*
the cluster firewall is off. Enable it carefully:

**Safe enable (preserves your management access):**

1. Add a datacenter rule allowing your admin network to reach the host, **before** enabling
   the firewall, so you don't lock yourself out. On the Proxmox host shell:
   ```bash
   # allow your LAN admin subnet to the Proxmox web UI + SSH (adjust the CIDR)
   pvesh create /cluster/firewall/rules -type in -action ACCEPT -source 192.168.50.0/24 -dport 8006 -enable 1 -comment "mgmt web"
   pvesh create /cluster/firewall/rules -type in -action ACCEPT -source 192.168.50.0/24 -dport 22   -enable 1 -comment "mgmt ssh"
   ```
2. Enable the cluster firewall:
   ```bash
   pvesh set /cluster/firewall/options -enable 1
   ```
   Proxmox automatically permits cluster/corosync traffic between nodes, so quorum is not
   affected. Verify you still have web/SSH access immediately. To revert: `pvesh set /cluster/firewall/options -enable 0`.

Once enabled, ProxMate's per-VM rules are enforced and the Settings page shows **Enforced**.

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

ProxMate currently provisions **QEMU VMs only** (not LXC). The same isolation model would
apply to containers if added; LXC additionally benefits from running **unprivileged**.

---

## 4. Other security considerations

| Area | Posture |
|------|---------|
| Proxmox API token | Stored AES-256-GCM encrypted in the DB; never sent to the browser. **Scope it down** — see below. |
| Secrets at rest | `proxmox_token_secret` and `jwt_secret` are encrypted with `ENCRYPTION_KEY` (AES-256-GCM, random IV + auth tag). |
| Passwords | bcrypt (cost 12). Login runs bcrypt even for unknown emails to prevent timing-based account enumeration. |
| Sessions / JWT | 24h JWTs with a random `jti`; every token is backed by a `Session` row, so logout / revocation is server-side. |
| Invites | 32-byte URL-safe random tokens, single-use (claimed atomically), with an expiry. |
| Input validation | All request bodies validated with Zod; Prisma parameterizes all queries. |
| Transport | Run ProxMate behind HTTPS in production (reverse proxy). Set `verifySsl=true` once Proxmox has a valid cert. |
| CORS | Restricted to `FRONTEND_URL`. |
| Console tickets | One-time, short-lived Proxmox VNC tickets; the console WebSocket verifies JWT + VM ownership before relaying. |
| Rate limiting | Built-in `express-rate-limit` on `/auth/login`, `/auth/register`, `/auth/invite/:token` (env-tunable). Honors `trust proxy`. |
| Audit log | VM lifecycle (create/delete/start/stop/restart/restore) and auth events are recorded with actor + client IP; admin-viewable at `/admin/audit`. |

### Recommended: scope the Proxmox API token

ProxMate works with a `root@pam` token, but for least privilege create a dedicated user
(e.g. `proxmate@pve`) with only the roles it needs (VM lifecycle, console, storage/audit,
firewall) on the relevant nodes/pool, and use that token instead. ProxMate needs:
`VM.Allocate`, `VM.Config.*`, `VM.PowerMgmt`, `VM.Console`, `VM.Audit`, `Datastore.Audit`,
`Datastore.AllocateSpace`, and `Sys.Audit` (+ firewall management for isolation).

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
- [ ] Keep Proxmox VE patched (guest→host isolation ultimately depends on the hypervisor).
