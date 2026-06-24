# Admin Guide — Cluster Setup & Templates

This is the cluster owner's guide. By the end you'll have:

1. A Proxmox cluster ProxMate can talk to
2. Tenant isolation enforced at the network layer
3. A small Linux template tenants can deploy from in one click

---

## 1. Prepare the Proxmox cluster

ProxMate talks to Proxmox over its HTTPS REST API on port `8006`. You need:

- a Proxmox node (or cluster) reachable from the host running ProxMate,
- an **API token** for ProxMate to use, with permissions to manage VMs.

### 1.1 Create the API token

In Proxmox: **Datacenter → Permissions → API Tokens → Add**.

- **User:** `root@pam` (simplest), or a dedicated `proxmate@pam` user
- **Token ID:** `proxmate`
- **Privilege Separation:** **uncheck this box** — see below

> ⚠️ **The #1 setup pitfall.** Proxmox enables Privilege Separation by default,
> which gives the token an *empty* permission set even when the user is `root`.
> If you forget this, ProxMate's connection test passes, storage lists come back
> empty, and VM creation 403s.
>
> If you'd rather keep privsep on, leave it checked and grant the token a role:
> ```bash
> pveum acl modify / --tokens 'root@pam!proxmate' --roles Administrator
> ```

Copy the secret that Proxmox shows you — **it's only shown once**.

### 1.2 Run the ProxMate setup wizard

Open the ProxMate web UI. The wizard walks you through:

1. **Admin account** — your owner login
2. **Proxmox connection** — host URL (`https://your-host:8006`), token ID, secret. Leave "Verify TLS" off for a self-signed cert on a private network. Click **Test connection** — you should see "Connected to Proxmox VE X.Y (N nodes)".
3. **Defaults** — pick the storage pool for VM disks (must support `images` — e.g. `local-lvm`, `local-zfs`, Ceph), the network bridge for VMs (e.g. `vmbr0`), and the ISO storage (typically `local`).
4. **Finish** — you're auto-logged in as the admin.

---

## 2. Enforce tenant isolation

This is the one step that turns ProxMate's per-VM firewall rules from "configured" into "enforced". **Do it before you invite anyone.**

**Admin → Settings → Tenant network isolation:**

- "Apply isolation firewall to new VMs" — **leave checked**
- "Enable enforcement" — **click it**

ProxMate auto-derives your management subnet from the cluster's bridge CIDR (shown in the dialog as e.g. `192.168.1.0/24`), pre-adds allow-rules for the Proxmox web UI (`8006`) and SSH (`22`) from that subnet, **then** flips the datacenter firewall on. Corosync/cluster traffic is handled by Proxmox automatically.

After this is on, every tenant VM gets:

- inbound **DROP** by default,
- outbound **DROP** to all RFC1918 ranges (your LAN, your other VMs, the Proxmox host),
- outbound **ALLOW** to the public internet + DNS.

Tenants can still install Tailscale and Cloudflare Tunnel inside their VMs because those are outbound-only.

> See [SECURITY.md](../SECURITY.md) for the full isolation model, including the "gold-standard" dedicated-VLAN setup.

---

## 3. Prepare a tenant-friendly Linux template

Tenants can build a VM from an ISO, but it's faster and more consistent to ship a small template they can deploy from in one click. Goal: a minimal Debian/Ubuntu image with the QEMU guest agent, optional pre-installed Tailscale, and a sensible cloud-init / first-boot user setup.

### 3.1 Build the base VM

From ProxMate (or Proxmox directly), create a small VM with the OS ISO you want to template — Debian 12 is recommended (small footprint, broad compatibility).

Suggested specs for the base template: 1 vCPU / 1 GB RAM / 8 GB disk. The tenant picks their final size when they deploy.

Install the OS the usual way through the noVNC console.

### 3.2 Tune the guest

After first boot, log in via console and do a one-time prep:

