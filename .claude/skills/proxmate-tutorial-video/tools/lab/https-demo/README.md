# HTTPS demo on the creator's cluster (part three re-shoot onwards)

From part three's re-shoot, the videos run against a fresh ProxMate on the creator's real 7-node cluster
("QueenBee", Proxmox VE 9.2), served for real at https://dashboard.proxmate.host. Keycloak runs at
https://sso.proxmate.host. Both names go through a Cloudflare Tunnel that only carries these two routes. Nothing
is painted over in the edit: the padlock, the passkey prompt and the SSO redirect all really say these names.

ProxMate ties passkeys, the SSO callback, the console origin check and every link it prints to the one origin in
its `.env` (FRONTEND_URL, BACKEND_PUBLIC_URL, WEBAUTHN_*; passkey.service.ts, sso.service.ts). That is why this is
a separate instance and not the creator's own install under another name.

## What exists (all on node `pve`, the creator's pve-queenbee)

| Thing | Details |
|---|---|
| Pool `proxmate-demo` | every guest the video creates; the demo's token sees nothing else |
| CT 9201 `proxmate-demo` | Debian 13, unprivileged, nesting+keyctl, 4 cores, 6 GB, `tank:40`, **not** in the pool. ProxMate v1.3.4 by `install.sh --domain dashboard.proxmate.host` in `/opt/proxmate`; Caddy on 127.0.0.1:8080 (`Caddyfile`); cloudflared in Docker (`--network host`, token in `/root/cloudflared.env`, mode 600) |
| CT 9202 `keycloak` | Debian 13, 2 cores, 3 GB, `tank:16`, outside the pool. Keycloak 26.8.1 + Postgres 17 (`keycloak-compose.yml` in `/opt/keycloak`, secrets in its `.env`, mode 600), LAN port 8080 |
| Proxmox user `proxmate-demo@pve`, token `!video` | made by `deploy/proxmox-token.sh --user proxmate-demo@pve --token video --pool proxmate-demo` (roles ProxMate-Guest/-Infra/-Cluster; no Sys.Modify, no Datastore.Allocate) |
| Demo `.env` changes | `REAL_IP_HEADER=cf-connecting-ip` (Cloudflare), `MATESTATE_CRON=0 3 29 2 *` (no weekly guest backups to the cluster's backup storage) |
| ProxMate settings | storage `tank` (only on `pve`, so every demo guest lands there), bridge `vmbr0`, ISO/template storage `local` |

Every change, with times, is in `$PMV_WORK/prod/changes.log` on the recording container. Secrets (tunnel token,
demo admin password, Keycloak bootstrap admin and DB password, the SSH key for `pve`) are in `/root/pmv/secrets/`,
mode 600, never in the repo or chat.

## Access from the recording container

- `ssh -F $PMV_WORK/lab/ts-lab/ssh_config_prod queenbee` (root on `pve` over the tailnet, `tailscale nc` as the
  ProxyCommand; key comment `claude-proxmate-demo`). Guests are reached with `pct exec`, so they need no tailnet.
- The recording browser opens the public names through the sandbox's egress proxy (`*.proxmate.host` allowed).
  The proxy re-signs TLS, so never open the certificate viewer on camera: it would show the sandbox's CA.

## Lessons

- cloudflared cannot run in the sandbox: even with `*.argotunnel.com` allowed, the egress proxy drops the tunnel's
  port-7844 connection after 2 s. Run the connector next to the app, on the creator's side.
- Check the routes a tunnel token carries before trusting it: the connector logs "Updated to new configuration";
  if it names any hostname besides the demo's, stop the connector (an extra replica would take real traffic).
- Keep the demo's own container out of its pool, or the demo can see and delete itself.
- `MATESTATE_CRON=0 3 31 2 *` (a date that never comes) crashes the backend at boot in node-cron ("Could not find
  next matching date"). Use a real but distant date.
- Debian's Caddy 2.6.2 has no `trusted_proxies`; set `header_up X-Forwarded-Proto https` per upstream.
- Do the setup wizard over the API from inside the container (`/api/setup/*`, cookies by hand because
  COOKIE_SECURE=true) before the tunnel starts, so the admin account can't be claimed from the internet.

## Teardown (after the creator accepts the final cut)

1. Through ProxMate: delete the demo guests, then users and invites.
2. On `pve`: `pct stop 9201 && pct destroy 9201`; `pvesh delete /pools/proxmate-demo`;
   `pveum user delete proxmate-demo@pve`; `pveum role delete ProxMate-Guest` (and -Infra, -Cluster);
   `pveam remove local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst`; `rm /root/proxmate-demo-token.sh`.
3. Keycloak (9202) stays as the creator's SSO unless they say otherwise; delete the demo realm.
4. Cloudflare: remove the two routes (or the tunnel), then refresh the tunnel token (it was pasted in chat).
5. Remove the key: `sed -i --follow-symlinks '/claude-proxmate-demo/d' /root/.ssh/authorized_keys`.
