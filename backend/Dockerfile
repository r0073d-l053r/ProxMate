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

# node_modules from build includes the generated Prisma client + prisma CLI
# (needed to run migrations at startup).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["./docker-entrypoint.sh"]
