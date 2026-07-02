## 🐛 Fixes

**Uniform columns on the admin VM list.** When VMs are grouped by owner, each group's
table now shares the exact same column layout — the **Name / Status / Resources / OS /
IP address / Created** boundaries line up cleanly top-to-bottom instead of drifting from
one owner section to the next. (Previously each table auto-sized its columns to its own
content, so the grid looked ragged across sections.) A long machine name now truncates
within its column with the full name on hover.

## 🔄 Upgrade notes

- **Patch release — no database migrations, no new environment variables, no breaking
  changes.** A frontend-only layout fix on top of v0.5.0.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## 🧪 Verification

- Frontend typecheck + lint + production build green. The fix was verified in-browser
  across multiple owner groups — every group's table now computes identical column
  positions.
