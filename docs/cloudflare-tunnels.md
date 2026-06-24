# Cloudflare Tunnel — Publish a public website from your VM

A step-by-step guide for **tenants** who want to host something the public
internet can reach (a website, an API, a webhook receiver, etc.) without
any port forwarding on the host network.

> **Use this only for public services.** If only you or your friends need to
> reach it, use [Tailscale](./tailscale-ssh.md) instead — it's simpler, faster,
> and keeps the service private.

---

## What Cloudflare Tunnel does

It runs a small daemon (`cloudflared`) inside your VM that makes an
**outbound** connection to Cloudflare's network. Cloudflare then routes traffic
from a public hostname (`yourapp.yourdomain.com`) **through** that connection
to your local app. The internet only ever sees Cloudflare's IPs.

You get, for free:

- a public HTTPS endpoint with a valid TLS certificate (Cloudflare issues it),
- DDoS protection and a CDN in front of your app,
- **no port forwarding** on the host network,
- no public IP exposed for the VM or the host.

You need:

- a free Cloudflare account,
- a domain in Cloudflare DNS (a `.dev` from Cloudflare Registrar is ~$10/yr if
  you don't have one),
- a service listening on a TCP port **inside the VM** (e.g. a Node app on
  `:3000`).

---

## Step 0 — Sign up at Cloudflare (one time)

1. Create an account at https://dash.cloudflare.com/sign-up
2. **Add your domain** ("Add a site" on the dashboard) and update its
   nameservers at your registrar to point at Cloudflare. If your domain is
   already registered with Cloudflare Registrar, this is automatic.

You only do this once per Cloudflare account.

---

## Step 1 — Open your VM's console in ProxMate

In the ProxMate UI, click your VM → **Console**, log in.

> Pre-baked templates may already have `cloudflared` installed — the login
> banner will say so. If yes, skip Step 2.

---

## Step 2 — Install `cloudflared` inside the VM

Debian/Ubuntu (most common):

```bash
sudo apt update
sudo apt install -y curl
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(. /etc/os-release && echo $VERSION_CODENAME) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update
sudo apt install -y cloudflared
```

Other distros: see https://pkg.cloudflare.com/ or download a static binary from
https://github.com/cloudflare/cloudflared/releases.

Confirm it's installed:

```bash
cloudflared --version
```

---

## Step 3 — Log `cloudflared` into your Cloudflare account

```bash
cloudflared tunnel login
```

It prints a URL. **Open it in your laptop's browser**, sign in to Cloudflare,
and pick the domain you want the tunnel under. Cloudflare downloads a
certificate to `~/.cloudflared/cert.pem` inside the VM.

You only do this once per VM.

---

## Step 4 — Create a tunnel

```bash
cloudflared tunnel create my-app
```

Replace `my-app` with anything memorable. The command prints a UUID and writes
a credentials file at `~/.cloudflared/<UUID>.json`. Note both — you'll need the
UUID once.

---

## Step 5 — Write a tunnel config

Create `~/.cloudflared/config.yml` with your editor of choice. Suppose your app
listens on `http://localhost:3000` and you want it at `app.example.com`:

```yaml
tunnel: <THE-UUID-FROM-STEP-4>
credentials-file: /home/you/.cloudflared/<THE-UUID-FROM-STEP-4>.json

ingress:
  - hostname: app.example.com
    service: http://localhost:3000
  # Catch-all (required) — anything else returns 404
  - service: http_status:404
```

> If your app uses a different port, change `http://localhost:3000`. For TCP
> services use `tcp://localhost:5432` etc. — see the
> [Cloudflare ingress reference](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/ingress/).

---

## Step 6 — Point a public hostname at the tunnel

```bash
cloudflared tunnel route dns my-app app.example.com
```

This creates a CNAME `app.example.com → <UUID>.cfargotunnel.com` in Cloudflare
DNS automatically. You can confirm in the Cloudflare dashboard under your
domain → DNS.

---

## Step 7 — Run the tunnel

Test it in the foreground first:

```bash
cloudflared tunnel run my-app
```

Now visit `https://app.example.com` in any browser. You should see your app —
served over HTTPS, with a valid Cloudflare certificate, from a VM that has zero
inbound ports open.

Press `Ctrl+C` to stop.

---

## Step 8 — Make it run on boot

Install the systemd service that ships with `cloudflared`:

```bash
sudo cloudflared --config /home/$USER/.cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

The tunnel now starts on boot and restarts automatically if it crashes.

---

## Step 9 — (Optional) Lock the public hostname down

By default, anyone on the internet can hit `app.example.com`. You can add
**Cloudflare Access** in the Zero Trust dashboard
(https://one.dash.cloudflare.com → Access → Applications) to require:

- a Google / GitHub / email-OTP login,
- a specific email allow-list,
- a country / device-posture check.

This sits in front of the tunnel — your app sees only authenticated requests,
without writing any auth code yourself. (Free up to 50 users.)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cloudflared: command not found` | Step 2 didn't finish. Re-check the apt source line. |
| `unable to connect to the origin` in `cloudflared` logs | Your app isn't actually listening on the port you put in `config.yml`. Test locally: `curl http://localhost:3000`. |
| `Error 1033 Argo Tunnel error` in the browser | The tunnel daemon isn't running on the VM. `sudo systemctl status cloudflared`. |
| Browser shows Cloudflare's "host unreachable" page | DNS record didn't propagate yet (give it ~30 s) or `Step 6` was skipped. Check the DNS tab in the Cloudflare dashboard. |
| It works for HTTP but not WebSockets | Cloudflare proxies WebSockets by default; no extra config needed. If you see 400s, check that your app sends `Upgrade: websocket` headers correctly. |
| I want to expose two services on one VM | Add more `hostname:` / `service:` pairs in the `ingress:` list (and a `cloudflared tunnel route dns` for each one). The catch-all `http_status:404` entry must be last. |

---

## Notes on the host firewall and ProxMate

You do **not** need to:

- ask the cluster admin to open any port,
- adjust ProxMate's per-VM firewall,
- get a public IP for the VM.

`cloudflared` only makes outbound connections to Cloudflare on `443`, which
the firewall already allows (outbound to the public internet is permitted by
default).
