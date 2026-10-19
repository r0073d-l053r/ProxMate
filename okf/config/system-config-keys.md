---
type: Reference
title: SystemConfig key index
description: Alphabetical list of every SystemConfig key the ProxMate backend reads or writes, with its encryption status and the configuration group that documents it.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/config.service.ts
tags: [proxmate, config, reference, system-config]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: config-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/config.service.ts
    title: backend/src/services/config.service.ts
  - id: crypto
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/crypto.ts
    title: backend/src/lib/crypto.ts
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
---

# Purpose

ProxMate keeps its runtime settings in the [SystemConfig](/database/system-config.md) table (`key String @id`, `value String`, `sensitive Boolean @default(false)`, `updatedAt`).[^schema] All access goes through `getConfig(key)` and `setConfig(key, value, sensitive = false)` in config.service.ts. The one exception is `isSetupComplete()`, which reads `setup_complete` with Prisma directly. No other code touches `prisma.systemConfig`.[^config-svc]

The key list was built by grepping every `getConfig('…')` / `setConfig('…')` call under `backend/src`, plus the three keys held in constants (`KIOSK_PIN_KEY = 'kiosk_exit_pin'`, `LAST_RUN_KEY = 'matestate_last_run'`, `VM_BACKUP_TICK_KEY = 'matestate_vm_tick_last'`). There are 55 keys.

# Encryption

When `sensitive=true`, `setConfig` stores `encrypt(value)`: AES-256-GCM with a random 12-byte IV and a 16-byte auth tag, serialized as `ivHex:tagHex:ciphertextHex`. The key is `ENCRYPTION_KEY`, which must be 64 hex chars. `getConfig` decrypts whenever the row's `sensitive` flag is set.[^crypto] `GET /api/admin/settings` returns booleans (`hasSecret`, `hasPass`, `hasGatewayKey`, `kiosk.pinSet`) instead of the Proxmox token secret, SMTP password, SSO client secret, IDE gateway key and kiosk PIN. The decrypted `notify_webhook_url` is the exception: it is returned as `notify.webhookUrl`. The write paths for those four secrets keep the existing value when the submitted field is blank; `kiosk_exit_pin` and `notify_webhook_url` are cleared by `''`. See [backend environment](/env/backend-environment.md) for key handling.

# Schema

