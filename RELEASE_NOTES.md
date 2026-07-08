## Highlights

**A reliability fix for the admin live-stats stream.** The admin Monitor's live
feed (Server-Sent Events at `/api/admin/live-feed`) pushes cluster-wide guest
metrics to every open admin tab from one shared server-side poll loop. This
release hardens that loop against clients that disconnect uncleanly — closing a
slow resource leak and a latent crash path. There are no user-visible feature
changes; existing admin dashboards behave exactly as before, just more robustly
over long uptimes.

## What was wrong

The feed relied entirely on the connection's `close` event to unregister a
subscriber. That covers the normal case (an admin closes the tab or navigates
away), but three edge cases were unhandled:

- **Leaked subscribers.** If a socket died without a clean `close` — a dropped
  proxy, a half-open TCP connection, a killed network — the subscriber stayed in
  the in-memory set. Over a long-running server these entries could accumulate.
- **A runaway poll loop.** If every subscriber vanished that way, the subscriber
  count never reached zero, so the 1 Hz poll timer kept running forever — polling
  Proxmox and writing frames for an audience of nobody.
- **A potential crash.** Writing a frame to a reset socket can surface an
  asynchronous `error` event (EPIPE / ECONNRESET). With no error listener
  attached, that can become an unhandled error and take the backend process down.

## What changed

- **Proactive pruning.** Every tick, the feed now removes any subscriber whose
  response is no longer writable (ended, destroyed, or not writable) before doing
  any work — so a subscriber that disconnected without firing `close` is cleaned
  up within one interval instead of lingering.
- **A self-stopping loop.** When pruning empties the subscriber set, the poll
  timer stops itself. No subscribers means no polling and no writes.
- **Per-write safety + async error handling.** Each frame write is guarded, and
  the SSE route now attaches cleanup to `res` `close`/`error` in addition to the
  request's `close`. A client disconnecting mid-write is handled cleanly rather
  than risking an unhandled socket error. The cleanup is idempotent, so firing on
  more than one of those events is harmless.

## Upgrade notes

- **No database migrations, no breaking changes, no new required environment
  variables.** (`LIVE_FEED_INTERVAL_MS`, the optional feed-cadence override, is
  unchanged from prior releases.)
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## Verification

- Backend suite green: **481 tests** (+2) — a new `live-stats-feed` test asserts
  that a subscriber which dies without unsubscribing is pruned on the next tick
  (with no write to the dead socket), that the poll loop stops itself once no
  subscribers remain, and that an explicit unsubscribe halts further pushes.
  Typecheck and lint clean on backend and frontend; frontend production build
  green.
