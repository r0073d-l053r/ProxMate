#!/usr/bin/env bash
#
# ProxMate installer.
#
# Brings up a ProxMate stack with Docker Compose: preflight checks, a generated
# ENCRYPTION_KEY, a correct .env for either an HTTP trial or a real HTTPS domain,
# and the build. It stops at the browser setup wizard on purpose — the Proxmox
# API token is entered there, never on a command line where it would land in
# shell history or a process list.
#
# This script is meant to be READ before it is run. It is deliberately not a
# `curl | sudo bash` one-liner: ProxMate ends up holding a Proxmox token that is
# effectively root on your cluster, so piping it into a root shell is the wrong
# habit for exactly this software.
#
#   curl -fsSLO https://raw.githubusercontent.com/r0073d-l053r/ProxMate/main/install.sh
#   less install.sh
#   bash install.sh
#
# Usage:
#   bash install.sh                            # interactive
#   bash install.sh --local                    # HTTP on this machine's LAN address
#   bash install.sh --local --host 10.0.0.5    # HTTP on an address you choose
#   bash install.sh --domain proxmate.example.com
#   bash install.sh --domain x --dir /opt/proxmate --ref v0.8.6 --yes
#
# Flags:
#   --local            HTTP, no reverse proxy. For a trial on a trusted network.
#   --host <addr>      With --local: the address you will type in the browser.
#                      Defaults to this machine's primary LAN IP. Use "localhost"
#                      only if you browse from this same machine.
#   --domain <host>    One HTTPS origin you will front with a reverse proxy.
#   --dir <path>       Where to install (default: ./proxmate, or the checkout you
#                      are already standing in).
#   --ref <git-ref>    Tag/branch to check out (default: newest vX.Y.Z tag).
#   --no-start         Write everything but do not build or start.
#   --yes, -y          Never prompt; requires --local or --domain.
#   --help, -h         This message.
#
# ── end of help text (usage() prints the block above) ────────────────────────
set -euo pipefail

REPO_URL="${PROXMATE_REPO_URL:-https://github.com/r0073d-l053r/ProxMate.git}"
HELP_LAST_LINE=38            # keep in sync with the marker line above
INSTALL_DIR=""
MODE=""
DOMAIN=""
HTTP_HOST=""
GIT_REF=""
ASSUME_YES=0
DO_START=1
ADOPTED_CWD=0
TMP_ENV=""

# ── output ────────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_DIM=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

step() { printf '%s==>%s %s\n' "$C_BLUE$C_BOLD" "$C_RESET$C_BOLD" "$*$C_RESET"; }
ok()   { printf '  %s+%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
info() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
die()  { printf '\n%serror:%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$*" >&2; exit 1; }

# A stray temp .env must never be left holding a freshly generated key.
cleanup() { [ -n "$TMP_ENV" ] && [ -f "$TMP_ENV" ] && rm -f "$TMP_ENV"; return 0; }
trap cleanup EXIT INT TERM

usage() { sed -n "2,${HELP_LAST_LINE}p" "$0" | sed 's/^# \{0,1\}//; s/^#$//'; exit 0; }

# ── args ──────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --local)    MODE="local"; shift ;;
    --host)     [ $# -ge 2 ] || die "--host needs an address"
                HTTP_HOST="$2"; shift 2 ;;
    --domain)   [ $# -ge 2 ] || die "--domain needs a hostname"
                MODE="domain"; DOMAIN="$2"; shift 2 ;;
    --dir)      [ $# -ge 2 ] || die "--dir needs a path"
                INSTALL_DIR="$2"; shift 2 ;;
    --ref)      [ $# -ge 2 ] || die "--ref needs a git ref"
                GIT_REF="$2"; shift 2 ;;
    --no-start) DO_START=0; shift ;;
    -y|--yes)   ASSUME_YES=1; shift ;;
    -h|--help)  usage ;;
    *)          die "unknown option: $1  (try --help)" ;;
  esac
done

# A registrable hostname — not a URL, not a host:port, not a bare IP. It is baked
# into the frontend bundle AND used as the WebAuthn RP ID, where a port or an IP
# literal is invalid and silently breaks passkey registration.
validate_domain() {
  case "$1" in
    "")                 die "--domain needs a hostname, e.g. proxmate.example.com" ;;
    *[!a-zA-Z0-9.-]*)   die "domain may only contain letters, digits, dots and hyphens (got: $1)
  Drop any scheme, port or path — pass just the hostname." ;;
    *.*)                : ;;
    *)                  die "that doesn't look like a domain: $1" ;;
  esac
  case "$1" in
    *[0-9].[0-9]*)
      # 1.2.3.4 style. Passkeys require a real domain, so flag it rather than
      # letting registration fail later with an opaque browser error.
      if printf '%s' "$1" | grep -qE '^[0-9]+(\.[0-9]+){3}$'; then
        die "--domain needs a DNS name, not an IP address ($1).
  HTTPS certificates and passkeys both require a real hostname.
  For an IP-based trial use:  --local --host $1"
      fi ;;
  esac
}

