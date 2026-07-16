## Highlights

The first release since v0.7.0, bundling three bodies of work:

- **Tenant controls & admin management** — capability-based VM sharing (Viewer /
  Operator / Manager), admins deploying VMs into a tenant's account (optionally
  off-quota), admin-managed VMs that tenants can operate but not resize, private
  admin actions, and tighter AI-key rules. **This pack contains breaking changes —
  see Upgrade notes.**
- **Production hardening** — closes a quota-bypass on rebuild, bills shared-VM
  resizes to the owner, pins the in-guest IDE tool versions, adds an admin
  reachability test for the IDE, adds scheduled backups of ProxMate's own
  database, and fixes an IDE gateway URL that could break the AI agent behind some
  reverse proxies.
- **Kiosk mode** — the wall-panel command center now stays signed in during long
  shifts and requires re-authentication to leave.

Existing behavior is otherwise unchanged; every new capability is off or empty by
default.

## Tenant controls & admin management

### Sharing with permission levels (BREAKING)

VM sharing is now capability-based with three presets:

- **Viewer** — see the VM and its status.
- **Operator** — Viewer, plus power actions and the console.
- **Manager** — Operator, plus configuration, resize, backups, and the IDE.

Shares can **never** delete, rebuild, or otherwise destroy a VM — those stay with
the owner and admins. The old `access` values were renamed (co-owner → **manager**,
read-only → **viewer**); existing shares migrate automatically on upgrade.

### Admin: deploy a VM into a tenant's account

Admins can create a VM directly in a chosen tenant's account, optionally pinning
the node, and optionally as a **quota-exempt grant** that does not count against
the tenant's quota. An admin-provisioned VM is **resize- and rebuild-locked to
admins** — the tenant operates it as sized. This also closes a quota loophole: a
tenant who could grow a quota-exempt grant (directly, or by rebuilding onto a
larger template) would have sidestepped quota entirely.

### Private admin actions

Actions an admin takes on a tenant's VM no longer appear in that tenant's activity
feed. The audit log itself is unchanged and complete for admins — the filtering is
presentation-only, applied at read time.

### AI keys: custom endpoints are admin-only

Tenants keep the built-in providers (OpenAI, OpenRouter, Groq); pointing the IDE
agent at an arbitrary custom endpoint URL is now admin-only, enforced server-side.

### IDE: one-click relocate to a capable node

When a VM's node can't run the AI agent (no AVX), the IDE offers a one-click move:
ProxMate picks a capable node, stops → migrates → starts the VM, and reopens the
IDE. Tenants never choose nodes.

## Production hardening

- **Rebuild size-lock.** Rebuild is now covered by the same admin-only lock as
  resize on admin-managed / quota-exempt VMs — a rebuild re-images the disk, and a
  rebuild onto a larger template grows the allocation, which on an exempt grant
  never touched quota. Both are now blocked for non-admins.
- **Shared-VM resize quota is billed to the owner.** A Manager-share resize is now
  checked against the VM **owner's** quota and usage (the footprint lands on the
  owner), not the caller's. Admins remain unlimited.
- **Pinned IDE tool versions.** The in-guest install now pins exact, verified
  releases of code-server and OpenCode instead of pulling `latest`, so an upstream
  release can't silently break new IDE installs. Override with
  `IDE_CODE_SERVER_VERSION` / `IDE_OPENCODE_VERSION`.
- **IDE ingress CIDR + reachability test.** The firewall-pinhole source
  (`ide_ingress_cidr`) is now a validated field in **Settings → ProxMate IDE**,
  with a **Test reachability** button that dials a running VM's IDE port from the
  backend and reports the likely cause on failure — instead of a silently blank
  IDE.
- **Scheduled backups of ProxMate's own database.** Point **Settings →
  App-database backups** at a directory (ideally an off-host mount) and ProxMate
  takes a consistent nightly snapshot with rolling retention; a **Back up now**
  button proves the path first. MateStates back up guest VMs; this backs up
  ProxMate itself. Restoring a snapshot still requires the same `ENCRYPTION_KEY` —
  keep the key backed up separately.
- **IDE gateway URL fix.** Behind a reverse proxy that rewrites `X-Forwarded-*`
  (for example Cloudflare Tunnel → Caddy), the AI agent could be handed an `http://`
  gateway URL and fail with "Unauthorized — missing session." ProxMate now builds
  the gateway URL from the configured `BACKEND_PUBLIC_URL`. IDE guests provisioned
  before this upgrade keep their old URL until the IDE is reinstalled.

## Kiosk mode: stays signed in, locks on exit

- **No more mid-shift logout.** A long-running wall panel used to hit the session
  expiry and get bounced to the login screen. Kiosk mode now keeps its own session
  refreshed while it is on screen.
- **Re-authenticate to exit.** Leaving kiosk mode now requires proof it's the
  admin — a **passkey**, an admin-set **exit PIN**, or the account password — so a
  passer-by can't tap an unattended panel back into the admin console. Set the PIN
  under **Settings → Kiosk mode** (4–12 digits, stored hashed, rate-limited on the
  panel).

## Upgrade notes

- **Breaking — share `access` values renamed.** If you read or script the API,
  update your mappings: **co-owner → manager**, **read-only → viewer** (owner is
  unchanged). Existing shares are migrated automatically on the first boot after
  the upgrade. The share endpoint accepts the new names; the old names are
  tolerated for one release.
- **Breaking — non-admin API scope tightened.** Non-admin callers can no longer
  pass a `node` on VM create, request passthrough, or rebuild a shared VM.
- **No action required for the rest.** App-database backups, `ide_ingress_cidr`,
  and the kiosk exit PIN are all unset/off by default. New optional env overrides:
  `IDE_CODE_SERVER_VERSION`, `IDE_OPENCODE_VERSION`, `APPDB_BACKUP_CRON`,
  `KIOSK_EXIT_RATE_LIMIT_WINDOW_MS` / `KIOSK_EXIT_RATE_LIMIT_MAX`.
- **Set `BACKEND_PUBLIC_URL`.** The documented production deploy already sets it;
  the IDE gateway now depends on it (see the IDE gateway fix above).
- Standard upgrade: pull and rebuild — database migrations apply automatically on
  boot.

## Verification

- **687 backend tests** green; frontend production build green; CodeQL / Trivy /
  npm-audit / SBOM clean.
- The tenant-controls pack and the hardening changes were deployed to and
  live-tested on the production instance ahead of this release.
- The kiosk backend was exercised end-to-end against a running server (set / clear
  PIN, correct and incorrect PIN and password, format validation, and the session
  slide) before release.
