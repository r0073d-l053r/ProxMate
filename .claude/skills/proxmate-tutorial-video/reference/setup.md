# Setting up the production machine

The rig runs in a Claude Code cloud container (Ubuntu 24.04, 4 CPUs, about 15 GB RAM, no KVM, a small disk). Only
the repo survives the container, so a new session usually starts here. If the container is the same one and was
only restarted, files are still there and processes are not: skip to "After a restart".

Run everything as root. Two paths are used throughout:

```
SK=$(git -C /home/user/ProxMate rev-parse --show-toplevel)/.claude/skills/proxmate-tutorial-video   # absolute
export PMV_WORK=~/pmv/work PMV_LAB=~/pmv/work/lab
```

`PMV_WORK` is the video's working folder; keep it outside the repo. Check `df -h /` before every big step: the
models need about 1 GB, and Chromium about 1.2 GB at peak while unpacking.

## 0. Network

All traffic goes through the agent egress proxy. Check it with `curl -sS "$HTTPS_PROXY/__agentproxy/status"`.

- Reachable: github.com releases, raw.githubusercontent.com, PyPI, npm, archive.ubuntu.com,
  cloud-images.ubuntu.com, storage.googleapis.com (Chromium snapshots), Docker Hub.
- Blocked: Hugging Face, jsdelivr, dl-cdn.alpinelinux.org, api.elevenlabs.io.
- The environment's allowed domains need `proxmate.host` (the docs shown on camera; optionally
  `challenges.cloudflare.com`, never `analytics.proxmate.host`) and `*.tailscale.com` (to reach pve1). Only the
  creator can change them: send step-by-step instructions, and use the `read_documentation` tool (topic
  `environment.network`) for the current location of the setting.
- Never bypass the proxy and never disable TLS checks.

## 1. System packages

```
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  gnome-shell gnome-shell-extension-ubuntu-dock gnome-shell-extension-appindicator yaru-theme-gtk yaru-theme-icon \
  yaru-theme-gnome-shell ubuntu-wallpapers-noble ubuntu-settings fonts-ubuntu gnome-terminal gnome-settings-daemon \
  nautilus xdotool wmctrl dbus-x11 libgl1-mesa-dri mesa-utils openssh-server openssh-client at-spi2-core \
  gsettings-desktop-schemas x11-xserver-utils xclip
apt-get install -y -qq iproute2 iputils-ping espeak-ng locales x11-utils fonts-dejavu-core
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dnsmasq-base sshfs nginx libnss3-tools socat
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends squid
# only for the Proxmox stand-in (tools/lab/pve-lab.py):
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends lxc lxcfs lxc-templates- gdisk qemu-utils cloud-guest-utils e2fsprogs
```

The image already has Xvfb, ffmpeg (x11grab, libx264rgb, drawtext), Playwright 1.63 with
`require('playwright')`, Docker with Compose (the daemon is not running), ImageMagick and Pillow for the system
python3. Make sure the `en_US.UTF-8` locale exists.

## 2. The desktop and its user

```
useradd -m -s /bin/bash -c Alex alex; usermod -aG docker alex; cp -rn /etc/skel/. /home/alex/
echo 'alex ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-alex && chmod 440 /etc/sudoers.d/90-alex
# the terminal tells the recorder when a prompt is back (stage.cjs waitPrompt)
mkdir -p /home/alex/.cache && cat >> /home/alex/.bashrc <<'EOF'
__lab_stamp() { : > "$HOME/.cache/prompt-$(hostname)" 2>/dev/null; }
PROMPT_COMMAND="__lab_stamp${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
EOF
chown -R alex:alex /home/alex/.cache /home/alex/.bashrc
install -o alex -g alex -m 755 $SK/tools/record/session.sh /home/alex/.desktop-session.sh
bash $SK/tools/record/start-desktop.sh
for i in $(seq 1 40); do pgrep -x gnome-shell >/dev/null && break; sleep 0.5; done
bash $SK/tools/record/asalex.sh gsettings get org.gnome.desktop.interface cursor-size   # expect 32 (session.sh sets it)
bash $SK/tools/record/asalex.sh bash -c 'P=$(gsettings get org.gnome.Terminal.ProfilesList default | tr -d "'"'"'"); S=org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:$P/; gsettings set $S use-system-font false; gsettings set $S font "Ubuntu Sans Mono 15"'
```

