---
type: Playbook
title: Settling unconfirmed machines
description: How an admin adopts or removes machines whose Proxmox guest does not carry their ProxMate ownership tag, so they can be used or deleted again.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/frontend/src/components/admin/unmatched-vms-card.tsx
tags: [proxmate, playbook, ownership-tags, admin, upgrade]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: vm
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
  - id: card
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/frontend/src/components/admin/unmatched-vms-card.tsx
    title: frontend/src/components/admin/unmatched-vms-card.tsx
  - id: release-notes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/RELEASE_NOTES.md
    title: RELEASE_NOTES.md (1.1.0)
---

# Trigger

Any of these:

- Admins received a `vm.error` notification saying the ownership-tag backfill left machines
  unmatched (sent once, after a backfill pass completes).[^vm]
- A machine refuses start, console, IDE, backups or delete with a message asking an admin to
  check it, because its guest predates ProxMate's ownership tags.[^vm]
- Deleting a user answers 409 with a `vms` list.[^release-notes]

Typical causes after upgrading from 1.0.x: rows left in `error` or `creating`, guests renamed in
Proxmox or ProxMate so the names no longer match, and VMIDs referenced by more than one
machine. The backfill only tags a guest when exactly one row references its VMID, the row is
neither `error` nor `creating`, the guest has no ProxMate tag and the names match.[^release-notes][^vm]

# Steps

1. **Open Settings → Maintenance → Unconfirmed machines.** The card lists every machine whose
   VMID holds no guest carrying its `proxmate-<id>` tag (`GET /api/admin/vms/unmatched`),
   with the guest found there (if any), whether it is a template, and whether another machine
   shares the VMID.[^card][^admin-routes]
2. **Check each row against Proxmox.** Make sure the guest at that VMID really is that
   machine: the confirmation shows both names and warns when they differ.[^card]
3. **Adopt** when the guest is the machine's (`POST /api/admin/vms/:id/adopt`). The guest is
   tagged as the machine's. If the machine was held or in `error`, it is then put on the
   current default network with isolation applied and its CPU, RAM and disk sizes are re-read
   under the owner's quota, and only then is the hold cleared; disks over the owner's quota keep
   it held (remove a data disk or raise the quota).[^vm][^admin-routes]
4. **Remove row** when the record is stale (the guest is gone, or belongs to something else):
   this is `DELETE /api/vms/:id?rowOnly=true`. It deletes only ProxMate's record and leaves the
   guest alone. It is refused for a guest confirmed as the row's own, or while the guest's
   node can't be confirmed.[^vm]
5. **Retry what was blocked** (start, delete, user deletion).

# Gotchas

- Adopt is refused (409) when the guest carries another machine's tag, is a Proxmox template or
  a Template Store VMID, another machine references the same VMID, there is no guest, or the
  guest's config references a disk that is not one of its own storage volumes (detach that
  disk in Proxmox first).[^vm]
- Tagging needs the API token to hold `VM.Config.Options`. See
  [privileges](/proxmox/privileges.md).[^release-notes]
- If Proxmox was unreachable at boot, the backfill retries every 15 minutes until a pass
  completes, so the list can shrink on its own shortly after an upgrade.[^vm]
- Background: [guest lifecycle](/proxmox/guest-lifecycle.md) (ownership tags and holds),
  [VM service](/services/vm.md), [admin API](/api/admin.md).

[^vm]: backend/src/services/vm.service.ts
[^admin-routes]: backend/src/routes/admin.routes.ts
[^card]: frontend/src/components/admin/unmatched-vms-card.tsx
[^release-notes]: RELEASE_NOTES.md (1.1.0)