```bash
# Updates
sudo apt update && sudo apt full-upgrade -y

# QEMU guest agent — lets Proxmox/ProxMate see real memory stats and shut down cleanly
sudo apt install -y qemu-guest-agent
sudo systemctl enable --now qemu-guest-agent

# Tailscale (so tenants are one `sudo tailscale up` away from SSH access)
curl -fsSL https://tailscale.com/install.sh | sh
# DO NOT run `tailscale up` here — each tenant authenticates from their own account.

# Cloudflared (only if you expect public-facing tenants)
sudo apt install -y curl
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(. /etc/os-release && echo $VERSION_CODENAME) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

# Optional but recommended: small login banner so tenants know what to do next
sudo tee /etc/motd >/dev/null <<'EOF'

  This VM is hosted on ProxMate.
  - For SSH from anywhere: `sudo tailscale up` (see docs/tailscale-ssh.md)
  - For public web apps:    `cloudflared` (see docs/cloudflare-tunnels.md)
  - DO NOT ask the host admin for port forwarding — both tools work without it.

EOF

# Clean up so the cloned VM starts fresh
sudo cloud-init clean --logs 2>/dev/null || true
sudo truncate -s 0 /etc/machine-id
sudo rm -f /var/lib/dbus/machine-id && sudo ln -s /etc/machine-id /var/lib/dbus/machine-id
sudo apt clean
history -c && history -w
sudo poweroff
```

### 3.3 Publish as a ProxMate template

Once the VM is powered off:

1. In Proxmox, **right-click the VM → Convert to Template**.
2. In ProxMate, go to **Templates → Add Template** and select the VM you just converted. Give it a name (e.g. "Debian 12 — pre-baked") and a short description.

It now appears in the **Template Store** for everyone. When a tenant deploys it, ProxMate full-clones it on the chosen node and resizes the disk to whatever the tenant picked.

> **Why full-clone, not linked-clone?** Linked clones depend on the template file being present on the same storage; a full clone is independent and survives template deletion. Worth the extra disk.

---

## 4. Invite tenants

**Admin → Invites → New invite:**

- pick the resource quota for that user (CPU cores, RAM in GB, disk in GB),
- optional label so you remember who it's for,
- expiry (default 7 days).

Click **Generate** and share the invite link. The tenant signs up, picks a template (or builds from an ISO), and is bounded by their quota.

---

## 5. Hand them the user docs

Once they have a VM running, point them at:

- [Tailscale SSH guide](./tailscale-ssh.md) — for "I want to SSH into my VM from my laptop"
- [Cloudflare Tunnels guide](./cloudflare-tunnels.md) — for "I want to host a public website"
- [External access overview](./external-access.md) — for the rule on no port forwarding and which tool to pick

The in-app **Help** page in ProxMate links to all of these.

---

## 6. Operating the cluster

A few things worth knowing day-to-day:

- **MateStates (backups)** run automatically every Sunday at 03:00 server time for every VM. We keep the 2 newest per VM and prune the rest. Override the schedule with `MATESTATE_CRON` (5-field cron) in the backend env.
- **Restoring a tenant VM** rewrites its config — ProxMate re-asserts the per-NIC firewall flag automatically.
- **Deleting a tenant** in **Admin → Users** also destroys their VMs (best-effort) on Proxmox.
- **Re-configuring Proxmox** later (new host, rotated token) is in **Admin → Settings**; the existing token secret is kept if you leave the field blank.

---

## 7. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| "Connection test" passes but storage lists are empty | Privilege Separation on the API token — see §1.1 |
| Tenant VM creation fails with a 403 | Same as above |
| Tenants can reach my LAN | The cluster firewall isn't enabled — see §2 |
| `vzdump` fails for a tenant VM | The chosen storage doesn't support `content=backup` — enable it in Proxmox **Datacenter → Storage** |
| Console (noVNC) won't connect | Browser blocked the WebSocket; check the ProxMate backend reverse-proxy forwards `Upgrade` headers |
| The scheduled backup didn't run | Backend was offline at the scheduled time, or `MATESTATE_CRON` is invalid (check backend logs for the warning) |
