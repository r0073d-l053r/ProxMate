---
type: Configuration Group
title: Automatic snapshot settings
description: SystemConfig keys turning the automatic snapshot before a resize, data-disk grow or rescue boot on or off and setting how many automatic snapshots each VM keeps.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auto-snapshot.service.ts
tags: [proxmate, config, snapshots]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T12:00:00Z }
sources:
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auto-snapshot.service.ts
    title: backend/src/services/auto-snapshot.service.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
---

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `auto_snapshot_enabled` | `"true"` / `"false"` | **On**: only `'false'` turns it off | `PUT /api/admin/settings/auto-snapshot` (`{ enabled: boolean, keep: 1..10 }`) | `autoSnapshotBefore`; `GET /api/admin/settings` (`autoSnapshot`) | Take a snapshot before a resize, data-disk grow or rescue boot (QEMU only).[^svc][^admin-routes] |
| `auto_snapshot_keep` | integer string | `3` (also for any value outside 1..10) | same route | retention after each automatic snapshot | Automatic snapshots kept per VM; older recorded ones are deleted.[^svc] |

# Gotchas

- With it on, a change whose snapshot fails is refused with a 409 that says an admin can turn this off. A VM on storage without snapshot support goes ahead, and the response says no snapshot was taken.[^svc]
- Rebuild isn't covered (see [auto-snapshot service](/services/auto-snapshot.md)).
- The route records an `admin.auto_snapshot_config` audit entry.[^admin-routes]

# Relationships

- [Auto-snapshot service](/services/auto-snapshot.md), [AutoSnapshot](/database/auto-snapshot.md), [admin API](/api/admin.md).

[^svc]: backend/src/services/auto-snapshot.service.ts
[^admin-routes]: backend/src/routes/admin.routes.ts
