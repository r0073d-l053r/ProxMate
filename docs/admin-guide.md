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

- **User:** `root@pam` (simplest). For least privilege, skip this dialog and run
  `deploy/proxmox-token.sh` on a node instead: it creates a `proxmate@pve` user, a
  `ProxMate` role with only what ProxMate uses, and the token (see DEPLOYMENT.md §2.2)
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

Whichever you choose, the token must be able to set guest tags (`VM.Config.Options`):
ProxMate tags every guest it manages with the machine it belongs to. On Proxmox VE 8+ it
also needs `SDN.Use` (Proxmox checks it whenever a guest NIC is attached, plain bridges
included; `PVESDNUser` carries it), and `SDN.Audit` to list SDN VNets. A token with
privilege separation off, or the Administrator role, has all of these; the connection test
warns when either SDN privilege is missing.

Copy the secret that Proxmox shows you — **it's only shown once**.

### 1.2 Run the ProxMate setup wizard

Open the ProxMate web UI. The wizard walks you through:

1. **Admin account** — your owner login
2. **Proxmox connection** — host URL (`https://your-host:8006`), token ID, secret. Leave "Verify TLS" off for a self-signed cert on a private network. Click **Test connection** — you should see "Connected to Proxmox VE X.Y (N nodes)".
3. **Defaults** — pick the storage pool for VM disks (must support `images` — e.g. `local-lvm`, `local-zfs`, Ceph), the network for VMs (a Linux bridge such as `vmbr0`, an Open vSwitch bridge or an SDN VNet; or type its name if it isn't listed), and the ISO storage (typically `local`).
4. **Finish** — you're signed in as the admin from step 1 (every step after it needs that session).

---

## 2. Enforce tenant isolation

This is the one step that turns ProxMate's per-VM firewall rules from "configured" into "enforced". **Do it before you invite anyone.**

**Admin → Settings → Proxmox tab → Tenant network isolation:**

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

**Template Store → Add a cloud image** is the one-click path — no host shell, no ISO install. Pick a curated image (20 of them — Debian 11/12/13, Ubuntu 20.04/22.04/24.04, Fedora,
AlmaLinux 8/9, Rocky 8/9, CentOS Stream 9/10, Oracle 9, openSUSE Leap, Arch, plus four ARM64
builds) or paste a custom cloud-image URL (`.qcow2`/`.img`), give it a store name, and click **Add to store**. ProxMate downloads the image and builds a **cloud-init** template entirely through the Proxmox API (download → import the disk → attach a cloud-init drive → convert to a template). This takes a few minutes (the download is a few hundred MB) — leave the page open until it finishes.

When a tenant deploys a cloud-init template, the wizard asks for their **SSH public key** (and optional username/password). On first boot the VM applies the user + key + DHCP and is **ready to SSH into in ~60s — no installer**. The template carries a "Cloud-init" badge in the store.

> Notes: deploys of a cloud-init template are **full clones** (small cloud images, fast). When the template's disks and the default storage are shared (Ceph, NFS), each deploy goes to the node with the most free capacity; otherwise it stays on the template's node. Cloud genericcloud/cloudimg images don't ship the QEMU guest agent, so ProxMate's IP display may be blank until the guest agent is installed (the tenant can `apt install qemu-guest-agent`); reaching the box is the [Tailscale guide](./tailscale-ssh.md).

#### Cloud-init extras (first-boot installs)

Tenants can tick optional **first-boot installs** when deploying a cloud image — Docker, Tailscale, Superfile, Cockpit, Netdata, Caddy, code-server, the QEMU guest agent, and more. You choose, in **Template Store → Cloud-init extras (admin)**:

- **Options offered to tenants** — the checkboxes tenants see on the deploy wizard.
- **Installed automatically on every VM** — an always-on base (a sensible starting set is fail2ban, unattended-upgrades, and btop) layered onto every cloud-init deploy on top of whatever the tenant picks.

Both selections are also offered as a step in the first-time **setup wizard**, and a searchable snippet **picker** lets you inspect or copy the exact cloud-init code ProxMate writes.

**How the snippet gets onto the cluster** — the Proxmox API can't create cloud-init snippet files, so there are two modes:

1. **On-demand (recommended).** Point ProxMate at a shared snippets storage with the `SNIPPET_DIR` + `SNIPPET_STORAGE` env vars (see [DEPLOYMENT.md](../DEPLOYMENT.md)) — a directory mounted into the API container and backed by a storage every node can read (an NFS export is ideal). **Under Docker, `SNIPPET_DIR` is a path *inside* the container**, so as well as setting the variable you must add the matching bind-mount to `docker-compose.override.yml` (see `docker-compose.override.example.yml`); setting the variable alone leaves the path non-existent. ProxMate then **writes the exact combo a deploy needs, atomically, at deploy time** — nothing to place by hand. The card shows `automatic (<storage>)` when this is active.
2. **Manual fallback (unset).** Without those env vars, click **Enable snippets** on the card (enables the `snippets` content type on `local`), then SSH into **each Proxmox node** and run the `cat` command the card shows for each option; **Re-check nodes** confirms which are ready. An option's checkbox appears for tenants only once its snippet is present on the template's node.

Snippets are delivered as cloud-init **vendor-data**, so the SSH-key / user injection still applies. Notes: Docker's installer covers Debian/Ubuntu/Fedora/RHEL-family (Arch/openSUSE just skip it); **Install Tailscale only installs the client** — the tenant then SSHes in and runs `sudo tailscale up --ssh` to connect (see the [Tailscale guide](./tailscale-ssh.md)); web-UI tools (Cockpit, Netdata, code-server) bind a port the tenant firewall blocks, so reach them over Tailscale or an SSH tunnel.

> **Add a key to a running VM.** Beyond the deploy wizard, an admin/owner can add an SSH public key to an existing VM at any time from **VM → Settings → Recovery → Add an SSH key** — it's appended to the guest user's `authorized_keys` through the QEMU guest agent (no rebuild).

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

> **Linked clones** are fast and space-efficient (no full disk copy), so deploys take seconds. Two trade-offs to know: a linked clone stays on the **template's node** (full clones on shared storage are spread across nodes), and the template can't be deleted while clones still reference it. Tenants don't choose a node for custom (ISO) VMs either — ProxMate auto-places those on the node with the most free capacity.

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
- **Invite link expires in** — how long the link stays usable before someone redeems it
  (1/7/30/90 days, default 7 days). This is the *link's* clock.
- **Compute access** — how long the person may use the cluster **after** they sign up
  (a fixed term, or **never expires**). This is the *tenant's* clock, anchored at
  redemption, and you can change it per user later under Settings → Access. When it
  lapses the account is suspended and their VMs stop — nothing is deleted.

Click **Generate** and share the invite link. The tenant signs up, picks a template (or builds from an ISO), and is bounded by their quota.

### 4.1 Deploy a VM for a tenant (admin)

As an admin, the New-VM wizard shows an **Admin options** block:

- **Deploy for** — pick a tenant and the VM lands in *their* account (they own it; their quota
  applies, not yours).
- **Count against their quota** — uncheck to make the VM a **grant on top of their quota**: it's
  excluded from every usage calculation and stays exempt even when resized. Use it for loaners,
  classroom machines, or comped capacity.
- **Node** — pin the target node, or leave **Auto-select** (best capacity, same placement tenants
  get). Template deploys don't use the picker: a full clone on shared storage goes to the
  least-loaded node and anything else stays on the template's node, so the picker only
  applies to ISO and container builds.

A VM you deploy for a tenant is **admin-managed**: the tenant can operate it (start/stop, console,
IDE, backups) but **cannot resize or rebuild it** — both are admin-only, because the VM's
resources were granted by an admin and may be quota-exempt. A tenant hitting Rebuild on an
admin-deployed VM gets a 403. This is also a
quota-safety rule: a tenant who could grow a quota-exempt grant would sidestep quota entirely.
Resize it yourself from the VM's Actions ▸ Resize.

Admin actions on a tenant's VM (including this deploy) are recorded in the **admin audit log**
only — the tenant's per-VM Activity feed shows just their own and their shared users' actions.
The tenant is **emailed** that a machine was set up for them (needs SMTP), and on its page they
see an **Admin-managed** badge with "Set up by your admin — only an admin can resize or rebuild
it." instead of the resize and rebuild controls.

**Several machines at once.** For a Template Store source the wizard has a **Copies** field: with
more than one copy the name becomes a pattern, and `{n}` is the copy number (`web-{n}` gives
`web-1`, `web-2`, …). Tenants can deploy up to 20 copies at a time, admins up to 50. Admins can
also tick **One machine for each of several users** and choose the users: each gets one copy in
their own account (admin-managed, and quota-exempt if you untick **Count against their quota**).
Quota is checked for the whole batch before anything is cloned — if it doesn't all fit, nothing is
deployed. The copies then deploy a few at a time, each placed and isolated like a single deploy,
and the wizard shows each copy's result; one failing doesn't stop the rest.

### 4.2 VM sharing levels (what tenants can grant each other)

A VM's owner can share it from **VM ▸ Settings ▸ Shared access** at three levels: **Viewer**
(details, metrics, activity, and a view-only console), **Operator** (adds power actions + an
interactive console), **Manager** (adds settings, disks, and backups including downloads).

| Level | See the VM | Console | Power | Settings, disks, backups |
|---|---|---|---|---|
| Viewer | yes | view only | no | no |
| Operator | yes | interactive | yes | no |
| Manager | yes | interactive | yes | yes |

A Viewer opens the console from **View console** on the VM page (graphical or text). The console
shows a **View only** label: the screen and terminal output are live, but keyboard, mouse,
clipboard and paste are not sent. This is enforced by ProxMate's console relay, which drops every
input message from a view-only session before it reaches Proxmox, so a modified browser can't get
around it. A viewer always joins as a shared session and never disconnects anyone else's console.
Every console opened is recorded in the VM's activity feed ("Console opened", or "Console opened
(view only)" for a viewer). A viewer's text console keeps its own size: it can't resize the
terminal, so its view may wrap differently from the guest's. The ProxMate IDE opens only for the
owner, never through a share. No share can ever delete, rebuild,
migrate, or re-share the VM — those stay with the owner (and you, the admin). The API enforces
every level server-side.

Someone who already has an account is emailed when a VM is shared with them and when their level
changes. Sharing with an address that has no account yet sends **no** email — it waits as a
pending share, and inviting that address is a separate step — and the owner sees the same answer
either way.

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
- *Note:* Sign-ins through SSO are exempt from this requirement, since the Identity Provider handles authentication policy. A password login on an SSO-linked account still needs the second factor.

### 5.3 Bring-Your-Own SSO (OIDC)
You can delegate authentication to an external OpenID Connect (OIDC) provider (e.g., Keycloak, Authentik, Google) in **Admin → Settings → Single Sign-On (OIDC)**:
- **Enable SSO**: Toggles the login button on the sign-in screen.
- **Client ID & Client Secret**: Registered credentials from your provider (secret is encrypted at rest).
- **Issuer URL**: The discovery endpoint of your provider (e.g., `https://keycloak.example.com/realms/myrealm`).
- **Callback URL**: Register `${BACKEND_PUBLIC_URL}/api/auth/sso/callback` as the permitted redirect URI in your identity provider.
- **Group mapping**: Specify a "Groups Claim" (e.g., `groups` or `roles`) and the "Admin Group" name. Users with this group membership will be automatically promoted to Admin in ProxMate on login.
- **JIT Provisioning**: When "Allow self-sign up via SSO (JIT)" is checked, new users can sign up automatically via SSO. If unchecked, only users already linked to SSO, or existing users whose email can be safely matched, can sign in. An existing local account is linked on its first SSO login only when the identity provider marks the email as verified (`email_verified: true`) and the account was registered through an invite emailed to that address (or is the setup admin); otherwise the user is told to sign in with their password.

---

### 5.4 ProxMate IDE (optional — per-VM browser editor + AI agent)

Give tenants a browser VS Code (code-server) inside their own VM, with an in-guest OpenCode AI
agent wired to models you control. Enable and configure it in **admin Settings ▸ ProxMate IDE**:
pick the availability tier, add an OpenAI-compatible **model source** (a LAN Ollama is fine for
admins), choose which models tenants see, and set **`ide_ingress_cidr`**.

The IDE opens only for a VM's **owner**: admins and people the VM is shared with can't open it.
An IDE installed by ProxMate 1.0.x is reinstalled once, automatically, the first time its owner
opens it after the upgrade (about a minute).

Two things must be true for a deployment: the ProxMate host can reach tenant VM IPs on **:8080**
(or `IDE_GUEST_PORT`; provide routing on a non-flat network), and IDE VMs run the **qemu-guest-agent** with **>= 8 GB
RAM** and AVX (auto-handled via `cpu: host` + reboot). Full setup + security model:
[`proxmate-ide.md`](proxmate-ide.md).

## 6. Hand them the user docs

Once they have a VM running, point them at:

- [Tailscale SSH guide](./tailscale-ssh.md) — for "I want to SSH into my VM from my laptop"
- [Cloudflare Tunnels guide](./cloudflare-tunnels.md) — for "I want to host a public website"
- [External access overview](./external-access.md) — for the rule on no port forwarding and which tool to pick

The in-app **Help** page in ProxMate links to all of these.

---

## 7. Operating the cluster

A few things worth knowing day-to-day:

- **MateStates (backups)** run automatically every Sunday at 03:00 server time for every VM. We keep the 2 newest per VM and prune the rest (both the schedule and the retention count can be set per VM). Override the default schedule with `MATESTATE_CRON` (5-field cron) in the backend env.
- **ProxMate backs up its own database too** — nightly, via `VACUUM INTO` (consistent on a live DB) with rolling retention, configured under **Settings → Maintenance → App-database backups**. The snapshots land in the host directory you set as `PROXMATE_BACKUP_DIR`; see [DEPLOYMENT.md](../DEPLOYMENT.md) §12. **Keep a copy of `ENCRYPTION_KEY` off the host** — every secret inside those snapshots is encrypted with it, so a backup without the key restores nothing usable.
- **Compute access windows** — tenants can be given a fixed term of cluster access (or none at all). Expiry **suspends, never deletes**: their VMs stop and sign-in is refused, and extending the window under **Settings → Access** restores everything. Warning emails at 7 days and 1 day need SMTP; the sweep runs hourly at :20 (override with `ACCESS_EXPIRY_CRON`).
- **Kiosk mode** — a full-screen, unattended wall-panel view at `/kiosk` for a rack-mounted display, reached from **Admin → Monitor → Kiosk mode** and configured in admin Settings. It is **monitoring only**: no VM power controls, no links off the panel, and no tenant identities on screen. Leaving kiosk mode requires a passkey, the admin-set exit PIN, or the account password, so a passer-by can look but not act.
- **Restoring a tenant VM** rewrites its config — ProxMate re-asserts the per-NIC firewall flag automatically.
- **Migrating a VM between nodes** (admin-only). On a VM's page, **Migrate** moves it to another node — **live, with no downtime** for a running guest, offline for a stopped one. Guests on node-local storage (`local-lvm` / ZFS) migrate live too (the disk is copied during the move; the target node must have a storage of the **same name**). The picker only lists nodes the guest can **actually reach** — a VM whose disks sit on a storage no other node has (e.g. a single-node ZFS pool) shows **"No eligible nodes"** rather than a target that would fail. Cross-architecture moves (x86↔ARM) are blocked. The VM's **owner is emailed a heads-up** whenever you move their VM.
- **Cluster Balancer** (**Admin → Balancer**) evens out node **memory** load — the binding constraint — by live-migrating ProxMate-managed guests off the busiest node. Pick a mode: **Off**, **Recommend only** (review the plan and apply by hand), or **Auto-apply** (acts every ~15 min; override with `BALANCER_CRON`). Tune the imbalance tolerance, a per-run move cap, and a never-move list. Keep specific guests on separate nodes with the tag `aa:<group>` (anti-affinity), and pin a guest in place with the tag `pin` or `no-balance`. It never proposes a move a guest **can't make** — a guest pinned to node-local storage is skipped automatically — and if a migration does fail, the audit log records Proxmox's real reason. Routine balancing never emails tenants.
- **GPU / PCI passthrough** (admin-approved). When you approve a tenant's passthrough request, ProxMate first runs a **pre-flight host-readiness check** on the target node — it refuses the approval if the mapped device is missing, its PCI identity doesn't match, or IOMMU is off, and it won't auto-start a GPU unless the guest boots q35 + OVMF. Host-side prep (binding the device to `vfio-pci`, enabling IOMMU in the kernel) is still the admin's job; the check turns a would-be node crash into an upfront, legible rejection.
- **Maintenance mode (node drain)** — also on the Balancer page. Before taking a node down, pick it and **Plan drain**: ProxMate evacuates every managed guest off it (auto best-fit, or all to one target you choose), running guests live, stopped offline. Anything it can't move automatically (e.g. a guest not managed by ProxMate) is listed so you can handle it before powering the node off.
- **Event notifications** (**Admin → Settings → Notifications**) — backup failures, VM errors,
  account lockouts, lapsed access windows and missing guest agents go to any mix of a **webhook**
  (Discord, Slack, Mattermost, generic JSON), an **ntfy** topic (ntfy.sh or self-hosted, with an
  optional access token), a **Telegram** chat (bot token from @BotFather + chat id) and **email**.
  URLs and tokens are stored encrypted and only ever shown masked; **Send test** reports each
  channel separately.
- **Weekly usage digest** (**Admin → Settings → Notifications**) — users who opt in (Security →
  Email preferences; off by default) get a Monday 08:00 (server time, UTC in Docker) email with their own machines, running
  hours, average CPU and memory over the week, and quota in use. Turn it off for everyone with the
  card's switch, or **Send me a preview** to see your own. Override the time with
  `USAGE_DIGEST_CRON`.
- **Broadcast emails** (**Admin → Settings → Broadcast email**) send an announcement to all users
  (maintenance, downtime, all-clear). In the Community Edition users may **unsubscribe from
  broadcasts** — via the unsubscribe link in each broadcast or **Security → Email preferences** — and
  are then skipped (the send result shows how many). Transactional and security emails (password
  resets, sign-in alerts, VM notifications) are never affected by the opt-out. Users can separately
  turn off **activity emails** (machines set up for them, shares) and opt in to the **weekly usage
  digest** on the same page. _(The EDU edition has
  no opt-out — instructors must be able to reach every student.)_
- **Unconfirmed machines** (**Settings → Maintenance → Unconfirmed machines**). ProxMate tags every guest it manages (`proxmate-<id>`) and only acts on a guest that carries its own machine's tag. The card lists machines whose VMID holds no guest with their tag — typically machines from before ownership tags that the automatic tagging couldn't match (left in `error` or `creating`, renamed so the Proxmox name differs, or sharing a VMID with another machine). Those machines can't be started, opened, backed up or deleted until you settle them: **Adopt** tags the guest at the VMID as that machine's and, for an `error` or held machine, re-applies network isolation and re-reads its sizes (as a restore does) before clearing that state, **Remove row** deletes only the ProxMate record and leaves the guest alone. Admins are notified once when the automatic tagging leaves machines unmatched.
- **Import existing guests** (**Settings → Maintenance → Import existing guests**). Lists the Proxmox guests (VMs and containers) ProxMate doesn't manage: no machine references them, they carry no ProxMate tag, and they aren't templates. **Import** one and choose its owner: ProxMate records it as their machine from its current size, tags it (keeping its other tags), moves its network interfaces to the default bridge with the isolation firewall — exactly as for a new machine — and counts it toward the owner's quota. Untick **Count against their quota** to import it as a grant instead; an import that would exceed the quota is refused with the owner named. Guests that reference another guest's disks or host paths, have host devices (PCI, USB, serial, virtiofs), raw host settings or hook scripts, or are privileged containers are refused — and so is a guest with a snapshot holding any of those, since its owner could roll back to it (the message names the snapshots to delete). Remove those in Proxmox first (a GPU can then be attached through a passthrough request). Expect the guest's network to change: its interfaces move to the default bridge, and the ProxMate isolation firewall is switched on (inbound traffic dropped by default, `firewall=1` on every interface). The guest's own firewall rules are kept, below ProxMate's, so a service it offers inbound may need a rule added. While an import runs the machine shows as being created and can't be used.
- **Machines that can't run.** A machine left in `error`, or held after a create, rebuild or restore that didn't finish (or a restore that left its owner over quota), can't be started and its console and IDE don't open; its page says why. It can be restored, rebuilt, adopted under **Unconfirmed machines**, or deleted. Bulk actions, migrations, the Balancer and node drains also skip a machine while its IDE installs or its cloud-init deploy finishes, and report it.
- **Deleting a tenant** in **Admin → Users** also destroys their VMs on Proxmox. If any of their machines can't be deleted with its guest (an unconfirmed machine, or a guest that fails to delete), the account is kept and the machines are listed — settle them under **Unconfirmed machines**, then delete again.
- **Re-configuring Proxmox** later (new host, rotated token) is in **Admin → Settings**; the existing token secret is kept if you leave the field blank.

---

## 8. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| "Connection test" passes but storage lists are empty | Privilege Separation on the API token — see §1.1 |
| A machine answers "This VM predates ProxMate's ownership tags — ask an admin", or can't be started | It isn't matched to a tagged guest (or is held after a failed create/restore) — check **Settings → Maintenance → Unconfirmed machines** (§7) |
| Tenant VM creation fails with a 403 | Same as above |
| Tenants can reach my LAN | The cluster firewall isn't enabled — see §2 |
| `vzdump` fails for a tenant VM | The chosen storage doesn't support `content=backup` — enable it in Proxmox **Datacenter → Storage** |
| Console (noVNC) won't connect | Browser blocked the WebSocket; check the ProxMate backend reverse-proxy forwards `Upgrade` headers |
| The scheduled backup didn't run | Backend was offline at the scheduled time, or `MATESTATE_CRON` is invalid (check backend logs for the warning) |
| Live-migrating a VM fails ("can't migrate local disk" / storage error) | The target node needs a storage of the **same name** as the source. Cross-architecture (x86↔ARM) moves are blocked by design. A stopped VM migrates offline regardless |
| "No container templates available" in the create wizard | No `vztmpl` OS template is present on the cluster — add one via `pveam download …` or Proxmox **CT Templates** (see §3.4) |