# ── 1. preflight ──────────────────────────────────────────────────────────────
step "Checking prerequisites"

have() { command -v "$1" >/dev/null 2>&1; }

have docker || die "docker is not installed. See https://docs.docker.com/engine/install/"

# Versions alone don't prove access: a user outside the docker group gets
# "permission denied" here, which is the most common first-run failure.
if ! docker ps >/dev/null 2>&1; then
  die "cannot talk to the Docker daemon.
  If it is running, your user is probably not in the 'docker' group:
      sudo usermod -aG docker \"\$USER\"   # then log out and back in"
fi
ok "docker daemon reachable"

docker compose version >/dev/null 2>&1 || die \
  "Docker Compose v2 is required ('docker compose', not 'docker-compose').
  See https://docs.docker.com/compose/install/"
ok "docker compose $(docker compose version --short 2>/dev/null || echo v2)"

have git || die "git is not installed."

if have openssl; then
  gen_key() { openssl rand -hex 32; }
elif [ -r /dev/urandom ] && have od; then
  gen_key() { od -vAn -N32 -tx1 < /dev/urandom | tr -d ' \n'; }
else
  die "need either openssl or /dev/urandom to generate an encryption key."
fi
ok "can generate an encryption key"

# The Next.js production build is the memory-hungry step; on a 1 GB box it gets
# OOM-killed and surfaces as an opaque compose failure.
if [ -r /proc/meminfo ]; then
  mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
  if [ "${mem_kb:-0}" -gt 0 ] && [ "$mem_kb" -lt 1900000 ]; then
    warn "only $((mem_kb / 1024)) MB RAM — the frontend build may be OOM-killed."
    info "add swap, or build elsewhere and pull the image."
  fi
fi
if have df; then
  free_kb=$(df -Pk . 2>/dev/null | awk 'NR==2{print $4}' || echo 0)
  if [ "${free_kb:-0}" -gt 0 ] && [ "$free_kb" -lt 5000000 ]; then
    warn "only $((free_kb / 1024 / 1024)) GB free here — images need roughly 5 GB."
  fi
fi

# ── 2. mode ───────────────────────────────────────────────────────────────────
primary_ip() {
  # The address a LAN client would actually reach this host on.
  if have ip; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' && return 0
  fi
  if have hostname; then
    hostname -I 2>/dev/null | awk '{print $1}' && return 0
  fi
  return 0
}

if [ -z "$MODE" ]; then
  [ "$ASSUME_YES" -eq 1 ] && die "--yes requires --local or --domain."
  [ -t 0 ] || die "not a terminal; pass --local or --domain <host>."
  echo
  step "How will you reach ProxMate?"
  info "1) HTTP on this machine's address — quick trial on a trusted network"
  info "2) HTTPS on a domain, behind your reverse proxy — real deployment"
  # A typo should re-ask, not throw away everything typed so far.
  while :; do
    printf '  choice [1/2]: '
    read -r _choice || die "no input."
    case "$_choice" in
      1) MODE="local"; break ;;
      2) MODE="domain"
         while [ -z "$DOMAIN" ]; do
           printf '  domain (e.g. proxmate.example.com): '
           read -r DOMAIN || die "no input."
         done
         break ;;
      *) warn "please type 1 or 2." ;;
    esac
  done
fi

if [ "$MODE" = "domain" ]; then
  validate_domain "$DOMAIN"
  ORIGIN="https://$DOMAIN"
else
  if [ -z "$HTTP_HOST" ]; then
    HTTP_HOST="$(primary_ip || true)"
    HTTP_HOST="${HTTP_HOST:-localhost}"
  fi
  case "$HTTP_HOST" in
    *[!a-zA-Z0-9.:-]*) die "--host may only contain letters, digits, dots, colons and hyphens (got: $HTTP_HOST)" ;;
  esac
  ORIGIN="http://$HTTP_HOST:3000"
  API_ORIGIN="http://$HTTP_HOST:4000"
fi

# ── 3. source tree ────────────────────────────────────────────────────────────
echo
step "Getting the ProxMate source"

