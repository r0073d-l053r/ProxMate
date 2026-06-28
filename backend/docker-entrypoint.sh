#!/bin/sh
set -e

# ─── Drop privileges ──────────────────────────────────────────
# The container starts as root only so it can make the (root-owned) data volume
# writable by the unprivileged `node` user. It then re-execs itself as `node`, so
# neither the migrations nor the server ever run as root.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data
  exec su-exec node:node "$0" "$@"
fi

# Apply any pending database migrations against the (volume-backed) SQLite DB,
# then start the API server. (Running as `node` from here on.)
echo "Applying database migrations…"
npx prisma migrate deploy

echo "Starting ProxMate API…"
exec node dist/index.js
