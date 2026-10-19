---
type: API Router
title: Admin router
description: Admin-only platform settings, cluster health and isolation, audit log, quota and passthrough approvals, broadcasts, balancer and self-update endpoints, mounted at /api/admin.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
tags: [proxmate, api, admin, settings, cluster]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
---

# Purpose

Everything an operator does after setup. Mounted at `/api/admin`.[^app]

# Authentication

- `router.use(requireAuth, requireAdmin, enforceMfaSetup)` on every route: non-admins get 403 `Forbidden — admin access required`; an admin who must enrol MFA gets 403 `mfa_setup_required`.[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/admin/audit` | admin | Audit log page (`?limit` default 100, `?offset` default 0). |
| GET | `/api/admin/settings` | admin | Aggregated settings: proxmox (`hasSecret`, no secret), defaults, rescueIso, templateRefreshEnabled, smtp (`hasPass`), notify, sso (`hasSecret`, `callbackUrl`), ide (`hasGatewayKey`), appdbBackup (plus `mountedDir`), kiosk `pinSet`. |
| PUT | `/api/admin/settings/kiosk` | admin + requireSession | `{ pin }` 4-12 digits or `''` to clear. Audited `admin.kiosk_config`. |
| PUT | `/api/admin/settings/appdb-backup` | admin | `{ dir, keep (1..365, default 7) }`; probes the dir is writable. Audited `admin.appdb_backup_config`. |
| POST | `/api/admin/settings/appdb-backup/run` | admin | Run an app-DB backup now; `{ ok, file, pruned }`. Audited `admin.appdb_backup_run`. |
| PUT | `/api/admin/settings/smtp` | admin | `{ host, port, secure, user?, pass?, from? }`; blank `pass` keeps existing. |
| POST | `/api/admin/settings/smtp/test` | admin | Verify SMTP. |
| PUT | `/api/admin/settings/notifications` | admin | `{ webhookUrl?, clearWebhookUrl?, emailEnabled, emailTo?, events }`; a blank `webhookUrl` keeps the stored one, `clearWebhookUrl: true` removes it. Audited `admin.notify_config` with detail `webhook replaced\|removed\|kept, email on\|off, N events` (never the URL). |
| POST | `/api/admin/settings/notifications/test` | admin | Send a test notification. |
| PUT | `/api/admin/settings/ide` | admin | IDE policy `{ enabled: off/admin/tenants, allowByoKeys, localModels?, sharedModels?, gatewayUrl?, gatewayKey?, ingressCidr? }`. Audited `admin.ide_config`. |
| GET | `/api/admin/ide/sources` | admin | Admin's own saved LLM keys (model sources). |
| POST | `/api/admin/ide/test-source` | admin | `{ keyId }`; probe that key's endpoint models. |
| POST | `/api/admin/ide/test-reachability` | admin | `{ vmId? }`; probe IDE reachability on a VM (if omitted, auto-picks a running QEMU VM with an IP, preferring one whose IDE is ready; 404 if none). |
| PUT | `/api/admin/settings/sso` | admin + requireSession | OIDC config `{ enabled, issuer (URL), clientId, clientSecret?, scopes?, groupsClaim?, adminGroup?, allowSignup?, buttonLabel? }`. Audited `admin.sso_config`. |
| POST | `/api/admin/settings/sso/test` | admin | OIDC discovery check. |
| GET | `/api/admin/password-requests` | admin | Pending password reset requests (no-SMTP flow). |
| POST | `/api/admin/users/:id/reset-password` | admin + requireSession | Set `{ password (min 8), removePasskeys? }` for a user; `removePasskeys: true` (default false) also deletes their passkeys. Audited `admin.reset_password`. |
| PUT | `/api/admin/settings/proxmox` | admin | `{ host, tokenId, tokenSecret?, verifySsl }`; secret only replaced if non-blank and stored encrypted. |
| POST | `/api/admin/settings/proxmox/test` | admin | Test Proxmox connection. |
| PUT | `/api/admin/settings/defaults` | admin | `{ storage, bridge, isoStorage, backupStorage? }`; `bridge` must match `NETWORK_NAME_RE`, `backupStorage: ''` clears the override. Audited `admin.settings_defaults` with a before/after diff. |
| PUT | `/api/admin/settings/rescue` | admin | `{ iso }` sets `rescue_iso`. |
| PUT | `/api/admin/settings/template-refresh` | admin | `{ enabled }` sets `template_refresh_enabled`. |
| GET | `/api/admin/cluster-stats` | admin | Cluster totals (disk pool = `default_storage`). |
| GET | `/api/admin/nodes` | admin | Node health. |
| GET | `/api/admin/storage-pinning` | admin | Storage pinning report. |
| GET | `/api/admin/placement-diagnostics` | admin | Placement diagnostics using `iso_storage` and `default_storage`. |
| GET | `/api/admin/isolation` | admin | Tenant isolation state: `isolationEnabled`, `clusterFirewallEnabled`, `enforced`, `reachable`, `suggestedMgmtCidr`, `dnsServers`, `vlanTag`. `reachable: false` means Proxmox could not be asked, so the firewall state is unknown; the settings page then shows that and hides the enforcement controls. |
| PUT | `/api/admin/isolation` | admin | `{ enabled, dnsServers?, vlanTag? ('' or 1..4094) }`. |
| POST | `/api/admin/isolation/enforce` | admin | `{ managementCidr }`; enable the Proxmox cluster firewall with that management CIDR allowed. |
| DELETE | `/api/admin/isolation/enforce` | admin | Disable the cluster firewall. |
| GET | `/api/admin/all-vms` | admin | All users with quotas and their VMs (IPs refreshed). |
| GET | `/api/admin/live-stats` | admin | Live stats for all guests. |
| GET | `/api/admin/live-feed` | admin | Server-Sent Events stream of live stats (`text/event-stream`). |
| GET | `/api/admin/resource-history` | admin | Per-user usage history, `?days` clamped 1..90 (default 7). |
| GET | `/api/admin/quota-requests` | admin | Pending quota requests. |
| POST | `/api/admin/quota-requests/:id/approve` | admin | Approve. Audited `quota.approve`. |
| POST | `/api/admin/quota-requests/:id/deny` | admin | Deny. Audited `quota.deny`. |
| GET | `/api/admin/pci-mappings` | admin | Proxmox PCI resource mappings. |
| GET | `/api/admin/passthrough-requests` | admin | Pending passthrough requests. |
| POST | `/api/admin/passthrough-requests/:id/approve` | admin | `{ mapping }`; plans then applies in background; 202 `{ started, targetNode, willMigrate, targetstorage, bootWarnings }`. Audited `passthrough.approve_started`. |
| POST | `/api/admin/passthrough-requests/:id/deny` | admin | Deny. Audited `passthrough.deny`. |
| GET | `/api/admin/vms/unmatched` | admin | Machines whose VMID has no guest carrying their ProxMate tag (`listUnmatchedVms`), with what is at the VMID; shown in Settings → Maintenance → Unconfirmed machines with Adopt / Remove row (Remove row is `DELETE /api/vms/:id?rowOnly=true`). 502 when Proxmox can't be read. |
| POST | `/api/admin/vms/:id/adopt` | admin | Tag the guest at the row's VMID as this row's (`adoptGuest`); a held or `error` row is then made safe and its hold cleared (disks over quota keep it held). 409 when refused (another machine's tag, a template, a VMID shared with another row, no guest, or a volume that isn't its own). Audited `vm.adopt`. |
| POST | `/api/admin/vms/:id/passthrough/detach` | admin | `{ index? (0..15, default 0) }` detach `hostpci<index>`. Audited `passthrough.detach`. |
| POST | `/api/admin/broadcast` | admin | `{ subject (1..200), message (1..5000) }`; email every non-opted-out user with an unsubscribe link. Audited `admin.broadcast`. |
| GET | `/api/admin/balancer` | admin | Balancer settings + computed plan. |
| PUT | `/api/admin/balancer` | admin | `{ mode: off/recommend/auto, thresholdPct 5..50, maxMoves 1..20, exclude: vmid[] }`. Audited `balancer.settings`. |
| POST | `/api/admin/balancer/apply` | admin | `{ moves: [{ vmId, toNode }] (1..50) }`; runs in background; 202. Audited `balancer.apply`. |
| POST | `/api/admin/balancer/drain` | admin | `{ node, targetNode? }`; returns a drain plan (does not execute). |
| GET | `/api/admin/updates/check` | admin | Check GitHub for a newer release (`?force=true` bypasses cache). |
| GET | `/api/admin/updates/status` | admin | `{ enabled, current, ...status }`. |
| POST | `/api/admin/updates/apply` | admin | `{ tag }`; queue a self-update; 409 `not_enabled` unless `SELF_UPDATE_ENABLED` host updater is set up. Audited `admin.update_requested`. |

# Gotchas

- All bodies are zod-validated; failures are 400 with `details` (some return a short fixed message instead).[^routes]
- SSRF guard: `webhookUrl` must pass `assertPublicHttpUrlShape`.[^routes]
- Secrets are never returned by `GET /settings` (only `hasSecret` / `hasPass` / `hasGatewayKey`, and for the notification webhook `hasWebhookUrl` plus `webhookUrlMasked`, scheme and host only), and blank secret fields on PUT keep the stored value.[^routes]
- Audited: `PUT /settings/proxmox` (`admin.proxmox_config`), `PUT /settings/smtp` (`admin.smtp_config`), `PUT /settings/rescue`, `PUT /settings/template-refresh`, `PUT /isolation` and isolation enforce/unenforce. Entries name what changed and whether a secret was replaced, never the secret value.[^routes]
- Passthrough approve and balancer apply return 202 and run asynchronously (`void ... .catch(console.error)`); errors after 202 only reach the log.[^routes]
- `GET /isolation` treats `isolation_enabled` as on unless it is exactly `'false'`.[^routes]
- Broadcast unsubscribe base URL: `frontend_url` config, else `BACKEND_PUBLIC_URL`, else `FRONTEND_URL`; no link if all are empty. Requires SMTP (400 otherwise).[^routes]
- `appdb-backup` dir must be an absolute path (or empty to disable); a write probe file is created and removed.[^routes]

# Relationships

- Config keys in [SystemConfig](/database/system-config.md): [Proxmox connection](/config/proxmox-connection.md), [provisioning defaults](/config/provisioning-defaults.md), [tenant isolation](/config/tenant-isolation.md), [SSO](/config/sso.md), [SMTP](/config/smtp.md), [notifications](/config/notifications.md), [IDE](/config/ide.md), [cluster balancer](/config/cluster-balancer.md), [app DB backup](/config/appdb-backup.md), [template refresh](/config/template-refresh.md).
- Data: [AuditLog](/database/audit-log.md), [User](/database/user.md), [VirtualMachine](/database/virtual-machine.md), [QuotaRequest](/database/quota-request.md), [PassthroughRequest](/database/passthrough-request.md), [PasswordResetRequest](/database/password-reset-request.md), [ResourceSample](/database/resource-sample.md), [TenantLlmKey](/database/tenant-llm-key.md).
- Services: [config](/services/config.md), [setup](/services/setup.md), [proxmox](/services/proxmox.md), [audit](/services/audit.md), [resource-history](/services/resource-history.md), [live-stats](/services/live-stats.md), [quota-request](/services/quota-request.md), [cluster-balancer](/services/cluster-balancer.md), [passthrough-request](/services/passthrough-request.md), [update](/services/update.md), [mail](/services/mail.md), [broadcast-optout](/services/broadcast-optout.md), [notify](/services/notify.md), [sso](/services/sso.md), [ide](/services/ide.md), [ide-provision](/services/ide-provision.md), [appdb-backup](/services/appdb-backup.md), [kiosk](/services/kiosk.md), [password-reset](/services/password-reset.md), [vm](/services/vm.md).
- Proxmox: [networking](/proxmox/networking.md) (firewall/isolation), [privileges](/proxmox/privileges.md).

[^routes]: backend/src/routes/admin.routes.ts
[^app]: backend/src/app.ts