if [ -z "$INSTALL_DIR" ] && [ -f docker-compose.yml ] && [ -d backend ] && [ -d frontend ]; then
  INSTALL_DIR="$PWD"
  ADOPTED_CWD=1
  ok "using the checkout you're standing in: $INSTALL_DIR"
else
  INSTALL_DIR="${INSTALL_DIR:-$PWD/proxmate}"
  if [ -d "$INSTALL_DIR/.git" ]; then
    ok "reusing existing checkout: $INSTALL_DIR"
  elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
    die "$INSTALL_DIR exists and is not empty. Pass --dir <somewhere-else>."
  else
    info "cloning $REPO_URL"
    git clone --quiet "$REPO_URL" "$INSTALL_DIR" || die "clone failed."
    ok "cloned into $INSTALL_DIR"
  fi
fi

cd "$INSTALL_DIR"
[ -f docker-compose.yml ] || die "docker-compose.yml not found in $INSTALL_DIR — wrong directory?"

# Fetch before resolving a ref, or a pin resolves against stale local tags.
git fetch --tags --quiet 2>/dev/null || warn "could not fetch updates; using the refs already on disk"

# Standing in someone's working copy is their choice — silently detaching HEAD
# off their branch is not. Only auto-pin a checkout this script created.
if [ "$ADOPTED_CWD" -eq 1 ] && [ -z "$GIT_REF" ]; then
  info "leaving your checkout on $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD) (pass --ref to pin)"
else
  [ -n "$GIT_REF" ] || GIT_REF="$(git tag --list 'v[0-9]*' --sort=-v:refname 2>/dev/null | head -n1 || true)"
  if [ -n "$GIT_REF" ]; then
    # Resolve local refs, then remote-only branches, so --ref main works after a
    # fresh clone where "main" may exist only as origin/main.
    target=""
    if git rev-parse --verify --quiet "refs/tags/$GIT_REF" >/dev/null 2>&1 \
       || git rev-parse --verify --quiet "$GIT_REF" >/dev/null 2>&1; then
      target="$GIT_REF"
    elif git rev-parse --verify --quiet "origin/$GIT_REF" >/dev/null 2>&1; then
      target="origin/$GIT_REF"
    else
      # Never silently install an unintended revision.
      die "git ref '$GIT_REF' does not exist in $REPO_URL.
  Available releases:
$(git tag --list 'v[0-9]*' --sort=-v:refname 2>/dev/null | head -5 | sed 's/^/      /')"
    fi
    if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
      warn "local changes present — not checking out $target"
    else
      git checkout --quiet "$target" || die "could not check out $target"
      ok "checked out $GIT_REF"
    fi
  fi
fi

# ── 4. .env ───────────────────────────────────────────────────────────────────
echo
step "Writing configuration"

env_value() {
  # Last assignment wins, matching how docker compose reads the file.
  grep -E "^[[:space:]]*$1=" .env 2>/dev/null | tail -n1 | sed "s/^[^=]*=//; s/^[\"']//; s/[\"']$//; s/[[:space:]]*$//" || true
}

