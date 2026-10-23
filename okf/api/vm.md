---
type: API Router
title: VM router
description: Tenant VM and LXC lifecycle API (create, restore, power, resize, disks, shares, schedules, alerts, snapshots, MateState backups, rescue, console tickets), mounted at /api/vms.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/vm.routes.ts
tags: [proxmate, api, vm, lxc, lifecycle]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/vm.routes.ts
    title: backend/src/routes/vm.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
  - id: console
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/console.routes.ts
    title: backend/src/routes/console.routes.ts
---

# Purpose

The core tenant API for guests (QEMU VMs and LXC containers; `kindOf(vm)` distinguishes them). Mounted at `/api/vms`.[^app]

# Authentication

- `router.use(requireAuth)` then `router.use(enforceMfaSetup)`.[^routes]
- Per-VM authorization helpers (from the vm service), all returning 404 `VM not found` when the caller lacks access:[^routes]
  - `getViewableVm`: any access including read-only shares (reads).
  - `getVmWithCap(id, user, cap)`: capability `configure`, `power` or `backups`.
  - Console ticket mints use `resolveVmAccess` + `consoleModeFor`: `console` (interactive) or `console_view` (view-only, Viewer shares).
  - `getOwnedVm`: owner or admin only; shares never qualify (delete, bulk, rebuild, shares, migrate, convert).
  - `resolveVmAccess`: detail view; returns `access` badge and `caps`.
