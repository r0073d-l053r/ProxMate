## Highlights

**MateStates backups over ~2.1 GB no longer break the backups panel.** If a VM had a
backup larger than about 2.1 GB, opening its MateStates section returned a server error
(HTTP 500) and **no backups were listed at all** — the backups themselves were safe on
Proxmox storage the whole time; only the listing failed. Updating to this release repairs
the condition automatically.

## Fixes

- **Backup size overflow (500 on the MateStates list).** A backup's size in **bytes** was
  stored in a 32-bit integer column, which tops out at 2,147,483,647 (~2.1 GB). The
  database itself stored the larger value fine, but the ORM refused to read the row back
  ("value does not fit in an INT32"), which failed the entire backups query — so the API
  answered 500 and the panel showed nothing. The column is now a 64-bit integer
  (`BigInt`), sizes are converted to a JSON-safe number at the API boundary, and a
  regression test pins a 3 GB backup listing correctly.

## Upgrade notes

- **Patch release — one automatic database migration, no new environment variables, no
  breaking changes.** The migration (`matestate_size_bigint`) applies itself when the API
  container starts. It is non-destructive: the table is rebuilt with the wider column and
  **every existing row is copied over**, including the oversized value that triggered the
  bug — so previously "missing" backups reappear immediately after the update.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).
- After updating, open a VM's MateStates section to confirm the list loads (including any
  backup larger than 2.1 GB).

## Verification

- Backend suite green: **375 tests** (3 new regression tests covering a 3 GB backup size —
  Number conversion and JSON-safe serialization). Typecheck and lint clean.
- The failure mode was reproduced from a production report (500 on
  `GET /api/vms/:id/matestates` with a multi-GB backup present) and traced to the ORM's
  INT32 read guard; the fix targets that exact path.
