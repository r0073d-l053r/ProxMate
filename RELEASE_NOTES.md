<!--
  Curated notes for the NEXT release. release.yml publishes this file as the
  release body (the auto-generated PR list is appended below it), so rewrite it
  as part of every release commit — it should describe exactly one version.
-->

## ✨ Highlights

**The tenant VM page is now a DigitalOcean-style dashboard.** The detail page for a
VM/container used to be one long scroll of ~12 stacked cards; it's now organized the way
you'd expect from a cloud provider, and much easier to navigate.

### 🗂️ Tabbed VM detail page

- **Five tabs** — **Overview** (live status, configuration, notes · connection details
  with one-click IP copy, backups summary, tags, tips), **Insights** (larger CPU/memory
  history charts, hour/day/week), **Backups & Snapshots** (MateStates, backup policy,
  quick snapshots), **Activity** (event timeline), and **Settings**.
- **Header actions** — the wall of ~10 buttons is gone. The page header now has a
  **Console** menu (Graphical noVNC / Text console) and an **Actions** menu
  (Start / Stop / Restart · Rename / Resize / Rebuild · admin: Migrate / Save as
  template · Delete), with items enabled/disabled by power state.
- **Settings tab, DigitalOcean-style** — labeled rows with one action each: General
  (rename, resize), power schedule, data disks, GPU/PCI passthrough, sharing, an Admin
  section (migrate, convert to template), and a red **Danger zone** (rebuild, delete).
- **Deep-linkable tabs** — `?tab=backups` etc., kept in the URL without polluting
  browser history.
- **Everything still enforced** — read-only shares see only Overview / Insights /
  Activity; LXC containers hide all QEMU-only features (rebuild, migrate, convert,
  data disks, passthrough, snapshots) and say "Delete container".
- Admin pages (`/admin/*`) are intentionally unchanged.

### 📖 README overhaul

- The README no longer requires endless scrolling: a compact feature summary up top,
  with the **full feature matrix, tech stack, and extra screenshots in collapsible
  sections** (one hero screenshot stays visible), a tightened quick start, and a
  documentation table linking every guide in `docs/`.
- Added the missing **GPU/PCI passthrough** and **kiosk mode** rows to the feature
  matrix.

### 🔧 Release tooling

- Releases are now published with **curated, human-written notes** (this file) instead
  of only the auto-generated PR list.

## 🔄 Upgrade notes

- **No database migrations, no new environment variables, no breaking changes.**
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## 🧪 Verification

- Backend: typecheck + full Vitest suite green (~300 tests). Frontend: typecheck, lint,
  unit tests, and production build green; the new page was click-verified in-browser
  (all five tabs, both menus, LXC + read-only gating) against an isolated test stack.
