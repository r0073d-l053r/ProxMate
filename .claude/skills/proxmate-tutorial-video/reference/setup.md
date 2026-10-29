# Setting up the production machine

The rig runs in a Claude Code cloud container (Ubuntu 24.04, 4 CPUs, about 15 GB RAM, no KVM, a small disk). Only
the repo survives the container, so a new session usually starts here. If the container is the same one and was
only restarted, files are still there and processes are not: skip to "After a restart".

Commands below assume `SK=.claude/skills/proxmate-tutorial-video` (from the repo root) and a working folder per
video in `PMV_WORK` (default `~/pmv/work`).

## 0. Network

All traffic goes through the agent egress proxy. Check it with `curl -sS "$HTTPS_PROXY/__agentproxy/status"`.

- Reachable: github.com releases, raw.githubusercontent.com, PyPI, npm, archive.ubuntu.com,
  cloud-images.ubuntu.com, storage.googleapis.com (Chromium snapshots), Docker Hub.
- Blocked: Hugging Face, jsdelivr, dl-cdn.alpinelinux.org, api.elevenlabs.io.
- The creator allowlisted `proxmate.host` (the docs shown on camera) and `*.tailscale.com` (to reach pve1) in
  the environment's network settings. If a new environment blocks them, ask the creator to add them back. Use
  the `read_documentation` tool (topic `environment.network`) for the current steps.
- Never bypass the proxy and never disable TLS checks.

## 1. System packages

```
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  gnome-shell gnome-shell-extension-ubuntu-dock gnome-shell-extension-appindicator yaru-theme-gtk yaru-theme-icon \
  yaru-theme-gnome-shell ubuntu-wallpapers-noble ubuntu-settings fonts-ubuntu gnome-terminal gnome-settings-daemon \
  nautilus xdotool wmctrl dbus-x11 libgl1-mesa-dri mesa-utils openssh-server openssh-client at-spi2-core \
  gsettings-desktop-schemas x11-xserver-utils xclip
apt-get install -y -qq iproute2 iputils-ping espeak-ng locales x11-utils
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dnsmasq-base sshfs nginx libnss3-tools socat
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends squid
# only for the Proxmox stand-in (tools/lab/pve-lab.py):
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends lxc lxcfs lxc-templates- gdisk cloud-guest-utils e2fsprogs
```

The image already has Xvfb, ffmpeg (x11grab, libx264rgb, drawtext), Playwright 1.63 with
`require('playwright')`, Docker with Compose (the daemon is not running), ImageMagick and Pillow for the system
python3. Make sure the `en_US.UTF-8` locale exists.

## 2. The desktop

```
useradd -m -s /bin/bash -c Alex alex; usermod -aG docker alex; cp -rn /etc/skel/. /home/alex/
echo 'alex ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-alex && chmod 440 /etc/sudoers.d/90-alex
cp $SK/tools/record/session.sh /home/alex/.desktop-session.sh
bash $SK/tools/record/start-desktop.sh
bash $SK/tools/record/asalex.sh gsettings set org.gnome.desktop.interface cursor-size 32
```

That gives GNOME Shell 46 (Ubuntu session, Yaru dark) on `:1` at 1920x1080, as user `alex` on host
`alex-desktop`. Use `asalex.sh <command>` to run anything inside the live session. Set GNOME Terminal's
profile font to Ubuntu Sans Mono 15. `tools/record/README.md` has the details.

## 3. Chromium

```
curl -sL -o chrome-linux.zip https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/1726730/chrome-linux.zip
python3 -I -m zipfile -e chrome-linux.zip . && mkdir -p /opt/chromium && cp -r chrome-linux/. /opt/chromium/
chmod -R a+rX /opt/chromium && chmod 4755 /opt/chromium/chrome_sandbox
install -m 755 $SK/tools/lab/chromium-browser /usr/local/bin/chromium-browser
sed -i 's#^Exec=.*#Exec=/usr/local/bin/chromium-browser %U#' /usr/share/applications/chromium.desktop   # and StartupWMClass=chromium-browser
```

Open it once from the dock and click through the first-run screen. In its profile Preferences, turn off the
password manager and autofill, and set a floating window placement so it can be maximized on camera.
`tools/lab/README.md` covers the launcher flags and the optional proxy for the live docs site.

## 4. Voice, captions and speech recognition

```
bash $SK/tools/voice/setup.sh      # venv with pinned sherpa-onnx 2.0.0, Kokoro + Moonshine models, lexicon
```

The models come from the sherpa-onnx GitHub releases (`tts-models/kokoro-multi-lang-v1_0.tar.bz2`,
`asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2`). Together they take about 1 GB, so check the disk first.
`af_heart` is speaker id 3.

## 5. The YouTube skills and the voice profile

```
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/Jakeschincariol/youtube-agent-skill ~/src/youtube-agent-skill
mkdir -p ~/.claude/skills ~/.claude/youtube && cp -r ~/src/youtube-agent-skill/skills/yt-* ~/.claude/skills/
cp $SK/reference/voice.md ~/.claude/youtube/voice.md
```

The yt-* skills read `~/.claude/youtube/voice.md`. Always copy the repo's version over it. Don't install or use
the script-writer skill; its "short, punchy" default is part of what made narration sound robotic.

## 6. The lab

`tools/lab/README.md` is the reference. In short:

- `net.sh` creates the lab LAN: bridge `vmbr0` with 192.168.1.1 (router), .10 (pve1) and .50 (the `proxmate`
  box), plus NAT, DHCP and `/etc/hosts` names. A squid cache serves the guests' apt traffic.
- Docker runs with the proxy settings. On this sandbox it needs a local `node:22-alpine` base with the sandbox
  CA, and a relay to the proxy (`Dockerfile` and `relay.py`). These are sandbox-only; disclose them.
- ProxMate is installed on the `proxmate` box with the real `install.sh`, the same way a viewer installs it.
  The UI is at http://192.168.1.50:3000 and the API at :4000/api. To reset it for a new video:
  `ssh alex@proxmate 'cd ~/proxmate && docker compose down -v && docker compose up -d'`.
- **Proxmox.** Use the creator's real nested node **pve1** (Proxmox VE 9.2.2, KVM, `local` directory storage
  for VM disks). Reach it over the lab tailnet with `ts-lab/start.sh`, and point the lab address at it with
  `pve-real.sh on`. The first login link has to be approved by the creator. Use the stand-in `pve-lab.py` only for
  scenes that don't need a real VM, and disclose it.
- **Ask the creator before changing anything new on pve1.** Never touch its firewall or the production cluster.

## After a restart

```
bash $SK/tools/lab/bring-up.sh          # LAN, squid, dockerd, sshd boxes, ProxMate containers (idempotent)
bash $SK/tools/record/start-desktop.sh  # desktop on :1
bash $SK/tools/lab/ts-lab/start.sh      # only when pve1 is needed (see tools/lab/README.md)
```

Then check the disk (`df -h /`) and clear superseded QA frames and builds before recording.
