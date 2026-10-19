---
type: Playbook
title: Upgrading from ProxMate 1.0.x to 1.1
description: Steps for an operator moving a 1.0.x install to 1.1.0 - compose override, updater units, token privileges, and what to check after the first start.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/RELEASE_NOTES.md
tags: [proxmate, playbook, upgrade, deploy]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: release-notes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/RELEASE_NOTES.md
    title: RELEASE_NOTES.md (1.1.0)
  - id: deployment
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/DEPLOYMENT.md
    title: DEPLOYMENT.md §14.4
  - id: update-sh
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/deploy/update.sh
    title: deploy/update.sh
  - id: override
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/docker-compose.override.example.yml
    title: docker-compose.override.example.yml
  - id: encryption-key
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/encryption-key.ts
    title: backend/src/lib/encryption-key.ts
---

# Trigger

A ProxMate 1.0.x (or older) install is about to be updated to 1.1.0. DEPLOYMENT.md §14.4 is the
full upgrade guide; this is the short form.[^release-notes][^deployment]

# Steps

1. **Move local compose edits into the override.** The updater already on the host
   force-checks-out the release, so edits to the tracked `docker-compose.yml` (uncommented
   `/control`, private-CA, snippets or backup-download mounts) would be lost. After
   `git fetch --tags`, take the template with
   `git show <new-tag>:docker-compose.override.example.yml`, copy your mounts into an untracked
   `docker-compose.override.yml`, run `git checkout -- docker-compose.yml`, then update. From
   1.1.0 on the updater refuses to run over local edits to tracked files and names them.[^release-notes][^override][^update-sh]
2. **Update** (in-app *Install update*, or `sudo ./deploy/update.sh <tag>` on the host). If the
   update card stays on *queued*, run `sudo ./deploy/update.sh <tag>` by hand.[^deployment]
3. **Re-install the updater units:** copy `deploy/proxmate-updater.service` and
   `deploy/proxmate-updater.path` to `/etc/systemd/system/` and run `systemctl daemon-reload`.[^release-notes]
4. **Check the environment.** Images now build on Node 22. Behind Caddy, nginx or a Cloudflare
   Tunnel keep `TRUST_PROXY=1`, or the audit log records the proxy's address instead of the
   client's. Outside Docker the backend no longer starts in production without
   `ENCRYPTION_KEY`. See [backend environment](/env/backend-environment.md).[^release-notes][^encryption-key]
5. **Check the Proxmox token can set guest tags** (`VM.Config.Options`; a privilege-separation-off
   token or the Administrator role has it). See [privileges](/proxmox/privileges.md).[^release-notes]
6. **Settle unconfirmed machines.** On first start existing guests are tagged where that is
   unambiguous; the rest are listed under Settings → Maintenance → Unconfirmed machines. Follow
   [Settling unconfirmed machines](/playbooks/unconfirmed-machines.md).[^release-notes]
7. **Re-save invalid schedules.** If admins are notified at startup about power or backup
   schedules that aren't valid cron expressions, re-save them on each machine's page; they never
   fire until then.[^release-notes]

# What users notice

- An IDE installed by 1.0.x reinstalls itself once, about a minute, the first time its owner
  opens it; admins and sharees no longer open other people's IDEs.[^release-notes]
- `pm_` API tokens are refused on account-security routes (session refresh, 2FA, passkeys,
  API-token management, invites, kiosk exit and the admin kiosk, SSO and reset-password
  settings); scripts using them there must move to the web app. See [HTTP API](/api/http-api.md).[^release-notes]
- SSO links to an existing local account only when the IdP asserts `email_verified` and the
  account's address was bound by an emailed invite (or is the setup-wizard admin); others keep
  signing in with their password. See [SSO service](/services/sso.md).[^release-notes]
- Rebuild cloud-image templates to pick up the guest agent; password-only deploys from older
  templates produce machines their owner cannot log into.[^release-notes]

[^release-notes]: RELEASE_NOTES.md (1.1.0)
[^deployment]: DEPLOYMENT.md §14.4
[^update-sh]: deploy/update.sh
[^override]: docker-compose.override.example.yml
[^encryption-key]: backend/src/lib/encryption-key.ts