if [ -f .env ]; then
  ok ".env already exists — keeping it (your ENCRYPTION_KEY is preserved)"

  existing_key="$(env_value ENCRYPTION_KEY)"
  if [ -z "$existing_key" ]; then
    warn "ENCRYPTION_KEY is empty; generating one"
    KEY="$(gen_key)"
    # Temp file in the SAME directory so the rename is atomic and cannot land on
    # another filesystem. grep exits 1 when it selects no lines (an .env that is
    # empty, or only the blank key line) — that is the expected case here, so
    # only a real grep error (2) is fatal.
    TMP_ENV="$(mktemp .env.XXXXXX)"
    chmod 600 "$TMP_ENV"
    { grep -v '^[[:space:]]*ENCRYPTION_KEY=' .env || [ $? -eq 1 ]; } > "$TMP_ENV" \
      || die "could not read .env"
    printf 'ENCRYPTION_KEY=%s\n' "$KEY" >> "$TMP_ENV"
    mv "$TMP_ENV" .env || die "could not update .env"
    TMP_ENV=""
    unset KEY
    ok "filled in a fresh 64-hex ENCRYPTION_KEY"
  elif ! printf '%s' "$existing_key" | grep -qE '^[0-9a-fA-F]{64}$'; then
    die "the ENCRYPTION_KEY in .env is not 64 hex characters.
  The backend fails closed on an invalid key. Fix it in .env, or if this is a
  fresh install with no data yet, delete .env and re-run to generate a valid one."
  fi

  # NEXT_PUBLIC_* are frontend BUILD ARGS baked into the bundle. Rebuilding over a
  # stale .env would serve a UI that calls the OLD origin while step 7 advertises
  # the new one — and FRONTEND_URL is the backend's CORS allow-list, so it would
  # reject the new origin too. Neither is fixable after the fact, so stop.
  have_origin="$(env_value NEXT_PUBLIC_SITE_URL)"
  have_origin="${have_origin%/}"
  if [ -n "$have_origin" ] && [ "$have_origin" != "$ORIGIN" ]; then
    die "this .env is configured for $have_origin, but you asked for $ORIGIN.
  NEXT_PUBLIC_API_URL / NEXT_PUBLIC_SITE_URL are baked into the frontend at BUILD
  time and FRONTEND_URL is the backend's CORS allow-list, so rebuilding now would
  bring up a stack that still talks to $have_origin.

  To move this install to $ORIGIN, edit .env — keeping ENCRYPTION_KEY exactly as
  it is — and update: FRONTEND_URL, NEXT_PUBLIC_API_URL, NEXT_PUBLIC_SITE_URL,
  BACKEND_PUBLIC_URL, WEBAUTHN_RP_ID, WEBAUTHN_ORIGIN, COOKIE_SECURE, TRUST_PROXY,
  CSP_CONNECT_SRC, BIND_ADDR. Then: docker compose up -d --build

  Never let a NEW ENCRYPTION_KEY be generated against an existing database — every
  stored secret (Proxmox token, SMTP password, TOTP secrets) becomes undecryptable."
  fi

  # The reuse path never chmodded, so a hand-made .env could be world-readable.
  chmod 600 .env 2>/dev/null || warn "could not chmod 600 .env — check its permissions"
else
  KEY="$(gen_key)"
  [ "${#KEY}" -eq 64 ] || die "generated key was not 64 hex characters."

  TMP_ENV="$(mktemp .env.XXXXXX)"
  chmod 600 "$TMP_ENV"
  if [ "$MODE" = "local" ]; then
    cat > "$TMP_ENV" <<EOF
# Generated by install.sh — HTTP trial on $HTTP_HOST.
# Full reference: .env.docker.example
ENCRYPTION_KEY=$KEY

FRONTEND_URL=$ORIGIN
NEXT_PUBLIC_API_URL=$API_ORIGIN/api
NEXT_PUBLIC_SITE_URL=$ORIGIN
BACKEND_PUBLIC_URL=$API_ORIGIN

# The UI (:3000) and the API (:4000) are separate origins here, and the shipped
# production CSP only allows 'self' https: wss: — which would block every API call
# and the console WebSocket over plain HTTP. Pin connect-src to this API origin.
# The value MUST be wrapped in double quotes: docker compose ends a value at the
# closing quote it opened, so a bare  CSP_CONNECT_SRC='self' http://…  is read as
# just  self  — silently dropping the API origin AND the quotes that make 'self'
# the CSP keyword rather than a hostname.
CSP_CONNECT_SRC="'self' $API_ORIGIN ws://$HTTP_HOST:4000"

# Plain HTTP: Secure cookies would never be sent back, so they stay off here.
COOKIE_SECURE=false
TRUST_PROXY=0
# Published on all interfaces so you can reach it from another machine.
BIND_ADDR=0.0.0.0
BACKEND_PORT=4000
FRONTEND_PORT=3000
EOF
  else
    cat > "$TMP_ENV" <<EOF
# Generated by install.sh — single HTTPS origin behind a reverse proxy.
# Full reference: .env.docker.example
ENCRYPTION_KEY=$KEY

FRONTEND_URL=$ORIGIN
NEXT_PUBLIC_API_URL=$ORIGIN/api
NEXT_PUBLIC_SITE_URL=$ORIGIN
BACKEND_PUBLIC_URL=$ORIGIN

# Passkeys are bound to the exact origin the browser sees.
WEBAUTHN_RP_ID=$DOMAIN
WEBAUTHN_ORIGIN=$ORIGIN

COOKIE_SECURE=true
TRUST_PROXY=1
# Which header carries the real client IP for the audit log and rate limiting.
# Default is cf-connecting-ip (Cloudflare); a plain Caddy/nginx proxy sends
# X-Forwarded-For, and trusting the wrong one lets clients spoof their IP.
REAL_IP_HEADER=x-forwarded-for
# Only the local reverse proxy reaches the app ports.
BIND_ADDR=127.0.0.1
BACKEND_PORT=4000
FRONTEND_PORT=3000
EOF
  fi
  mv "$TMP_ENV" .env || die "could not write .env"
  TMP_ENV=""
  unset KEY
  ok "wrote .env (mode 600) with a fresh 64-hex ENCRYPTION_KEY"
  warn "back that key up OFF this host — a database backup without it restores nothing"