| Key | Encrypted | Group |
|---|---|---|
| `appdb_backup_dir` | no | [appdb-backup](/config/appdb-backup.md) |
| `appdb_backup_keep` | no | [appdb-backup](/config/appdb-backup.md) |
| `backup_storage` | no | [provisioning-defaults](/config/provisioning-defaults.md) |
| `balancer_exclude` | no | [cluster-balancer](/config/cluster-balancer.md) |
| `balancer_max_moves` | no | [cluster-balancer](/config/cluster-balancer.md) |
| `balancer_mode` | no | [cluster-balancer](/config/cluster-balancer.md) |
| `balancer_threshold` | no | [cluster-balancer](/config/cluster-balancer.md) |
| `cloudinit_base` | no | [cloud-init](/config/cloud-init.md) |
| `cloudinit_offered` | no | [cloud-init](/config/cloud-init.md) |
| `default_bridge` | no | [provisioning-defaults](/config/provisioning-defaults.md) |
| `default_storage` | no | [provisioning-defaults](/config/provisioning-defaults.md) |
| `frontend_url` | no | [platform-secrets](/config/platform-secrets.md) |
| `ide_allow_byo_keys` | no | [ide](/config/ide.md) |
| `ide_enabled` | no | [ide](/config/ide.md) |
| `ide_gateway_key` | **yes** | [ide](/config/ide.md) |
| `ide_gateway_url` | no | [ide](/config/ide.md) |
| `ide_ingress_cidr` | no | [ide](/config/ide.md) |
| `ide_local_models` | no | [ide](/config/ide.md) |
| `ide_min_ram_mb` | no | [ide](/config/ide.md) |
| `ide_shared_models` | no | [ide](/config/ide.md) |
| `iso_storage` | no | [provisioning-defaults](/config/provisioning-defaults.md) |
| `isolation_dns_servers` | no | [tenant-isolation](/config/tenant-isolation.md) |
| `isolation_enabled` | no | [tenant-isolation](/config/tenant-isolation.md) |
| `isolation_vlan_tag` | no | [tenant-isolation](/config/tenant-isolation.md) |
| `jwt_secret` | **yes** | [platform-secrets](/config/platform-secrets.md) |
| `kiosk_exit_pin` | **yes** (bcrypt hash, then encrypted; `''` plain when cleared) | [platform-secrets](/config/platform-secrets.md) |
| `matestate_last_run` | no | [platform-secrets](/config/platform-secrets.md) |
| `matestate_vm_tick_last` | no | [platform-secrets](/config/platform-secrets.md) |
| `notify_email_enabled` | no | [notifications](/config/notifications.md) |
| `notify_email_to` | no | [notifications](/config/notifications.md) |
| `notify_events` | no | [notifications](/config/notifications.md) |
| `notify_events_version` | no | [notifications](/config/notifications.md) |
| `notify_webhook_url` | **yes when non-empty** | [notifications](/config/notifications.md) |
| `proxmox_host` | no | [proxmox-connection](/config/proxmox-connection.md) |
| `proxmox_token_id` | no | [proxmox-connection](/config/proxmox-connection.md) |
| `proxmox_token_secret` | **yes** | [proxmox-connection](/config/proxmox-connection.md) |
| `proxmox_verify_ssl` | no | [proxmox-connection](/config/proxmox-connection.md) |
| `rescue_iso` | no | [provisioning-defaults](/config/provisioning-defaults.md) |
| `setup_complete` | no | [platform-secrets](/config/platform-secrets.md) |
| `smtp_from` | no | [smtp](/config/smtp.md) |
| `smtp_host` | no | [smtp](/config/smtp.md) |
| `smtp_pass` | **yes** | [smtp](/config/smtp.md) |
| `smtp_port` | no | [smtp](/config/smtp.md) |
| `smtp_secure` | no | [smtp](/config/smtp.md) |
| `smtp_user` | no | [smtp](/config/smtp.md) |
| `sso_admin_group` | no | [sso](/config/sso.md) |
| `sso_allow_signup` | no | [sso](/config/sso.md) |
| `sso_button_label` | no | [sso](/config/sso.md) |
| `sso_client_id` | no | [sso](/config/sso.md) |
| `sso_client_secret` | **yes** | [sso](/config/sso.md) |
| `sso_enabled` | no | [sso](/config/sso.md) |
| `sso_groups_claim` | no | [sso](/config/sso.md) |
| `sso_issuer` | no | [sso](/config/sso.md) |
| `sso_scopes` | no | [sso](/config/sso.md) |
| `template_refresh_enabled` | no | [template-refresh](/config/template-refresh.md) |

# Gotchas

- Two keys are read but never written by any route or UI: `frontend_url` and `ide_min_ram_mb`. They can only be set by editing the DB directly.
- Boolean keys are stored as `"true"` / `"false"` strings. Most readers test `=== 'true'`, so a missing row means false. `isolation_enabled` is the exception: it tests `!== 'false'`, so a missing row means **on**.
- `GET /api/admin/settings` aggregates most groups in one response ([admin API](/api/admin.md)). Tenant isolation (`/api/admin/isolation`), the cluster balancer (`/api/admin/balancer`) and cloud-init (`/api/templates/cloud-init-config`) have their own endpoints.

[^config-svc]: backend/src/services/config.service.ts
[^crypto]: backend/src/lib/crypto.ts (`encrypt`, `decrypt`, `getKey`)
[^schema]: backend/prisma/schema.prisma (`model SystemConfig`)
