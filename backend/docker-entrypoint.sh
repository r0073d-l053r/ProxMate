#!/bin/sh
set -e

# ─── Drop privileges ──────────────────────────────────────────
# The container starts as root only so it can make the (root-owned) data volume
# writable by the unprivileged `node` user. It then re-execs itself as `node`, so
# neither the migrations nor the server ever run as root.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data

  # The app-database backup directory is a BIND MOUNT from the host, so its owner
  # is whatever created it there — root when the stack was installed with sudo, or
  # any uid that isn't 1000. `node` then cannot write to it and the nightly backup
  # fails every night with nobody watching: it logs a warning and returns early,
  # the scheduler only logs on success, and the admin API reports the configured
  # directory with no last-run status. A data-protection feature that is on by
  # default ends up silently disabled.
  #
  # Fixing it here rather than in the installer covers every install path,
  # including hand-rolled ones. Non-recursive on purpose: this directory holds the
  # operator's existing snapshots and we only need the directory itself writable —
  # a recursive chown of someone's backup archive is not ours to do. Failures are
  # non-fatal (a read-only `:ro` mount is a legitimate, deliberate setup).
  if [ -n "${APPDB_BACKUP_DIR:-}" ] && [ -d "$APPDB_BACKUP_DIR" ]; then
    chown node:node "$APPDB_BACKUP_DIR" 2>/dev/null \
      || echo "warning: could not chown $APPDB_BACKUP_DIR — app-database backups may fail to write there"
  fi

  exec su-exec node:node "$0" "$@"
fi

# Apply any pending database migrations against the (volume-backed) SQLite DB,
# then start the API server. (Running as `node` from here on.)
echo "Applying database migrations…"
npx prisma migrate deploy

echo "Starting ProxMate API…"
exec node dist/index.js