fi

# Compose bind-mounts ${PROXMATE_BACKUP_DIR:-./backups}. If Docker has to create
# it, it lands root-owned and the scheduled backup (which runs as the unprivileged
# `node` user) fails at 02:30 with nobody watching.
backup_dir="$(env_value PROXMATE_BACKUP_DIR)"
backup_dir="${backup_dir:-./backups}"
if [ ! -d "$backup_dir" ]; then
  mkdir -p "$backup_dir" 2>/dev/null && ok "created $backup_dir for app-database backups" \
    || warn "could not create $backup_dir — create it yourself before enabling backups"
fi

# Warn on the ports actually in effect, not hardcoded ones.
be_port="$(env_value BACKEND_PORT)"; be_port="${be_port:-4000}"
fe_port="$(env_value FRONTEND_PORT)"; fe_port="${fe_port:-3000}"
if have ss; then
  for p in "$be_port" "$fe_port"; do
    ss -ltn 2>/dev/null | grep -qE "[:.]${p}[[:space:]]" \
      && warn "port $p already has a listener — if that isn't ProxMate, change BACKEND_PORT/FRONTEND_PORT in .env"
  done
fi

if [ "$DO_START" -eq 0 ]; then
  echo; step "Done (--no-start)"
  printf '  start it with:  cd %s && docker compose up -d --build\n' "$(printf '%q' "$INSTALL_DIR")"
  exit 0
fi

# ── 5. build + start ──────────────────────────────────────────────────────────
echo
step "Building and starting (the first build takes a few minutes)"
docker compose up -d --build || die "compose failed — see the output above.
  Most common causes: not enough RAM for the frontend build (add swap), no disk
  space, or no network access to pull base images."

# ── 6. wait for health ────────────────────────────────────────────────────────
echo
step "Waiting for the API to become healthy"
info "the backend applies database migrations on boot, so this is not instant"

cid=""; healthy=0
for _ in $(seq 1 60); do
  [ -n "$cid" ] || cid="$(docker compose ps -q backend 2>/dev/null || true)"
  if [ -n "$cid" ]; then
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
    running="$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo true)"
    case "$state" in
      healthy) healthy=1; break ;;
    esac
    # A crash-looping backend reports "starting" forever; check Running too.
    if [ "$running" = "false" ]; then
      die "the backend container stopped. See what it said:
      docker compose logs backend"
    fi
  fi
  sleep 5
done

# ── 7. what's next ────────────────────────────────────────────────────────────
echo
if [ "$healthy" -eq 1 ]; then
  ok "backend is healthy"
  step "ProxMate is up"
else
  warn "the backend did not report healthy within ~5 minutes"
  step "ProxMate started, but is not confirmed healthy"
  info "check it with:  cd $INSTALL_DIR && docker compose logs -f backend"
fi

echo
if [ "$MODE" = "local" ]; then
  printf '  Open %s%s%s and complete the setup wizard.\n' "$C_BOLD" "$ORIGIN" "$C_RESET"
  if [ "$HTTP_HOST" = "localhost" ]; then
    info "that address only works from THIS machine — re-run with --host <lan-ip> for others"
  fi
  echo
  warn "Until you finish the wizard, ANYONE who can reach $ORIGIN can claim the"
  warn "admin account. The ports are published on all interfaces. Do it now, or"
  warn "keep this host off untrusted networks until you have."
else
  printf '  Point your reverse proxy at this stack, then open %s%s%s\n' "$C_BOLD" "$ORIGIN" "$C_RESET"
  info "  /api  ->  127.0.0.1:$be_port     (keep the /api prefix — do NOT strip it)"
  info "  /     ->  127.0.0.1:$fe_port"
  info "WebSockets must pass through: the console and the IDE both need them."
  info "A ready-made Caddyfile is in this checkout: $INSTALL_DIR/deploy/Caddyfile"
  info "Full runbook: https://proxmate.host/docs/deployment"
fi

echo
info "The wizard asks for a Proxmox API token. The quickest token that works is:"
info "    pveum user token add root@pam proxmate --privsep 0"
info "That grants ProxMate full cluster rights. For anything you care about, create"
info "a dedicated least-privilege role instead: https://proxmate.host/docs/security"
info "Privilege separation must be OFF either way — a privsep token has NO"
info "permissions, and the connection test still passes before everything 403s."
echo
info "Before inviting anyone: enable the Proxmox cluster firewall."
info "The per-VM isolation rules do nothing until it is on."
echo
