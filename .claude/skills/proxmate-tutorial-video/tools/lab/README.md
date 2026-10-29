# Lab tools

The lab is the "home network" behind the desktop, all inside one Linux container, as root. A bridge `vmbr0` plays the
LAN `192.168.1.0/24`: `.1` is the router (NAT, DHCP, a squid apt cache for guests), `.10` is the Proxmox node `pve1`
and `.50` is the ProxMate box `proxmate`. `pve1` is normally **pve-lab.py**, a stand-in that speaks the Proxmox VE API
and boots each VM's own cloud image as an LXC system container; for the token chapter (part one, S03) and for part
two, the real Proxmox node is reached over Tailscale instead. `proxmate` is an sshd on `.50` in its own UTS namespace,
sharing the container's Docker, so ProxMate's `install.sh` and `docker compose` run for real. The desktop
(GNOME Shell for user `alex`, Chromium) is in `../record`.

Nothing here holds a secret. Passwords, tokens and keys come from environment variables or files outside the repo
(see "Never commit" below).

## Environment

| Variable | Meaning | Default |
|---|---|---|
| `PMV_WORK` | per-video working folder; lab logs go to `$PMV_WORK/logs`, takes to `$PMV_WORK/rec/<take>` | `~/pmv/work` |
| `PMV_LAB` | lab working folder (below) | `$PMV_WORK/lab` |
| `PMV_DISPLAY`, `PMV_CDP` | desktop X display, Chromium DevTools endpoint | `:1`, `http://127.0.0.1:9222` |
| `PROXMATE_URL`, `PROXMATE_API` | ProxMate web app and API | `http://192.168.1.50:3000`, `http://192.168.1.50:4000/api` |
| `PMV_PVE_URL` | the Proxmox node as the video shows it | `https://192.168.1.10:8006` |
| `PMV_PVE_TOKENS`, `PMV_PVE_TOKEN_ID` | the stand-in's token file, the token lifecycle.py uses | `/etc/pve-lab/tokens.json`, `root@pam!proxmate` |
| `PMV_PVE_LAB_BIN` | where pve-lab.py is installed | `/usr/local/sbin/pve-lab` |
| `PMV_TS_DIR`, `PMV_TS_BIN` | Tailscale state/socket/log folder; folder with static `tailscale` + `tailscaled` | `$PMV_LAB/ts-lab`, `$PMV_LAB/tailscale-bin` |
| `PMV_PVE1_SSH_CONFIG` | ssh config with host `pve1-lab` (from `ts-lab/ssh_config.example`) | `$PMV_TS_DIR/ssh_config` |
| `PMV_PROXY_CA` | CA bundle of the sandbox's TLS-inspecting egress proxy | `/root/.ccr/ca-bundle.crt` |
| `HTTPS_PROXY` | the egress proxy (set by the sandbox) | |
| `PMV_ADMIN_EMAIL` | the ProxMate admin | `alex@example.com` |
| `PMV_ADMIN_PASSWORD`, `PMV_VM_PASSWORD` | admin password; password of the user inside test and deployed VMs | none: set them |
| `PMV_FRIEND_PUBKEY`, `PMV_DEPLOY_PUBKEY` | public keys lifecycle.py and rehearse_deploy.py put in VMs | `$PMV_LAB/mike_ed25519.pub`, `/home/alex/.ssh/id_ed25519.pub` |
| `PMV_VENV` | Python venv of the voice tools (build examples) | `~/pmv/venv` |

