## Highlights

**Users can now unsubscribe from admin broadcast emails (Community Edition).** Every
announcement an admin sends from **Settings → Broadcast email** now carries a personal
**unsubscribe link**, and each account gets a **Security → Email preferences** toggle.
Opted-out users are skipped on the next broadcast — while password resets, sign-in alerts,
and VM notifications keep arriving exactly as before.

## Features

- **Broadcast opt-out, two ways.** Each broadcast email footer has an **Unsubscribe** link
  (per-recipient, HMAC-signed — valid only for that account, no expiry to manage), and the
  in-app **Security → Email preferences** card lets a user unsubscribe or re-subscribe at
  any time. Both paths are recorded in the audit log.
- **Scanner-proof unsubscribe.** The link opens a confirmation page and only an explicit
  button press opts the user out — so corporate mail scanners (e.g. Outlook SafeLinks) that
  prefetch every link in an email can't silently unsubscribe your users.
- **Admins see the reach.** The broadcast send result now reports how many users were
  skipped as unsubscribed (toast + audit detail), so "sent to 12 (3 unsubscribed)" is
  visible at a glance.
- **Scope is deliberately narrow.** The opt-out affects **only** admin broadcasts.
  Transactional, security, and event-notification emails are untouched. _(This opt-out is a
  Community Edition feature: the EDU edition will not include it, since instructors must be
  able to reach every student.)_

## Upgrade notes

- **One database migration** (`add_broadcast_opt_out` — a single default-false column on
  `User`), applied automatically on deploy. No new environment variables; no breaking
  changes. Existing users all stay subscribed until they opt out.
- The unsubscribe link uses your existing public URL (frontend origin `/api`), so no extra
  routing setup is needed.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## Verification

- Backend suite green: **396 tests** (7 new — unsubscribe-token round-trip/tamper/cross-user
  forgery/malformed-input cases, and unsubscribe-footer rendering + HTML-escaping in the
  announcement template). Typecheck and lint clean on backend and frontend; frontend
  production build green.
- The broadcast query filters opted-out users server-side and the skipped count is returned
  in the API response and written to the audit log.