- Admin-only (role check in handler, 403): `migrate-targets`, `migrate`, `convert-template`; `node`, `forUserId`, `quotaExempt` on create (enforced in `resolveCreateTarget`); `backupKeep` (silently forced to `null` for non-admins).[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/vms` | user | Caller's VMs with refreshed IPs, annotated with access. |
| GET | `/api/vms/live-usage` | user | Aggregate live usage of caller's running VMs. |
| POST | `/api/vms` | user | Create a QEMU VM from an ISO. 201 `{ vm, status }`. Audited `vm.create`. An admin creating it for a tenant (`forUserId`) emails the tenant after the response ([activity-mail](/services/activity-mail.md)); same for containers and template deploys. |
| GET | `/api/vms/lxc-templates` | user | LXC vztmpl templates on the cluster. |
| GET | `/api/vms/restore-capability` | user | `{ enabled }` for restore-from-upload. |
| POST | `/api/vms/restore-upload` | user | multipart `file` (vzdump archive) + `name`; restore as a new guest; 201 `{ vm, status }`. Audited `vm.restore_upload`. |
| POST | `/api/vms/containers` | user | Create an LXC container from a vztmpl volid; 201 `{ vm, status }`. Audited `vm.create`. |
| POST | `/api/vms/bulk` | user (`getOwnedVm` per id) + not locked (except start) | `{ action: start/stop/restart/delete, ids (1..50) }`; per-VM results; a locked VM is a per-item failure. Start, stop and restart run side by side (each waits for its guest's task); deletes run one at a time. Audited `vm.bulk_<action>`. |
| GET | `/api/vms/:id` | any access | Detail + live status, `deployState`, `access`, `caps`, `rescueAvailable`, `filePushMaxBytes`. |
| GET | `/api/vms/:id/metrics` | viewable | RRD history `?timeframe=hour/day/week/month/year` (default hour). |
| GET | `/api/vms/:id/passthrough` | viewable | Attached `hostpciN` devices (empty for LXC). |
| GET | `/api/vms/:id/activity` | viewable | Last 20 audit entries for the VM (no IPs/actor ids; non-admins do not see admin actions except by the owner). |
| PATCH | `/api/vms/:id` | `configure` | Notes, rename (pushed to Proxmox), tags, resize cpu/ram/storage. `tags` are the plain labels: the VM's `project:` tag is kept (set it via the [project router](/api/project.md)). A resize first takes an [automatic snapshot](/services/auto-snapshot.md) (QEMU; reported as `autoSnapshot` in the response; 409 when it can't be taken). Audited `vm.update` / `vm.resize`. |
| GET | `/api/vms/:id/schedule` | viewable | `{ startCron, stopCron }`. |
| PUT | `/api/vms/:id/schedule` | `configure` | Set power schedule (nullable crons). Audited `vm.schedule`. |
| GET | `/api/vms/:id/backup-policy` | viewable | `{ backupCron, backupKeep }`. |
| PUT | `/api/vms/:id/backup-policy` | `backups` | Set backup cron; `backupKeep` 1..14 admin-only. Audited `vm.backup_policy`. |
| GET | `/api/vms/:id/disks` | viewable | Data disks (empty for LXC). |
| POST | `/api/vms/:id/disks` | `configure` + size lock | Add data disk `{ sizeGb 1..4096 }`; 201. Audited `vm.disk_add`. |
| PATCH | `/api/vms/:id/disks/:slot` | `configure` + size lock | Grow data disk, after an automatic snapshot (`autoSnapshot` in the response; 409 when it can't be taken). Audited `vm.disk_resize`. |
| DELETE | `/api/vms/:id/disks/:slot` | `configure` + size lock | Remove data disk. Audited `vm.disk_remove`. |
| GET | `/api/vms/:id/migrate-targets` | admin | `{ current, targets, blockers, localDisks }` from Proxmox preflight intersected with online nodes; offline nodes are added as blockers, and a node Proxmox lists in both `allowed_nodes` and `not_allowed_nodes` without a cause is a target, not a blocker. LXC and passthrough guests get an empty `targets` list with a `*` blocker. |
| POST | `/api/vms/:id/migrate` | admin + not locked | `{ targetNode }`; migrates and notifies owner. Audited `vm.migrate`. |
| GET | `/api/vms/:id/shares` | owned | List shares as `{ id, email, role, createdAt }` (no sharee account id or display name). |
| POST | `/api/vms/:id/shares` | owned + `shareLimiter` | `{ email, role }` share by email; always 202 `{ message }` with the same audit detail, whether or not the address has an account (an address with no account gets a pending share). Audited `vm.share`. After the response, a live share that is new or changed level emails the recipient ([activity-mail](/services/activity-mail.md)); a pending share sends nothing. |
| DELETE | `/api/vms/:id/shares/:shareId` | owned | Remove share. Audited `vm.unshare`. |
| DELETE | `/api/vms/:id` | owned + not locked | Destroy the guest. `?rowOnly=true` (admin only, else 403) removes just the record and leaves the guest untouched. Audited `vm.delete` / `vm.delete_row`. |
| POST | `/api/vms/:id/start` | `power` | Start. Audited `vm.start`. |
| POST | `/api/vms/:id/stop` | `power` + not locked | Graceful stop; `?force=true` kills. Waits up to 45 s for the Proxmox task; a failed task, or a graceful stop the guest has not finished by then, is an error (the latter suggests a forced stop). Audited `vm.stop` / `vm.stop_force`. |
| POST | `/api/vms/:id/restart` | `power` + not locked | Restart. Audited `vm.restart`. |
| POST | `/api/vms/:id/pause` | `power` + not locked | Pause (QEMU only; 409 for LXC). Audited `vm.pause`. |
| POST | `/api/vms/:id/resume` | `power` | Resume (QEMU only). Audited `vm.resume`. |
| POST | `/api/vms/:id/duplicate` | `configure` | Clone to `{ name }` (QEMU only); 201. Audited `vm.duplicate`. |
| POST | `/api/vms/:id/reset-password` | `configure` | Reset guest user password via guest agent (QEMU only); returns `{ password }`. Audited `vm.reset_password`. |
| POST | `/api/vms/:id/ssh-keys` | `configure` | Add `{ username, publicKey }` to the guest via guest agent (QEMU only). Audited `vm.ssh_key_add`. |
| POST | `/api/vms/:id/files` | `configure` + `guestFileLimiter` | multipart `file` (max `GUEST_FILE_PUSH_MAX_BYTES`, default 1 MiB, at most 8 MiB; 413 above) plus `path` (absolute, normalized, not under `/proc`, `/sys`, `/dev`), optional `mode` (default `0644`, no setuid/setgid/sticky), `owner` (guest username) and `createParents` (`true`). Writes the file into the running guest through the guest agent (QEMU only, 409 for LXC or when the agent does not answer). In a folder only root can change it is written as root (then given the owner); in any other folder it is written as the owner, and without an owner that is refused with 400. Returns `{ path, size, sha256, verified }`. Audited `vm.file_push` (path, size, SHA-256, mode, owner; never the contents), or `vm.file_push_failed` with the reason. See [guest-file service](/services/guest-file.md). |
| POST | `/api/vms/:id/rescue` | `configure` | Boot the admin-designated rescue ISO (QEMU only), after an automatic snapshot (`autoSnapshot` in the response; 409 when it can't be taken). Audited `vm.rescue_enter`. |
| POST | `/api/vms/:id/rescue/exit` | `configure` | Leave rescue mode. Audited `vm.rescue_exit`. |
| GET | `/api/vms/:id/alerts` | viewable | Alert rules. |
| POST | `/api/vms/:id/alerts` | `configure` | `{ metric, threshold?, sustainedMin (default 5) }`; 201. 409 beyond 20 rules per VM (`MAX_ALERT_RULES_PER_VM`) or for a duplicate metric/threshold. Audited `vm.alert_add`. |
| DELETE | `/api/vms/:id/alerts/:alertId` | `configure` | Delete rule. Audited `vm.alert_remove`. |
| GET | `/api/vms/:id/live-stats` | viewable | Current cpu/mem/uptime from the live-stats cache. |
| POST | `/api/vms/:id/rebuild` | owned + size lock (`rebuild`) | Re-image from exactly one of `os` (ISO) or `templateId` (QEMU only). Audited `vm.rebuild`. |
| POST | `/api/vms/:id/convert-template` | admin | Convert VM to a Template Store template `{ name, description?, os? }`; 201. Audited `template.create`. |
| GET | `/api/vms/:id/matestates` | viewable | `{ downloadable, items }` MateState backups. |
| POST | `/api/vms/:id/matestates/:msid/download` | `backups` | Email a single-use download link to the caller; `{ emailed, to }`. Audited `matestate.download`. |
| POST | `/api/vms/:id/matestates` | `backups` | Manual backup; 201. Audited `matestate.create`. |
| POST | `/api/vms/:id/matestates/:msid/restore` | `backups` | Restore VM from a MateState of this VM. Audited `matestate.restore`. 403 `Quota exceeded` (with `details`) when the backup would grow the guest past the owner's quota. |
| DELETE | `/api/vms/:id/matestates/:msid` | `backups` | Delete a MateState. Audited `matestate.delete`. |
| GET | `/api/vms/:id/snapshots` | viewable | Proxmox snapshots (empty for LXC). |
| POST | `/api/vms/:id/snapshots` | `backups` | `{ name, description?, includeRam? }`; names starting `pm-auto-` are reserved (400); waits for the task; 201. Audited `snapshot.create`. |
| POST | `/api/vms/:id/snapshots/:name/rollback` | `backups` | Roll back (waits up to 300 s) via matestate `rollbackToSnapshot`: 403 `Quota exceeded` when the snapshot's config would grow the guest past the owner's quota; afterwards the guest is re-tagged, a snapshot holding a `hostpciN` not attached now is refused, and the row's cpu/ram/storage/hasPassthrough are re-synced. Audited `snapshot.rollback`. |
| DELETE | `/api/vms/:id/snapshots/:name` | `backups` | Delete snapshot. Audited `snapshot.delete`. |
| POST | `/api/vms/:id/console` | `console` or `console_view` + not locked | Mint a vncproxy `{ ticket, port, viewOnly }` for the WebSocket relay (refused unless the guest is the row's own, `requireOurGuest`). The mode (`interactive` with `console`, else `view`) is recorded with the ticket via `recordConsoleGrant`; `viewOnly` only tells the browser how to draw. Audited `vm.console_open`, or `vm.console_view_open` for a view-only session. |
| POST | `/api/vms/:id/serial` | `console` or `console_view` | Mint a termproxy `{ ticket, port, user, viewOnly }` (same guest-identity check, mode recording and audit); 409 `no_serial` if a QEMU VM has no serial console. |

# Gotchas

- Static paths (`live-usage`, `lxc-templates`, `restore-capability`, `restore-upload`, `containers`, `bulk`) are declared before `/:id` so they are not read as ids.[^routes]
- **Lock (409)** via `rejectIfLocked`: stop, restart, pause, delete, migrate and console are refused while the IDE is installing or cloud-init is still deploying; bulk stop/restart/delete report such VMs as per-item failures. Start, resume and serial do not call it.[^routes]
- **Size lock (403)** via `rejectIfSizeLocked`: on `adminManaged` or `quotaExempt` VMs only admins may resize, add/resize/remove disks, or rebuild (closes a quota bypass). Rename/tags stay open to the owner.[^routes]
- Validation (zod): names `^[a-zA-Z0-9-]+$` max 63; `cpu` 1..64; `ram` (create, container, resize) int >= 64 MB; ISO `os` must be a bare `*.iso`/`*.img` filename (prevents Proxmox drive-option injection); node names `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`; LXC `template` must match `<storage>:vztmpl/<file>`; containers need `password` (min 5) or `sshKey`; tags max 20 each `^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,30}$`; crons max 120 chars then `isValidCron`; disk slot `^(scsi|virtio|sata|ide)\d+$`; snapshot names `^[a-zA-Z][a-zA-Z0-9_-]*$` max 40; share role accepts `SHARE_ROLES` plus legacy `co-owner`/`read-only` normalized.[^routes]
- Max 12 snapshots per VM (409), automatic ones included. Snapshots, disks, rebuild, convert, duplicate, pause, password reset, SSH key injection, file push and rescue are QEMU-only.[^routes]
- Alerts: metric `down` forces `threshold = 0`; other metrics require `threshold` 1..100.[^routes]
- PATCH rename hits Proxmox first so a PVE failure does not desync the DB; disk is grow-only (enforced in the service).[^routes]
- File push: multer keeps the upload in memory (one file, cap + 1 byte so an exact-size file passes); the path is checked with `validateGuestPath` here and again in the service.[^routes]
- Restore upload: multer streams to the backup share as `.proxmate-upload-<hex>.part`, file name must match `VZDUMP_UPLOAD_RE`, size cap `RESTORE_UPLOAD_MAX_GB` (default 50, 0 disables) giving 413; refuses to overwrite an existing file (409); disabled unless the share is mounted read-write (409). The upload path is not subject to the 1 MB JSON cap (multipart).[^routes]
- Common error mapping: `QuotaError` 403 `Quota exceeded` with `details`; `CreateOptionError` its own status; Proxmox failures 502 `pveMessage(err)`.[^routes]
- Most per-VM reads call `syncVmNode` first because the VM may have moved nodes.[^routes]

# Relationships

- Data: [VirtualMachine](/database/virtual-machine.md), [VmShare](/database/vm-share.md), [AlertRule](/database/alert-rule.md), [MateState](/database/mate-state.md), [DownloadToken](/database/download-token.md), [Template](/database/template.md), [User](/database/user.md), [AuditLog](/database/audit-log.md).
- Services: [vm](/services/vm.md), [proxmox](/services/proxmox.md), [vnc-proxy](/services/vnc-proxy.md), [matestate](/services/matestate.md), [vm-share](/services/vm-share.md), [disk](/services/disk.md), [download](/services/download.md), [restore-upload](/services/restore-upload.md), [deploy-lock](/services/deploy-lock.md), [live-stats](/services/live-stats.md), [power-schedule](/services/power-schedule.md), [alert](/services/alert.md), [template](/services/template.md), [audit](/services/audit.md), [guest-file](/services/guest-file.md).
- WebSocket side of the console: [console relay](/api/console.md).[^console] Public download side: [download router](/api/download.md).
- Proxmox: [guest lifecycle](/proxmox/guest-lifecycle.md), [storage](/proxmox/storage.md).

[^routes]: backend/src/routes/vm.routes.ts
[^app]: backend/src/app.ts
[^console]: backend/src/routes/console.routes.ts