`$PMV_LAB` holds `ts-lab/` (Tailscale state, socket, log, the filled-in ssh_config, known_hosts), `tailscale-bin/`,
the friend's key pair `mike_ed25519` / `mike_ed25519.pub` (`ssh-keygen -t ed25519 -C mike@laptop`; the public half is
pasted on camera), and links for `../record/examples/record-part1.cjs`, which runs `$PMV_LAB/pve-real.sh` and
`$PMV_LAB/s03-preroll.cjs`: `ln -sf $TOOLS/lab/pve-real.sh $TOOLS/lab/examples/s03-preroll.cjs "$PMV_LAB/"`
(`$TOOLS` is this skill's `tools/` folder; the scripts resolve their own location through the link).

## Tools

**bring-up.sh**: brings the lab back after a container restart (files persist, processes do not): net.sh, the
port-80 redirect of guest traffic to squid (3129) and squid itself, dockerd (through the proxy, stale pid files
removed), the proxy relay on `172.17.0.1:3128`, lxcfs, sshd for `proxmate` and `pve1`, the desktop
(`../record/start-desktop.sh`), `docs-mode.sh official`, then ssh checks. It does not start the Proxmox stand-in.
`bash bring-up.sh` (env `PMV_WORK`, `PMV_DISPLAY`, `HTTPS_PROXY`).

**net.sh**: the lab LAN: `vmbr0` with `.1/.10/.50`, IP forwarding and NAT out of `eth0`, `pve1`/`proxmate` in
`/etc/hosts`, a route that makes `install.sh` report `192.168.1.50` as "this machine's address", and dnsmasq DHCP
`.100-.199` for VMs. Idempotent. `bash net.sh`.

**docs-mode.sh**: which `proxmate.host` Chromium shows. `official` writes the proxy to `/etc/lab/chromium-proxy`
(read by chromium-browser) and adds the proxy CA to alex's NSS store; `local` points the name at a locally served
docs build instead (nginx with a certificate from the lab CA, not packaged). `bash docs-mode.sh official|local`.

**pve-real.sh**: who answers at `$PMV_PVE_URL`. `on` stops the stand-in, starts Tailscale (`ts-lab/start.sh`) and
forwards `192.168.1.10:8006` to the real pve1's 8006 over ssh; `off` drops the forward and starts the stand-in
(checks for its 401). `bash pve-real.sh on|off` (env `PMV_PVE_URL`, `PMV_TS_DIR`, `PMV_PVE1_SSH_CONFIG`, `PMV_PVE_LAB_BIN`).

**pve-lab.py**: the Proxmox VE API stand-in, node `pve1`, PVE 9.2.4: storage `local` = `/var/lib/vz`, real
downloads, raw disk images, cloud-init NoCloud generated like Proxmox, VMs booted as LXC containers on `vmbr0`, the
guest agent and the text console (termproxy) for real; state in `/var/lib/pve-lab`, log `/var/log/pve-lab.log`.
Install with `install -m 755 pve-lab.py /usr/local/sbin/pve-lab`; it makes its TLS certificate in `/etc/pve-lab` on
first start. Tokens: `/etc/pve-lab/tokens.json` (mode 0600), `{"root@pam!proxmate": {"secret": "<uuidgen>",
"privsep": 0}, "root@pam!first-try": {"secret": "<uuidgen>", "privsep": 1}}`; write it by hand with fresh UUIDs (the
recorder pastes these secrets on camera, so they must be lab-only). Env `PVE_LAB_ADDR`, `PVE_LAB_PORT`,
`PVE_LAB_LOG`, `PMV_PVE_TOKENS`. Needs lxc, lxcfs, qemu-utils, gdisk, fdisk, e2fsprogs, cloud-guest-utils, openssl.

**restart-shim.sh**: restarts the stand-in, keeping its state (e.g. after editing it). `bash restart-shim.sh`.

**reset-world.sh**: everything back to "before the tutorial": the box without ProxMate (checkout, containers, data
volume, sshfs, mount; images and build cache too unless `KEEP_BUILD_CACHE=1`), an empty stand-in node, Chromium and
Terminal closed with a fresh profile (settings kept, password manager and autofill off). `bash reset-world.sh`.

**lifecycle.py**: end-to-end check of the stand-in through its API, each step timed: import a cloud image as VM 100,
cicustom snippet, start, guest agent, cloud-init clean, template, full clone 101 with ciuser/sshkeys, resize, start,
set a password through the agent, exec, status. Needs `local:import/lifecycle-test.qcow2` and
`local:snippets/proxmate-guest-agent.yaml` on the node; leaves VMs 100/101 (reset-world.sh clears them).
`PMV_VM_PASSWORD=... python3 lifecycle.py` (env `PMV_PVE_URL`, `PMV_PVE_TOKENS`, `PMV_PVE_TOKEN_ID`, `PMV_FRIEND_PUBKEY`).

**take-official.sh / take-polished.sh**: part one's whole-take drivers. Preflight the live `proxmate.host` (200,
no redirect, no Cloudflare challenge, every string the recorder relies on), reset the world, warm Chromium up off
camera, then record S02..S15 and S01 with `../record/examples/record-part1.cjs` into `$PMV_WORK/rec/<take>`.
take-official.sh then assembles (`../edit/assemble.py`) into `$PMV_WORK/final-<take>` and runs `verifycolor.py`;
take-polished.sh first checks the real pve1 is reachable and sets a 32 px cursor, and leaves the FX assembly to you.
`bash take-polished.sh take5` (env as the recorder: `PMV_ADMIN_PASSWORD`, `PMV_FRIEND_PASSWORD`, `PMV_VM_PASSWORD`...).