That gives GNOME Shell 46 (Ubuntu session, Yaru dark, the creator's 32 px pointer) on `:1` at 1920x1080, as user
`alex` on host `alex-desktop`. Use `asalex.sh <command>` for anything inside the live session.
`tools/record/README.md` has the details.

## 3. Chromium

```
df -h /   # about 1.2 GB free needed while unpacking
T=$(mktemp -d) && curl -sL -o $T/chrome-linux.zip https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/1726730/chrome-linux.zip
python3 -I -m zipfile -e $T/chrome-linux.zip $T && mkdir -p /opt/chromium && cp -r $T/chrome-linux/. /opt/chromium/ && rm -rf $T
# zipfile drops the permission bits, so set them by hand
chown -R root:root /opt/chromium && chmod -R a+rX /opt/chromium
chmod 755 /opt/chromium/chrome /opt/chromium/chrome_crashpad_handler && chmod 4755 /opt/chromium/chrome_sandbox
install -m 755 $SK/tools/lab/chromium-browser /usr/local/bin/chromium-browser
cat > /usr/share/applications/chromium.desktop <<'EOF'
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
EOF
```

Open it once from the dock and click through the first-run screen. In its profile Preferences, turn off the
password manager and autofill, and set a floating window placement so it can be maximized on camera.
`tools/lab/README.md` covers the launcher flags and the optional proxy for the live docs site.

## 4. Voice, captions and speech recognition

```
bash $SK/tools/voice/setup.sh      # venv with pinned sherpa-onnx 2.0.0, Kokoro + Moonshine models, lexicon
```

The models come from the sherpa-onnx GitHub releases (`tts-models/kokoro-multi-lang-v1_0.tar.bz2`,
`asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2`). `af_heart` is speaker id 3.

## 5. The YouTube skills and the voice profile

```
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/Jakeschincariol/youtube-agent-skill ~/src/youtube-agent-skill
mkdir -p ~/.claude/skills ~/.claude/youtube && cp -r ~/src/youtube-agent-skill/skills/yt-* ~/.claude/skills/
cp $SK/reference/voice.md ~/.claude/youtube/voice.md
```

The yt-* skills read `~/.claude/youtube/voice.md`. Always copy the repo's version over it. Don't install or use
the script-writer skill; its "short, punchy" default is part of what made narration sound robotic.

## 6. The lab

`tools/lab/README.md` is the reference: the one-time setup for squid, the lab sshd boxes and their keys, Docker,
and Tailscale. In short:

- `net.sh` creates the lab LAN: bridge `vmbr0` with 192.168.1.1 (router), .10 (pve1) and .50 (the `proxmate`
  box), plus NAT, DHCP and `/etc/hosts` names. A squid cache serves the guests' apt traffic.
- **SSH keys.** alex has their own key for desktop to box, and root has its own key for the box's sshfs mount to
  pve1. `known_hosts` is written by hand from the host keys, since `ssh-keyscan` can't take a comma list.
- **Docker** runs with the proxy settings. On this sandbox it needs a local `node:22-alpine` base with the sandbox
  CA, and a relay to the proxy (`basefix/`). These are sandbox-only; disclose them.
- **ProxMate** is installed on the `proxmate` box with the real `install.sh`, the same way a viewer installs it.
  The installer needs a terminal, so dry runs go over `ssh -tt` with the answer piped in:

  ```
  runuser -u alex -- ssh -tt alex@proxmate 'curl -fsSLO https://raw.githubusercontent.com/r0073d-l053r/ProxMate/main/install.sh && printf "1\n" | bash install.sh'
  ```

  On camera, it's typed in the real terminal. The UI is at http://192.168.1.50:3000 and the API at :4000/api.
  `FRONTEND_URL` in the box's `.env` must be exactly `http://192.168.1.50:3000`, the browser's origin. To reset
  ProxMate for a new video:

  ```
  runuser -u alex -- ssh alex@proxmate 'cd ~/proxmate && docker compose down -v && docker compose up -d'
  ```

- **Proxmox:** use the creator's real nested node **pve1** (Proxmox VE 9.2.2, KVM). Download Tailscale with its
  checksum:

  ```
  curl -sS -O https://pkgs.tailscale.com/stable/tailscale_1.104.2_amd64.tgz
  curl -sS -O https://pkgs.tailscale.com/stable/tailscale_1.104.2_amd64.tgz.sha256
  ```

  Compare the two, unpack into `$PMV_LAB/tailscale-bin`, and start it with `ts-lab/start.sh`. Point the lab
  address at pve1 with `pve-real.sh on`, and mount pve1's snippets (lab README, "Preparing the real pve1").
  On a fresh container, the creator approves the new device and adds the new pve1-lab key (SKILL.md step 1).
  Use the stand-in `pve-lab.py` only for scenes that don't need a real VM, and disclose it.
- **Ask the creator before changing anything new on pve1.** Never touch its firewall or the production cluster.

## After a restart

```
bash $SK/tools/lab/bring-up.sh          # LAN, squid, dockerd, sshd boxes, ProxMate containers and the desktop
bash $SK/tools/lab/pve-real.sh on       # only when pve1 is needed: Tailscale plus the forward to 192.168.1.10:8006
# then mount pve1's snippets again (tools/lab/README.md, "Preparing the real pve1", step 2)
```

`bring-up.sh` starts the desktop when it isn't running, so don't also run `start-desktop.sh`: that would tear
the desktop down and start a second one. Then check the disk and clear superseded QA frames and builds before
recording. Restart Chromium before a take so it shows the 32 px pointer.
