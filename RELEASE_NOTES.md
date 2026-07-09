## Highlights

**A backend security-hardening pass.** This release adds defense-in-depth around
outbound requests, secrets, metrics, rate limiting, and cookies — with no change
to normal behavior for a correctly configured install. It also fixes a couple of
latent footguns before they could bite in production.

## Security hardening

- **Outbound SSRF guards.** Admin-configured **notification webhooks** and
  **cloud-image URLs** are now validated against a private-address blocklist
  (loopback, link-local / cloud-metadata `169.254.169.254`, RFC1918, CGNAT,
  IPv6 ULA/link-local, IPv4-mapped IPv6) — shape-checked on save, DNS-resolved and
  re-checked immediately before the webhook POST, and redirects are refused. A new
  opt-out (`ALLOW_PRIVATE_OUTBOUND_URLS=true`) re-enables private targets for
  homelab installs that legitimately point at a LAN service; the scheme and
  no-credentials checks are always enforced regardless.
- **`/metrics` closed by default in production.** When `NODE_ENV=production` and no
  `METRICS_TOKEN` is set, `/metrics` returns 404 (scrape over localhost, or set a
  Bearer token). Unchanged in development.
- **Fail-closed secrets.** The API-token pepper no longer falls back to a static
  string if `ENCRYPTION_KEY` is missing (it throws), and `ENCRYPTION_KEY` is now
  validated as a 64-hex (32-byte) string. `decrypt()` validates ciphertext
  structure (segment count, hex, IV=12 / tag=16 bytes) before use.
- **MFA setup enforced on the admin API.** `/api/admin` now applies the same
  MFA-setup gate as the VM/template routes, so an admin whose invite required
  two-step auth can't reach admin endpoints until they enroll. (Admins without
  that requirement are unaffected — no lockout.)
- **Tighter rate limiting.** A dedicated limiter now covers cheap-to-probe public
  token GETs (invite lookup, backup downloads), and the setup wizard's mutating
  steps are throttled (its polled status endpoint is intentionally exempt).
- **Smaller fixes.** Logout now clears cookies with the same `Secure`/`SameSite`
  flags they were set with; a backup download aborts its file stream if the client
  disconnects mid-transfer; and the admin invite list no longer returns the raw
  token/URL for already-used or expired invites.

## Upgrade notes

- **No database migrations, no breaking changes for a standard install.**
- **`ENCRYPTION_KEY` must be a 64-hex string** (`openssl rand -hex 32`), which is
  what first-run auto-generation and the docs already produce. If you *manually*
  set a non-64-hex key in the past, convert it (and re-enter the Proxmox token /
  SMTP password / SSO secret) before updating.
- If you **scrape `/metrics`** in production, set `METRICS_TOKEN` (or keep the
  scrape on localhost) — otherwise it now returns 404.
- If you use a **private/LAN notification webhook or image mirror**, set
  `ALLOW_PRIVATE_OUTBOUND_URLS=true` in the backend environment.
- New optional vars are documented in `.env.example` / `.env.docker.example`.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## Verification

- Backend suite green: **505 tests** (+7) — a new `url-safety` suite covers the
  IP-range blocklist (incl. the IPv4-mapped-IPv6 forms), scheme/credential
  rejection, and the private-outbound opt-out; the api-token and notify suites were
  updated for the fail-closed pepper and the SSRF guard. Typecheck and lint clean
  on backend and frontend; frontend production build green.
- **Live-verified on the production cluster (musebot):** the backend binds the
  container interface correctly (reachable by the reverse proxy), `/api/health` is
  green (secrets decrypt with the 64-hex key), and `/metrics` returns 404 without a
  token.

## Note on origin

Portions of this pass were drafted with an external model and then reviewed,
corrected, and tested here. Two changes were rejected/rewritten before shipping —
most importantly a proposed production default that would have bound the API to
container-loopback (breaking the Docker deployment); the process now defaults to
`0.0.0.0` and host exposure is controlled at the reverse proxy / compose port bind
as before.