**chromium-browser**: the launcher the dock's Chromium runs: `/opt/chromium/chrome` with its own profile
(`~/.config/chromium-alex`), DevTools on 9222, window class `chromium-browser`, scale factor 1, and the egress proxy
for public sites when `/etc/lab/chromium-proxy` exists (the lab LAN always direct). Install below.

**basefix/Dockerfile**: a sandbox-only base image: `node:22-alpine` (pinned by digest) plus the sandbox's
TLS-inspection CA appended to the system bundle (`NODE_EXTRA_CA_CERTS` set), so npm/Prisma/Next downloads verify,
plus Alpine's own `su-exec` 0.3-r0 (binary and its apk database record), because the sandbox blocks
`dl-cdn.alpinelinux.org`. Tagged locally as `node:22-alpine`, so ProxMate's own Dockerfiles use it unchanged. A real
machine does not need it. Build steps below.

**basefix/relay.py**: TCP relay from `172.17.0.1:3128` (docker0) to the egress proxy, which only listens on
127.0.0.1, so image builds can download. `python3 -I basefix/relay.py 3128 <proxy port> [bind address]` (bring-up.sh runs it).

**ts-lab/start.sh**: starts the lab's own Tailscale device in userspace mode through the egress proxy (SOCKS5 on
1080, HTTP proxy on 1081, state in `$PMV_TS_DIR/state`). `bash ts-lab/start.sh` (env `PMV_TS_DIR`, `PMV_TS_BIN`, `PMV_PROXY_CA`).

**ts-lab/ssh_config.example**: host `pve1-lab` = root on pve1's tailnet address, through `tailscale nc`, key
`/root/.ssh/pve1-lab`. Fill in `PVE1_TAILNET_IP` and the two folders with the sed line at its top.

**ts-lab/ticket.sh**: prints a URL-encoded `root@pam` login ticket made on pve1 over ssh (no password involved);
s03-preroll.cjs sets it as the `PVEAuthCookie`. The output is a live credential for 2 hours: never log it.

**pmapi.py**: small ProxMate API client (cookie session plus the CSRF header, like the browser). `admin()` logs in
with `PMV_ADMIN_EMAIL` / `PMV_ADMIN_PASSWORD`. `from pmapi import admin; a = admin(); a.call("GET", "/templates")`.

**build_ubuntu.py**: builds the "Ubuntu 24.04" Template Store template (amd64 cloud image) through ProxMate, timed.
`python3 build_ubuntu.py`.

**rehearse_deploy.py**: deploys a cloud-init VM from a template (Docker and Tailscale extras) and times clone,
cloud-init and IP. `python3 rehearse_deploy.py [name] [template]` (env `PMV_VM_PASSWORD`, `PMV_DEPLOY_PUBKEY`).

