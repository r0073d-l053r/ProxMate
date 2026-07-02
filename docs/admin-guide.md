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

> **The #1 setup pitfall.** Proxmox enables Privilege Separation by default,
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

Tenants can build a VM from an ISO, but it's faster and more consistent to ship a small template they can deploy from in one click.

### 3.0 Easiest: add a cloud image (recommended)

**Template Store → Add a cloud image** is the one-click path — no host shell, no ISO install. Pick a curated image (Debian 12/13, Ubuntu 22.04/24.04) or paste a custom cloud-image URL (`.qcow2`/`.img`), give it a store name, and click **Add to store**. ProxMate downloads the image and builds a **cloud-init** template entirely through the Proxmox API (download → import the disk → attach a cloud-init drive → convert to a template). This takes a few minutes (the download is a few hundred MB) — leave the page open until it finishes.

When a tenant deploys a cloud-init template, the wizard asks for their **SSH public key** (and optional username/password). On first boot the VM applies the user + key + DHCP and is **ready to SSH into in ~60s — no installer**. The template carries a "Cloud-init" badge in the store.

> Notes: deploys of a cloud-init template are **full clones** (small cloud images, fast) that stay on the template's node. Cloud genericcloud/cloudimg images don't ship the QEMU guest agent, so ProxMate's IP display may be blank until the guest agent is installed (the tenant can `apt install qemu-guest-agent`); reaching the box is the [Tailscale guide](./tailscale-ssh.md).

#### Enable the "Install Docker" / "Install Tailscale" options (cloud-init extras)

Tenants can check **Install Docker** and/or **Install Tailscale** when deploying a cloud image — each installs on first boot. It needs a one-time setup because the Proxmox API can't create cloud-init snippet files:

1. In **Template Store → Cloud-init extras (admin)**, click **Enable snippets** (ProxMate enables the `snippets` content type on `local` via the API).
2. SSH into **each Proxmox node** and run the command the card shows for each option you want to offer — Docker, Tailscale, **and** Docker + Tailscale. Each `cat`s a small cloud-init **vendor-data** snippet into `/var/lib/vz/snippets/`. The combined snippet is needed only if a tenant selects both at once (Proxmox allows one vendor snippet per VM). The card's **Re-check nodes** button confirms which are ready.

Once a snippet shows ready, its checkbox appears for cloud-init templates on that node. Snippets are delivered as vendor-data, so the SSH-key/user injection still works (verified). Notes: Docker's installer covers Debian/Ubuntu/Fedora/RHEL-family (Arch/openSUSE just skip it). **Install Tailscale only installs the client** — the tenant then SSHes in and runs `sudo tailscale up --ssh` to connect (see the [Tailscale guide](./tailscale-ssh.md)).

The rest of this section is the **manual** route — build your own template from an ISO (useful if you want pre-baked tooling like Tailscale, or a non-cloud-init image).

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

