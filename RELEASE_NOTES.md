## Highlights

**Shared links now show a proper preview image.** When you paste a ProxMate link into
Slack, Discord, iMessage, X, or anywhere else that unfurls URLs, the card now renders the
branded ProxMate thumbnail instead of an empty box — on every instance, with no extra setup.

## Fixes

- **Open Graph / Twitter share image now unfurls.** Previously a shared link showed the
  title and description but an **empty image slot**. The image asset existed and was valid;
  the problem was the URL it pointed at. ProxMate derived the preview-image origin from a
  **build-time** value, and the Docker images default `NEXT_PUBLIC_SITE_URL` to
  `http://localhost:3000` — so any instance built without that variable told link-preview
  bots to fetch `http://localhost:3000/opengraph-image.png`, which they can't reach.

  The origin is now resolved from the **actual incoming request** (`x-forwarded-host` /
  `Host` + `x-forwarded-proto`). Link previews resolve correctly on any self-hosted
  instance behind a tunnel or reverse proxy **with zero configuration**. Setting
  `NEXT_PUBLIC_SITE_URL` explicitly still takes precedence; a `localhost` value is treated
  as unset so the development default can no longer break production unfurls.

- **Refreshed share card ("Refined Dark").** The 1200x630 Open Graph / Twitter image was
  redrawn — ProxMate logo and wordmark, the "Share your homelab. Keep your boundaries."
  headline, subtext, and a blue-to-teal accent underline on the dark brand background.

## Upgrade notes

- **Patch release — no database migrations, no new environment variables, no breaking
  changes.**
- A rebuild is all that is required. `NEXT_PUBLIC_SITE_URL` is now **optional**: leave it
  unset and previews follow whatever origin the instance is served on; set it if you want
  to pin the origin explicitly.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).
- After updating, re-share a link (some platforms cache old unfurls — a card validator or a
  cache-busting query string forces a refresh) to confirm the image renders.

## Verification

- Confirmed against a production build (`next build` + `next start`): a proxied request with
  `Host: proxmate.myhomelab.pro` + `x-forwarded-proto: https` yields
  `https://proxmate.myhomelab.pro/opengraph-image.png`; an `x-forwarded-host` request yields
  that host; a direct request yields the local origin. The image route returns
  `200 image/png`.
- Frontend typecheck, lint, and production build all green.
