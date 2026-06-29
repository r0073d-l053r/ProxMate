# ─── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

# Generate the Prisma client (tsc needs its types), compile TS → dist/, then
# strip devDeps and regenerate the client so the runtime node_modules carries
# only production deps + the Prisma CLI/engines (kept because `prisma` is a
# runtime dependency, needed for `migrate deploy` at startup).
RUN npx prisma generate \
 && npm run build \
 && npm prune --omit=dev \
 && npx prisma generate

# ─── Runtime stage ────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# su-exec lets the entrypoint start as root (to chown the data volume), then
# drop to the unprivileged `node` user before running any app code.
RUN apk add --no-cache su-exec

# node_modules from build includes the generated Prisma client + prisma CLI
# (needed to run migrations at startup).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 4000

# Liveness: hit the app's own /api/health (DB-checked). Uses node's global fetch
# (no curl/wget in the slim image). `start-period` covers first-boot migrations.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