**rehearse_ops.py**: the VM page's operations, timed: snapshot/rollback, resize, MateState backup, power,
duplicate. `python3 rehearse_ops.py <vm id> snap rollback resize backup ...`.

**cleanup_pve1.py**: clean-up after a video on the real node, through ProxMate: every MateState, VM and container,
then every template. `python3 cleanup_pve1.py --dry-run` first. The rest of the plan's clean-up list is by hand.

**waits.py**: the real waits the edit speeds up (recorded fast-forward markers plus `add_ff`), with their real length.
`python3 waits.py <take dir> [chapter ids]`.

The Python tools read no Proxmox token except lifecycle.py (the stand-in's, via `PMV_PVE_TOKENS`); the real pve1's
API token stays in ProxMate and in its 0600 file, and no packaged script opens it.

## One-time setup

**Chromium**: a Chromium snapshot from `https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/<rev>/chrome-linux.zip`
(`LAST_CHANGE` in the same folder names the newest; the original rig used revision 1726730, Chromium 158.0.8126.0):

```
python3 -I -m zipfile -e chrome-linux.zip /tmp/chromium && mkdir -p /opt/chromium && cp -r /tmp/chromium/chrome-linux/. /opt/chromium/
chown -R root:root /opt/chromium && chmod -R a+rX /opt/chromium && chmod 755 /opt/chromium/chrome /opt/chromium/chrome_crashpad_handler
chmod 4755 /opt/chromium/chrome_sandbox          # start-desktop.sh sets CHROME_DEVEL_SANDBOX to it
install -m 755 chromium-browser /usr/local/bin/chromium-browser
```

`/usr/share/applications/chromium.desktop` (the dock favourite; `StartupWMClass` matches the launcher's `--class`):

```
[Desktop Entry]
Version=1.0
Name=Chromium Web Browser
GenericName=Web Browser
Comment=Access the Internet
Exec=/usr/local/bin/chromium-browser %U
Terminal=false
Icon=/opt/chromium/product_logo_48.png
Type=Application
Categories=Network;WebBrowser;
StartupWMClass=chromium-browser
```

**Docker base (sandbox only)**: build in a scratch folder outside the repo, then delete it:

```
B=$PMV_WORK/basefix-build; mkdir -p $B
cp /root/.ccr/ca-bundle.crt $B/sandbox-ca.crt                      # the sandbox's TLS-inspection CA bundle
docker create --name suexec-src rabbitmq:alpine                   # official image on the same Alpine (3.24.3 originally)
docker cp suexec-src:/sbin/su-exec $B/su-exec
docker cp suexec-src:/lib/apk/db/installed - | tar -xO | awk 'BEGIN{RS="";ORS="\n\n"} /(^|\n)P:su-exec\n/' > $B/su-exec.installed
docker rm suexec-src
docker build -t node:22-alpine -f basefix/Dockerfile $B
```

`su-exec.installed` is su-exec's stanza of the apk database (`P:su-exec`, `V:0.3-r0`, ending in a blank line); the
Dockerfile appends it so `apk info -e su-exec` (and ProxMate's `apk add su-exec`) see the package as installed.
Docker clients use the relay: `/root/.docker/config.json` and `/home/alex/.docker/config.json` hold
`{"proxies": {"default": {"httpProxy": "http://172.17.0.1:3128", "httpsProxy": "http://172.17.0.1:3128", "noProxy":
"localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.1.10,192.168.1.50,registry.npmjs.org,pypi.org,files.pythonhosted.org"}}}`.

**Proxy CA for Chromium**: the same bundle as `/usr/local/share/ca-certificates/ccr-agent-proxy.crt` (docs-mode.sh
imports it into alex's NSS store).

**squid** (guests' apt cache): `/etc/squid/squid.conf` with `http_port 127.0.0.1:3130`, `http_port 3129 intercept`,
access for `192.168.1.0/24` and localhost only, `cache_dir ufs /var/spool/squid 8000`, `maximum_object_size 1024 MB`,
long refresh for `.deb` and `/by-hash/`, none for `Release` files.

**Lab hosts' sshd**: `/etc/ssh/lab/<host>/` holds host keys (`ssh-keygen -q -N '' -t ed25519|ecdsa|rsa -f
/etc/ssh/lab/<host>/ssh_host_<type>_key`) and an `sshd_config`. `proxmate`: `ListenAddress 192.168.1.50`, its host keys,
`PidFile /run/sshd-proxmate.pid`, `UsePAM yes`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
`PermitRootLogin no`, `AllowUsers alex`, `PrintMotd no`, `AcceptEnv LANG LC_*`, the sftp subsystem; alex logs in with
his own key. `pve1`: `ListenAddress 192.168.1.10`, `PidFile /run/sshd-pve1.pid`, `UsePAM no`, no password logins,
`PermitRootLogin prohibit-password`, `AllowUsers root`, `AuthorizedKeysFile /etc/ssh/lab/pve1/authorized_keys` (root's
public key, so the box's `sudo ssh root@pve1` works; bring-up.sh checks it).

**Tailscale to the real pve1** (only for S03 and part two): unpack the static `tailscale`/`tailscaled` build from
pkgs.tailscale.com into `$PMV_TS_BIN`, run `ts-lab/start.sh`, join once with
`$PMV_TS_BIN/tailscale --socket=$PMV_TS_DIR/tailscaled.sock up --hostname=claude-lab` (sign in through the printed link,
or pass an auth key from an environment variable; never write it to a file), then write `$PMV_TS_DIR/ssh_config` from
the example and put `/root/.ssh/pve1-lab.pub` in pve1's `/root/.ssh/authorized_keys`. Check:
`ssh -F $PMV_TS_DIR/ssh_config pve1-lab hostname`.

## Preparing the real pve1 for a video (part two's sequence)

Only what the creator approved in PLAN.md. `S` below is `$PMV_LAB`, `ts-lab` its Tailscale folder.

1. **Token, written straight to a 0600 file and never printed.** Snippets go on `local`:

   ```
   umask 077; ssh -F $S/ts-lab/ssh_config pve1-lab 'pveum user token list root@pam --output-format json | grep -q "\"proxmate\"" && pveum user token remove root@pam proxmate; pveum user token add root@pam proxmate --privsep 0 --comment "ProxMate lab - delete after" --output-format json; pvesm set local --content iso,vztmpl,backup,import,snippets; mkdir -p /var/lib/vz/snippets' > $PMV_WORK/pve1-token.json
   ```

   Print only the token id and whether a secret was stored.
2. **Point the lab address at pve1 and mount its snippets**, so the cloud-init files ProxMate writes reach pve1:

   ```
   bash pve-real.sh on
   mkdir -p /mnt/pve-snippets && sshfs -o allow_other,reconnect,ServerAliveInterval=15,ssh_command="ssh -F $S/ts-lab/ssh_config" pve1-lab:/var/lib/vz/snippets /mnt/pve-snippets
   ```

   After a container restart, run both again.
3. **Storage and write cache, if approved:** add `images,rootdir` to `local` and set ProxMate's default storage to
   `local`. Cap the write cache with `sysctl -w vm.dirty_background_bytes=8388608 vm.dirty_bytes=33554432`, and write
   the restore line into the CLEANUP file on pve1.
4. **Reset ProxMate and set it up off camera**, through `pmapi.py` (cookie session, CSRF header, no proxy):
   - Reset: `runuser -u alex -- ssh alex@proxmate 'cd ~/proxmate && docker compose down -v && docker compose up -d'`,
     then wait for `/api/setup/status`.
   - `POST /setup/admin` (Alex, alex@example.com, password from `PMV_ADMIN_PASSWORD`).
   - `POST /setup/proxmox` with host `https://192.168.1.10:8006`, the token id and the secret read from the 0600
     file, and `verifySsl false`. Then `POST /setup/proxmox/test` (a "no guests are visible" warning is expected
     on an empty node) and `GET /setup/proxmox/resources`.
   - `POST /setup/defaults` (storage, bridge `vmbr0`, ISO storage `local`), then `POST /setup/complete`.
   - `PUT /templates/cloud-init-config` (offered extras and the base list, as the script shows them).
   - `POST /admin/encryption-key-backup/confirm`.
   - `POST /invites` for Mike (limits as the script needs), then `POST /auth/register` as mike@example.com.
   - `PUT /admin/settings/defaults` (storage, bridge, ISO and backup storage) and `PUT /admin/settings/rescue`
     (the rescue ISO).
   - Then `build_ubuntu.py` for any template the script says already exists.
5. **Rehearse** (`rehearse_deploy.py`, `rehearse_ops.py`). Delete the rehearsal guests and backups, then check the
   starting state through the API.

Clean-up reverses all of this: `cleanup_pve1.py`, then the CLEANUP list on pve1, the storage content and sysctl
restore, deleting the token, `fusermount -u /mnt/pve-snippets` and `bash pve-real.sh off`.

## Bring-up order after a container restart

1. Export the variables above (passwords from wherever you keep them, never from a file in the repo).
2. `bash bring-up.sh` (LAN, apt cache, Docker and relay, lxcfs, lab sshd, desktop, docs mode, checks).
3. `bash pve-real.sh off` to start the Proxmox stand-in, or `bash reset-world.sh` for a clean "before the tutorial" world.
4. Real pve1 only: `bash ts-lab/start.sh`, then `ssh -F $PMV_TS_DIR/ssh_config pve1-lab hostname` (`pve-real.sh on`
   does both for S03).
5. Optional full check of the stand-in: `python3 lifecycle.py`, then `reset-world.sh` again.
6. Recording: `../record/README.md` (pre-roll, `tzpin.cjs`, the recorder), or `take-polished.sh` for a whole part-one take.

## Examples (part one or part two specific)

- **examples/s03-preroll.cjs**: part one, S03 pre-roll: a clean real Proxmox (token list, tasks), a root login cookie from ts-lab/ticket.sh, the Proxmox tab warmed at 125% and dark, the docs tab where S02 ends.
- **examples/s12-preroll.cjs**: part one, before retaking S12-S15 and S01: undoes Mike's invite, account and VM and puts the admin tab back how S11 ends.
- **examples/rewind-to-s06.sh**: part one, rewinds the lab to the end of S05 (ProxMate installed, wizard not started) to re-record from S06.
- **examples/build-part1.sh**: part one's final build: plain and polished cuts in both voices, chapters, review frames.
- **examples/build-part2.sh**: part two's polished build in both voices, chapters, review frames.
- **examples/plan-part2.md**: part two's approved lab plan: approval scope, what gets created on pve1 (the clean-up list), network honesty.

## Never commit

- CA and TLS keys: the lab CA (`$PMV_LAB/ca/ca.key`, `proxmate.host.key`) and `/etc/pve-lab/pve-ssl.key`
- `/etc/pve-lab/tokens.json` (the stand-in's token secrets, pasted on camera)
- the pve1 token file (`pve1-token.json`, 0600: the real `root@pam!proxmate` secret) and any Proxmox login ticket (`pve-ticket`)
- Tailscale state (`$PMV_TS_DIR/state/`), its socket and logs, auth keys, the filled-in `ssh_config` (tailnet IP), `known_hosts`, `pve1.ip`
- SSH private keys: `/root/.ssh/pve1-lab`, `mike_ed25519`, alex's `~/.ssh/id_ed25519`, the lab hosts' `ssh_host_*_key`
- ProxMate's `.env` on the box (`ENCRYPTION_KEY` and the other secrets) and its data volume
- the sandbox CA copy (`sandbox-ca.crt`) and the `su-exec` binary and record (sandbox-only build inputs)
- take folders (`$PMV_WORK/rec/*`), renders, logs; and any password: the `PMV_*_PASSWORD` values live only in the environment

`.gitignore` in this folder catches the usual names as a safety net.