1. In Proxmox, **right-click the VM → Convert to Template** (or use **Save as template** on the VM's detail page in ProxMate).
2. In ProxMate, go to **Template Store → Add from cluster** and **Publish** the template you just converted. In the same row you can add **login notes** (e.g. the default username/password) — these are shown to tenants in the store and again in the create wizard, so they know how to sign in once the VM boots. You can edit the notes anytime with the pencil on the published card.

It now appears in the **Template Store** for everyone. When a tenant deploys it, ProxMate **linked-clones** it and autoscales (sets cores/RAM, grows the disk to the size the tenant picked, never below the template's base).

> **Linked clones** are fast and space-efficient (no full disk copy), so deploys take seconds. Two trade-offs to know: a clone stays on the **template's node**, and the template can't be deleted while clones still reference it. Tenants don't choose a node for custom (ISO) VMs either — ProxMate auto-places those on the node with the most free capacity.

### 3.4 Container (LXC) OS templates

Tenants can also deploy **LXC containers** — lightweight guests that share the host kernel and boot in seconds — via the **"Container (LXC)"** source in the New-VM wizard. Instead of an ISO they pick an **OS template** (a `vztmpl` tarball) plus a root password and/or SSH key.

Add container templates through **Proxmox** (the download is a Proxmox action, not a ProxMate one), the same way you add ISOs:

```bash
pveam update
pveam available --section system        # list what's downloadable
pveam download local debian-12-standard_12.7-1_amd64.tar.zst
```

Or in the Proxmox UI: **node → your template storage (e.g. `local`) → CT Templates → Download**. Once present, a template appears in ProxMate's wizard under **Container (LXC)** on any node that holds it. Node-local template storage only keeps the file on the node it was downloaded to, so download it to each node (or use shared storage) if you want placement flexibility. ProxMate then auto-places the container on a node that has the chosen template.

**What containers support:** create, start/stop/restart, in-browser console, tenant isolation, quotas, cpu/RAM/rootfs resize, and MateStates backups. **VM-only** (not on containers): rebuild, convert-to-template, extra data disks, snapshots, cloud-init extras, and **live migration** — so the [Cluster Balancer](#7-operating-the-cluster) treats containers as *pinned*, and a node drain lists them for you to stop or move by hand before powering the node off.

---

## 4. Invite tenants

**Admin → Invites → New invite:**

- pick the resource quota for that user (CPU cores, RAM in GB, disk in GB),
- optional label so you remember who it's for,
- expiry (default 7 days).

Click **Generate** and share the invite link. The tenant signs up, picks a template (or builds from an ISO), and is bounded by their quota.

## 5. Security & Authentication Controls (SMTP, MFA, SSO)

ProxMate provides robust security features to protect accounts and control how users authenticate, including Multi-Factor Authentication (MFA), passwordless Passkeys, OpenID Connect (OIDC) Single Sign-On (SSO), and secure email-based password recovery.

### 5.1 SMTP Settings & Password Recovery
To enable self-service password reset links, configure your mail server in **Admin → Settings → Email (SMTP)**:
- **Host / Port / Encryption**: Enter your SMTP server details (e.g., SMTP Host, Port, and select Secure TLS/SSL if required).
- **Authentication**: Specify your SMTP Username and Password (encrypted at rest in the database).
- **From Address**: The sender address for ProxMate emails.
- Click **Test Configuration** to verify connection.

If SMTP is **not configured**, ProxMate defaults to a secure fallback:
- When a user clicks "Forgot password" on the login screen, they file a password reset request.
- The request is saved in the database, and a banner appears in the admin panel (**Admin → Users → Reset Requests**).
- You can manually generate a temporary password or reset their password directly from the user list.

### 5.2 Multi-Factor Authentication (MFA / 2FA)
Users can secure their accounts using two-step verification methods in their personal dashboard under the **Security** settings page:
1. **TOTP (Authenticator Apps)**: Scanning a QR code with apps like Google Authenticator or Aegis. Standard 10 single-use recovery codes are generated upon activation.
2. **Passkeys (WebAuthn)**: Registering a security key (YubiKey) or biometric authentication (Touch ID / Windows Hello) for passwordless login.

#### Invite-Enforced 2FA
Admins can enforce two-step authentication for new users:
- When generating an invite link (**Admin → Invites → New invite**), check **"Require two-step authentication"**.
- Upon registration, the invited user will be forced to enroll in either TOTP or a Passkey before accessing any dashboard or VM operations.
- Until MFA is set up, they will be redirected to the Security page on every navigation, and all VM API requests will return a `403 MFA Setup Required` error.
- *Note:* SSO-linked users are exempt from this requirement since their Identity Provider handles authentication policy.

### 5.3 Bring-Your-Own SSO (OIDC)
You can delegate authentication to an external OpenID Connect (OIDC) provider (e.g., Keycloak, Authentik, Google) in **Admin → Settings → Single Sign-On (OIDC)**:
- **Enable SSO**: Toggles the login button on the sign-in screen.
- **Client ID & Client Secret**: Registered credentials from your provider (secret is encrypted at rest).
- **Issuer URL**: The discovery endpoint of your provider (e.g., `https://keycloak.example.com/realms/myrealm`).
- **Callback URL**: Register `${BACKEND_PUBLIC_URL}/api/auth/sso/callback` as the permitted redirect URI in your identity provider.
- **Group mapping**: Specify a "Groups Claim" (e.g., `groups` or `roles`) and the "Admin Group" name. Users with this group membership will be automatically promoted to Admin in ProxMate on login.
- **JIT Provisioning**: When "Allow self-sign up via SSO (JIT)" is checked, new users can sign up automatically via SSO. If unchecked, only pre-invited or existing users whose emails match the SSO provider's claims can sign in.

---

## 6. Hand them the user docs

Once they have a VM running, point them at:

- [Tailscale SSH guide](./tailscale-ssh.md) — for "I want to SSH into my VM from my laptop"
- [Cloudflare Tunnels guide](./cloudflare-tunnels.md) — for "I want to host a public website"
- [External access overview](./external-access.md) — for the rule on no port forwarding and which tool to pick

The in-app **Help** page in ProxMate links to all of these.

---

## 7. Operating the cluster

A few things worth knowing day-to-day:

- **MateStates (backups)** run automatically every Sunday at 03:00 server time for every VM. We keep the 2 newest per VM and prune the rest. Override the schedule with `MATESTATE_CRON` (5-field cron) in the backend env.
- **Restoring a tenant VM** rewrites its config — ProxMate re-asserts the per-NIC firewall flag automatically.
- **Migrating a VM between nodes** (admin-only). On a VM's page, **Migrate** moves it to another node — **live, with no downtime** for a running guest, offline for a stopped one. Guests on node-local storage (`local-lvm` / ZFS) migrate live too (the disk is copied during the move; the target node must have a storage of the **same name**). Cross-architecture moves (x86↔ARM) are blocked. The VM's **owner is emailed a heads-up** whenever you move their VM.
- **Cluster Balancer** (**Admin → Balancer**) evens out node **memory** load — the binding constraint — by live-migrating ProxMate-managed guests off the busiest node. Pick a mode: **Off**, **Recommend only** (review the plan and apply by hand), or **Auto-apply** (acts every ~15 min; override with `BALANCER_CRON`). Tune the imbalance tolerance, a per-run move cap, and a never-move list. Keep specific guests on separate nodes with the tag `aa:<group>` (anti-affinity), and pin a guest in place with the tag `pin` or `no-balance`. Routine balancing never emails tenants.
- **Maintenance mode (node drain)** — also on the Balancer page. Before taking a node down, pick it and **Plan drain**: ProxMate evacuates every managed guest off it (auto best-fit, or all to one target you choose), running guests live, stopped offline. Anything it can't move automatically (e.g. a guest not managed by ProxMate) is listed so you can handle it before powering the node off.
- **Deleting a tenant** in **Admin → Users** also destroys their VMs (best-effort) on Proxmox.
- **Re-configuring Proxmox** later (new host, rotated token) is in **Admin → Settings**; the existing token secret is kept if you leave the field blank.

---

## 8. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| "Connection test" passes but storage lists are empty | Privilege Separation on the API token — see §1.1 |
| Tenant VM creation fails with a 403 | Same as above |
| Tenants can reach my LAN | The cluster firewall isn't enabled — see §2 |
| `vzdump` fails for a tenant VM | The chosen storage doesn't support `content=backup` — enable it in Proxmox **Datacenter → Storage** |
| Console (noVNC) won't connect | Browser blocked the WebSocket; check the ProxMate backend reverse-proxy forwards `Upgrade` headers |
| The scheduled backup didn't run | Backend was offline at the scheduled time, or `MATESTATE_CRON` is invalid (check backend logs for the warning) |
| Live-migrating a VM fails ("can't migrate local disk" / storage error) | The target node needs a storage of the **same name** as the source. Cross-architecture (x86↔ARM) moves are blocked by design. A stopped VM migrates offline regardless |
| "No container templates available" in the create wizard | No `vztmpl` OS template is present on the cluster — add one via `pveam download …` or Proxmox **CT Templates** (see §3.4) |
