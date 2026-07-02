## ✨ Highlights

**Your VM's Tailscale IP is now one click away.** When Tailscale is running inside a
VM or container, its tailnet address shows up right on the machine's page — copy it and
SSH in from any device on your tailnet, no hunting through `tailscale status`.

### 🔗 Tailscale IP on the VM page

- A new **Tailscale IP** row appears under **Connection details** on a machine's
  Overview tab, right below its LAN IP, with a one-click copy button — but only when
  Tailscale is actually running inside the guest.
- Detected automatically from the same network info ProxMate already reads (the QEMU
  guest agent for VMs, Proxmox's container introspection for LXC) — nothing to configure
  beyond installing Tailscale in your machine. It's recognized by the `tailscale`
  interface or by Tailscale's address range (100.64.0.0/10), and clears itself if
  Tailscale stops.
- Works for both full VMs and LXC containers, and it's exposed on the public REST API
  (`tailscaleIp`) too.

### 🐛 Fix: Tailscale no longer hijacks the "IP address" field

Previously, if a machine's Tailscale interface happened to be listed first, its `100.x`
address could show up as the machine's main **IP address** instead of its real LAN IP.
Tailscale addresses are now kept in their own field and can never shadow the LAN IP.

### 📸 Refreshed README screenshots

Every screenshot in the project README (except the console shot) was recaptured against
the current UI — the dashboard, live monitor, Template Store, create-a-VM wizard, and
setup wizard now reflect how ProxMate actually looks today.

## 🔄 Upgrade notes

- **One small database migration** (`add_tailscale_ip`), applied automatically when the
  API container starts — no manual step. No new environment variables, no breaking
  changes.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## 🧪 Verification

- Backend: typecheck + full Vitest suite green (**331 tests**, +9 for Tailscale-IP
  detection across both guest kinds and the LAN-IP shadow regression). Frontend:
  typecheck, lint, and production build green; the new row was verified in-browser
  against a guest advertising a Tailscale interface.
