#!/bin/sh
set -e

# Apply any pending database migrations against the (volume-backed) SQLite DB,
# then start the API server.
echo "Applying database migrations…"
npx prisma migrate deploy

echo "Starting ProxMate API…"
exec node dist/index.js
