#!/bin/bash
# Which proxmate.host Chromium shows.
#   official: Chromium reaches the real https://proxmate.host through the sandbox's egress proxy
#             (the lab LAN, pve1 and the ProxMate box stay direct); the local stand-in is switched off.
#   local:    the previous setup, a locally served build of proxmate-docs under proxmate.host (nginx + the lab CA).
# usage: docs-mode.sh official|local   (as root; official needs HTTPS_PROXY and the proxy CA installed as
#        /usr/local/share/ca-certificates/ccr-agent-proxy.crt; writes /etc/lab/chromium-proxy, read by chromium-browser)
set -e
MODE=${1:?official|local}
mkdir -p /etc/lab
case "$MODE" in
  official)
    python3 -c "import os,urllib.parse as u;p=u.urlparse(os.environ['HTTPS_PROXY']);print(f'http://{p.hostname}:{p.port}')" > /etc/lab/chromium-proxy
    sed -i '/ proxmate\.host/d' /etc/hosts
    runuser -u alex -- certutil -d sql:/home/alex/.pki/nssdb -A -t "C,," -n "Sandbox egress proxy CA" -i /usr/local/share/ca-certificates/ccr-agent-proxy.crt
    runuser -u alex -- certutil -d sql:/home/alex/.pki/nssdb -L | grep -q "Sandbox egress proxy CA" || { echo "proxy CA missing from Chromium's store" >&2; exit 1; }
    ;;
  local)
    rm -f /etc/lab/chromium-proxy
    grep -q " proxmate.host" /etc/hosts || echo "127.0.0.1 proxmate.host www.proxmate.host" >> /etc/hosts
    ;;
esac
echo "docs mode: $MODE"; cat /etc/lab/chromium-proxy 2>/dev/null || true
