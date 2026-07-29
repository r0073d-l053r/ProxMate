## Highlights

A follow-up to v0.8.0 built around one theme — **deciding how long someone gets
to use your cluster** — plus a redesigned admin Settings page and three kiosk
fixes, one of which had been broken since kiosk mode first shipped.

- **Compute access windows, including "never"** — set how long an invited person
  may use the cluster, and change it later for anyone who already accepted.
- **Admin Settings, reorganised** — one long scroll of thirteen cards becomes a
  tabbed layout mirroring the VM Overview page.
- **Kiosk panel fixes** — the activity feed (empty since v0.2.5) now works, gains
  a full Activity tab, and the panel no longer logs itself out.

No breaking changes, and nothing to configure. Existing accounts are unaffected.

## Compute access windows — including "never"

Until now, handing someone a slice of the cluster was permanent unless you
deleted their account. The invite form's expiry dropdown looked like it
controlled that, but it only ever governed how long the invite **link** stayed
clickable.

**When you invite someone** (Admin → Invites) there is a new **Compute access**
control: *Never expires* (the default), 7 days, 14, 30, 60, 90, 6 months, or
1 year. The old control is now labelled **Invite link expires in**, so the two
clocks can't be confused. The window is counted from the day they **sign up**,
not the day you created the invite — an invite that sits unopened for a week
still grants its full term. The invite email states the window alongside the
quota.

**For someone who already accepted** (Admin → Users) click their name. Below the
quota fields is a **Compute access** control showing their current window, where
you can extend it, shorten it, or set **Never expires**. It defaults to *Leave
unchanged*, so editing a quota never silently resets someone's expiry. The users
table gains an **Access** column and a **Suspended** badge.

**When a window closes, the account is suspended — never deleted.** Their
machines are powered off and sign-in is refused with a clear explanation instead
of a wrong-password error. Disks, backups, snapshots and quotas are all left
intact. Setting a new window (or *Never expires*) restores everything
immediately and lets them power their machines back on.

**Nobody is surprised by it.** Warning emails go out 7 days and 1 day before the
window closes, each sent once per deadline — extending the window automatically
re-arms them. Tenants also see a countdown banner in the dashboard, and you get
an `access.expired` notification (webhook and/or email) when someone lapses.

**Admins never expire**, anywhere — including a tenant later promoted to admin,
who keeps the window from their original invite.

Enforcement is applied at every authenticated entry point, not just the login
form: session validation, the console WebSocket, the IDE proxy and IDE
WebSocket, personal API tokens, the 2FA-enrollment token, and the IDE LLM
gateway. `GET /auth/me` and `POST /auth/logout` deliberately remain reachable so
a suspended tenant is told *why* rather than being bounced to the login screen to
retype a correct password.

## Admin Settings, reorganised

The Settings page is now a tabbed layout mirroring the VM Overview page, with
related settings grouped into boxed sections:

- **Proxmox** — connection, VM defaults, tenant network isolation
- **IDE** — ProxMate IDE
- **Notifications** — email (SMTP), event notifications, broadcast
- **Access** — single sign-on (OIDC), kiosk mode
- **Maintenance** — updates, app-database backups, rescue ISO, cloud-image refresh

Each tab is deep-linkable (for example `/admin/settings?tab=access`). No settings
were added, removed or renamed — this is purely a reorganisation.

## Kiosk panel fixes

**The activity feed was always empty.** The kiosk read the wrong field from the
audit API, so the Overview panel's "Recent activity" had shown nothing since
kiosk mode shipped in v0.2.5. The audit log was being recorded correctly the
whole time; the panel simply never displayed it.

**A new Activity tab** shows the full audit window (latest 200 entries) in
touch-sized rows. Because a wall panel is readable by anyone walking past, rows
show **what happened, which VM, from which IP, and when** — and deliberately
never who did it. Actor identity stays in the authenticated Admin → Audit page.
Tap any row's IP or VM chip to filter the list to that IP or that machine; tap
the chip in the header to clear it.

**The panel no longer logs itself out.** The 15-minute session heartbeat that
keeps an unattended panel signed in was itself causing the logouts: it minted a
new session and deleted the old one instantly, while the panel's once-per-second
polling still had requests in flight carrying the old cookie. Those requests
failed, and the app treats any authentication failure as "signed out". The old
session is now retired with a 90-second overlap so in-flight requests finish
cleanly. The change is shrink-only — a session's lifetime can never be extended
by it — and an explicit sign-out still ends the session immediately.

## Smaller fixes

- Scheduled auto-start no longer powers a suspended tenant's machines back on the
  next morning.
- A co-owner of a shared VM can no longer start, restart, resume, rescue or
  duplicate a machine whose **owner's** access window has closed. Power-on
  decisions now check the owner, not the caller.
- A guest that ignores the graceful shutdown request at expiry (no ACPI handler,
  an installer sitting at a prompt) is now force-stopped on the following sweep
  instead of being reported as stopped while still running.
- The create-invite form's grid no longer leaves an empty half-row; the two
  expiry controls sit side by side.

## Upgrade notes

Standard update — pull the release and rebuild. The database migration adds five
nullable columns and applies automatically at container start.

**Existing accounts are unaffected.** A null access window means "never expires",
which is the default for every account that predates this release, so nothing
changes for anyone until you set a window on someone.

If you have previously saved notification settings, the new `access.expired`
event is enabled for you automatically; you can turn it off under
Settings → Notifications.

## Verification

709 backend tests (19 new), backend typecheck and lint clean, frontend lint and
production build green, Playwright smoke passing, CodeQL / Trivy / npm audit /
SBOM green.

The access-expiry work additionally went through an adversarial multi-agent
review before merge, which caught two high-severity defects — an unverified
shutdown that could leave a suspended tenant's machine running, and four
unguarded power-on paths reachable by a share-holder — both fixed and covered by
regression tests in this release.
