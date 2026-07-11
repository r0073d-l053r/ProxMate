#!/usr/bin/env sh
# ProxMate IDE — NATIVE in-guest provisioner. Installs code-server + OpenCode
# directly into the VM (no Docker), so the IDE truly IS the machine: the VM's
# own users (`su <user>` works), hostname, services, and filesystem, opened at /.
#
# Run as root from the ide/ directory (needs settings.json, brand/, autostart/,
# write-opencode-config.sh alongside), with the gateway env set:
#   PROXMATE_IDE_GATEWAY_URL   e.g. https://proxmate.example.com/api/ide/<vmId>/llm/v1
#   PROXMATE_IDE_TOKEN         the per-VM gateway token
#   PROXMATE_IDE_MODELS_JSON   OpenCode models map (see write-opencode-config.sh)
#   PROXMATE_IDE_DEFAULT_MODEL optional default model id
#
# Idempotent: safe to re-run to update config/branding.
set -eu

[ "$(id -u)" = "0" ] || { echo "provision.sh must run as root" >&2; exit 1; }
cd "$(dirname "$0")"

echo "[proxmate-ide] installing code-server (official standalone installer)..."
curl -fsSL https://code-server.dev/install.sh | sh

echo "[proxmate-ide] installing OpenCode..."
# The installer drops a self-contained binary under ~/.opencode; put it on PATH.
HOME=/root sh -c 'curl -fsSL https://opencode.ai/install | bash'
install -m 0755 /root/.opencode/bin/opencode /usr/local/bin/opencode
opencode --version >/dev/null

echo "[proxmate-ide] applying ProxMate branding..."
# Same swap as the image build: the deb installs the web assets at /usr/lib/code-server.
MEDIA=/usr/lib/code-server/src/browser/media
if [ -d "$MEDIA" ]; then
  cp brand/icon.svg              "$MEDIA/favicon.svg"
  cp brand/icon.svg              "$MEDIA/favicon-dark-support.svg"
  cp brand/favicon.ico           "$MEDIA/favicon.ico"
  cp brand/icon-192.png          "$MEDIA/pwa-icon-192.png"
  cp brand/icon-192.png          "$MEDIA/pwa-icon-maskable-192.png"
  cp brand/icon-512.png          "$MEDIA/pwa-icon-512.png"
  cp brand/icon-maskable-512.png "$MEDIA/pwa-icon-maskable-512.png"
fi

echo "[proxmate-ide] settings + extensions (root profile)..."
install -D -m 0644 settings.json /root/.local/share/code-server/User/settings.json
mkdir -p /root/.local/share/code-server/extensions
rm -rf /root/.local/share/code-server/extensions/proxmate-ide-autostart
cp -r autostart /root/.local/share/code-server/extensions/proxmate-ide-autostart
code-server --install-extension sst-dev.opencode || echo "[proxmate-ide] warn: sst-dev.opencode install failed (offline?); OpenCode still works in the terminal"

echo "[proxmate-ide] rendering OpenCode gateway config..."
HOME=/root sh ./write-opencode-config.sh

echo "[proxmate-ide] gateway token env (root-only)..."
umask 077
cat > /etc/proxmate-ide.env <<EOF
PROXMATE_IDE_TOKEN=${PROXMATE_IDE_TOKEN:-}
EOF

echo "[proxmate-ide] systemd service..."
cat > /etc/systemd/system/proxmate-ide.service <<'EOF'
[Unit]
Description=ProxMate IDE (code-server, opened at /)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
EnvironmentFile=/etc/proxmate-ide.env
# --auth none: access control is ProxMate's job (session + ownership at the
# reverse proxy); the port is only reachable through the per-VM firewall pinhole.
ExecStart=/usr/bin/code-server --app-name "ProxMate IDE" --auth none --disable-telemetry --bind-addr 0.0.0.0:8080 /
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now proxmate-ide.service

sleep 2
systemctl --no-pager --quiet is-active proxmate-ide.service && echo "[proxmate-ide] service active" || { echo "[proxmate-ide] service FAILED"; journalctl -u proxmate-ide -n 10 --no-pager; exit 1; }
echo "[proxmate-ide] provisioned: http://$(hostname -I | awk '{print $1}'):8080"
