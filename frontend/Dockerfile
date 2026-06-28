# ─── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* vars are inlined at build time, so the browser's API base URL
# must be provided here. Override per deployment (e.g. https://proxmate.example.com/api).
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Public origin for SEO metadata (OG image + canonical + manifest URLs). Must be
# the externally reachable URL — override per deployment (e.g. https://proxmate.example.com).
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

RUN npm run build

# ─── Runtime stage ────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Standalone output bundles only the files needed to run the server.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Drop privileges: the Next standalone server only reads these files and binds a
# high port (3000), so the built-in non-root `node` user is sufficient.
USER node

EXPOSE 3000
CMD ["node", "server.js"]
