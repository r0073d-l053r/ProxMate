# Tailscale — SSH into your VM from anywhere

A step-by-step guide for **tenants** (people the admin has invited to ProxMate).

By the end of this guide you can `ssh` into your VM from your laptop, your
phone, or any other device — no port forwarding, no public IP needed.

> **Why Tailscale and not "just open SSH on port 22"?**
> ProxMate's per-VM firewall blocks all inbound connections by default, and
> there is **no port forwarding on the host network** (admin policy). Tailscale
> builds a small private network ("tailnet") of your own devices and the VM,
> all connected through an outbound-only tunnel — no firewall changes required.

---

## Step 0 — Sign up for Tailscale (one time)

Go to **https://login.tailscale.com/start** and sign up with your Google / GitHub / Microsoft / email account. The free "Personal" plan is generous (100 devices, all features you need here).

This is **your** account — separate from ProxMate, separate from the cluster admin. Only devices you authorize join your tailnet.

Install Tailscale on the device you'll connect **from** (laptop, phone, etc.):

- **macOS / Windows / iOS / Android** — official app: https://tailscale.com/download
- **Linux desktop** — `curl -fsSL https://tailscale.com/install.sh | sh` then `sudo tailscale up`

Sign in to the client with the account you just created. You should now see your laptop listed at https://login.tailscale.com/admin/machines.

---

## Step 1 — Open your VM's console in ProxMate

In the ProxMate UI, click your VM → **Console**. You should see the OS login prompt. Log in with the username/password you set during install.

> If your VM was deployed from a pre-baked template, Tailscale and `cloudflared` may already be installed — the login banner will say so. Skip to Step 3.

---

## Step 2 — Install Tailscale inside the VM

Run this inside your VM (Debian/Ubuntu/most Linux):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

It auto-detects your distro and installs the right package. For other systems, see https://tailscale.com/download.

This only needs to be done once per VM.

---

## Step 3 — Connect the VM to your tailnet

```bash
sudo tailscale up --ssh
```

Tailscale prints a URL. **Open it in any browser** (the easiest place is your laptop) and sign in with your Tailscale account. The browser confirms you're authorizing the VM to join your tailnet.

> `--ssh` is the magic flag. It tells Tailscale to handle SSH **for you** — no separate sshd port to open, no SSH keys to copy around, no passwords on the network. Tailscale uses your existing Tailscale identity.

When the browser says "Success", your terminal will continue. Confirm it worked:

```bash
tailscale status
```

You should see your VM at the top and your laptop (and any other devices on your tailnet) below.

---

## Step 4 — SSH in from your laptop

> 💡 **Tip:** once Tailscale is running inside the VM, ProxMate shows its **Tailscale IP**
> (the `100.x` address) with a copy button right on the VM's Overview page, under
> **Connection details** — no need to hunt for it.

On the device you installed Tailscale on (e.g. your laptop), find the VM's tailnet hostname:

```bash
tailscale status
```

Look for the line with your VM. It'll be something like:

```
100.95.12.34   my-vm-name      yourname@   linux   -
```

You can SSH using either the Tailscale IP or the hostname:

```bash
ssh yourusername@my-vm-name      # use the OS username you log in with on the console
# or
ssh yourusername@100.95.12.34
```

That's it — you're in. No password (Tailscale SSH replaces password auth with your Tailscale identity), no port forwarding, no public IP exposed.

---

## Step 5 — Make it survive reboots (default)

You don't need to do anything. `tailscale up` configures the service to start on boot, so the VM rejoins your tailnet automatically.

If you ever want to disconnect: `sudo tailscale down`. To rejoin: `sudo tailscale up --ssh`.

---

## Bonus — Reach a service inside the VM by name

Tailscale gives every machine a stable DNS name on your tailnet (MagicDNS). So if you start a dev server inside the VM on port 3000:

```bash
# inside the VM
python3 -m http.server 3000
```

…you can reach it from your laptop's browser at `http://my-vm-name:3000` — no firewall rules, no port forwarding. Only devices on your tailnet can see it.

This is perfect for personal dashboards, internal-only tools, your dev environment, Home Assistant exposed only to you, etc. **For anything public, use [Cloudflare Tunnels](./cloudflare-tunnels.md) instead.**

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `tailscale: command not found` | Step 2 didn't finish. Re-run `curl -fsSL https://tailscale.com/install.sh \| sh`. |
| `Permission denied (publickey)` when SSHing | You used `--ssh` on the VM and either your client device isn't on the tailnet, or you're trying to SSH as a user that doesn't exist on the VM. Run `tailscale status` on both ends to confirm both are listed. |
| VM doesn't show up in `tailscale status` on my laptop | The VM's `tailscale up` didn't finish authenticating. Re-run `sudo tailscale up --ssh` inside the VM and open the URL it prints. |
| Login URL won't load in the VM | Copy the URL into your laptop's browser instead — it's a Tailscale auth URL, not VM-local. |
| Tailscale stops working after a `cloudflared` install | Both should coexist; they don't conflict. If something broke, restart with `sudo systemctl restart tailscaled`. |

---

## What about non-Linux VMs?

Same idea — Tailscale has clients for Windows Server, FreeBSD, and others. See https://tailscale.com/download. The SSH-replacement (`--ssh`) is Linux-only; on other OSes use Tailscale as a network tunnel and connect with whatever remote tool that OS prefers (RDP for Windows, etc.).
