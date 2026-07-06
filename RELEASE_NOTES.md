## Highlights

**GPU / PCI passthrough approvals now show a live migration progress bar.** When an
approved passthrough is migrating a VM to the device's node, the admin review card
shows real transfer progress — percent, transferred/total bytes, and an ETA — instead
of just a spinner with a vague "can take minutes" hint.

## Features

- **Live transfer progress.** Proxmox reports per-disk `"transferred X of Y (Z%) in
  Ts"` lines while a migration's disks copy; ProxMate now aggregates those across
  every disk being mirrored in parallel and projects a percent, transferred/total
  bytes, and an estimated time remaining once there's enough data to extrapolate
  from. Falls back to an honest indeterminate bar — never a fabricated percentage —
  in the brief window before Proxmox has logged anything yet.
- Progress is attached to the existing admin review queue poll, so it appears
  automatically wherever the "migrating" state is already shown — no new UI to learn.

## Fixes

Both of these were found by testing this feature against a real, multi-hour 512 GB
production migration rather than only a quick synthetic one — and both are now
verified fixed live against that same migration, which was never disturbed
throughout.

- **A long migration's progress bar would freeze.** Proxmox's task-log pagination
  (`start`/`limit`) pages from the *oldest* line — there's no "last N lines" mode and
  no total-count field to page backward from, and a negative `start` is rejected
  outright. Requesting a fixed 200-line window kept re-reading the same early
  history once a migration's log grew past 200 lines (anything longer than
  ~3-4 minutes), so the reported percent would stop advancing. Fixed to request the
  full log (Proxmox's documented "no limit"); the payload stays trivial even for a
  multi-hour transfer, since it's roughly one line of text per second.
- **A ProxMate restart could disrupt an in-flight migration's bookkeeping.** A
  restart doesn't stop an already-running Proxmox migration task — it keeps copying
  independently. The startup reconciler (added last release to recover
  restart-interrupted applies) assumed a restart meant the apply had been abandoned,
  and would immediately try to restore the VM's cloud-init drive — while Proxmox
  still held a migration lock on it, which correctly rejected the change. The
  reconciler now checks whether the migration is still actively running first and,
  if so, leaves that VM completely alone, re-checking on the next restart. No VM was
  ever left in a bad state by this — the migration itself was unaffected — but the
  reconciler's own recovery logic was skipping the "is it still safe to touch this?"
  check it should have had from the start.

## Upgrade notes

- **No database migrations, no breaking changes, no new environment variables.**
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## Verification

- Backend suite green: **443 tests** (+18 — progress parsing/aggregation/ETA math,
  active-task lookup, admin-queue wiring, the reconciler's skip-while-migrating
  behavior, and a regression test for the log-pagination fix). Typecheck and lint
  clean on backend and frontend; frontend production build green.
- **Live-verified against a real, in-progress cluster migration:** confirmed the
  progress bar's percent/bytes/ETA matched the actual Proxmox task, polled it
  repeatedly to confirm the numbers advance (not cached), and confirmed the fixed
  reconciler correctly deferred to the still-running migration across two backend
  restarts — without ever touching or disrupting that migration.
