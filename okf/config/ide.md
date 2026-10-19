---
type: Configuration Group
title: ProxMate IDE settings
description: SystemConfig keys controlling the in-guest ProxMate IDE (code-server plus the OpenCode agent), covering who may use it, BYO keys, model catalogs, the legacy model gateway, the firewall ingress CIDR and the RAM floor.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide.service.ts
tags: [proxmate, config, ide, llm, code-server]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: ide
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide.service.ts
    title: backend/src/services/ide.service.ts
  - id: ide-prov
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-provision.service.ts
    title: backend/src/services/ide-provision.service.ts
  - id: ide-gw
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-gateway.service.ts
    title: backend/src/services/ide-gateway.service.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
---

# Purpose

Policy for the ProxMate IDE, which installs code-server and the OpenCode agent inside a QEMU guest through the guest agent. `getIdeConfig()` returns the full policy to the admin view, with the gateway key reduced to `hasGatewayKey`. `saveIdeConfig()` persists it, and admins write it with `PUT /api/admin/settings/ide` ([admin API](/api/admin.md)).[^ide]

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `ide_enabled` | `off` \| `admin` \| `tenants` | `off` (`parseTier` maps anything unknown to `off`) | `saveIdeConfig` ← `PUT /api/admin/settings/ide` (always written) | `getIdeConfig`, capability checks | Who may use the IDE: nobody, admins only, or admins plus tenants. |
| `ide_allow_byo_keys` | `"true"` / `"false"` | false | same (always written) | `getIdeConfig`; gateway BYO path | Whether tenants may plug in their own LLM API keys. |
| `ide_local_models` | JSON array of `{ id, nickname?, model, sourceKeyId, visibility: admin\|shared\|none }` | `[]`. Malformed JSON parses to `[]`; a stored entry with no `id` reads with a stable id derived from its position and fields (`local-<hash>`) | same, only when `localModels` is present; missing ids get `randomUUID()` | `parseLocalModels` → picker models | Admin local models backed by the admin's saved endpoints (`sourceKeyId`), each with a visibility setting. |
| `ide_shared_models` | JSON array of `{ id, label, provider, model }` | `[]` | same, only when `sharedModels` is present | `parseSharedModels`; `ide-gateway` resolves `shared:<id>` | Legacy shared models served through the admin gateway. |
| `ide_gateway_url` | URL string (zod `max(2000)`), trimmed | Unset or blank: shared models can't be resolved (the gateway returns null) | same, only when `gatewayUrl` is present | `ide-gateway.service` (legacy shared-model routing), `getIdeConfig` | Legacy admin local-model endpoint base URL, never shown to tenants. It may be a LAN or loopback address and is deliberately **not** SSRF-checked.[^admin-routes][^ide-gw] |
| `ide_gateway_key` | string (zod `max(500)`). **Secret, stored encrypted** (`sensitive=true`) | Unset: requests go out without an API key | same, only when non-blank (blank keeps the existing key) | `ide-gateway.service` (decrypted by config.service) | API key for `ide_gateway_url`. Admin settings expose only `hasGatewayKey`. |
| `ide_ingress_cidr` | IPv4 CIDR such as `192.168.1.228/32`, or `''` | Unset or empty: no pinhole is added and a warning is logged; an isolated guest's IDE port may be unreachable | same, only when `ingressCidr` is present (`''` clears it) | `ide-provision.service` (`ensureIdePinhole` on the guest port), `getIdeConfig` | Infrastructure source (node, subnet router or backend host) that the managed per-VM firewall pinhole admits to the guest IDE port (`IDE_GUEST_PORT`, default 8080).[^ide-prov] |
| `ide_min_ram_mb` | integer MB string | `8192` (`IDE_MIN_RAM_MB_DEFAULT`); `0` or non-numeric also falls back to it | **No route or UI writes it**; it can only be set by editing the DB row directly | `ide-provision.service` install guardrail | Minimum guest RAM required before the IDE installs. Smaller VMs are refused.[^ide-prov] |

# Validation

`IdeSchema` (admin.routes.ts):[^admin-routes]

- `enabled`: `z.enum(['off','admin','tenants'])`, default `off`
- `allowByoKeys`: boolean, default false
- `localModels`: up to 100 entries of `{ id?: max 64, nickname?: max 80, model: 1–160, sourceKeyId: 1–64, visibility: enum default 'none' }`
- `sharedModels`: up to 50 entries of `{ id: 1–64, label: 1–120, provider: 1–40, model: 1–120 }`
- `gatewayUrl`: max 2000, optional
- `gatewayKey`: max 500, optional (blank keeps the existing key)
- `ingressCidr`: max 64, must pass `isValidIngressCidr` (IPv4 `a.b.c.d/nn` or empty)

# Gotchas

- Provisioning also requires a running QEMU VM (not LXC) with a responding guest agent and AVX exposed to the guest. These are runtime checks, not config.[^ide-prov]
- `ide_ingress_cidr` interacts with [tenant isolation](/config/tenant-isolation.md). With isolation on and the CIDR unset, the reverse proxy can't reach code-server.

[^ide]: backend/src/services/ide.service.ts (`getIdeConfig`, `saveIdeConfig`, `parseTier`, `parseLocalModels`, `parseSharedModels`, `isValidIngressCidr`)
[^ide-prov]: backend/src/services/ide-provision.service.ts (`IDE_MIN_RAM_MB_DEFAULT`, ingress pinhole)
[^ide-gw]: backend/src/services/ide-gateway.service.ts (shared-model routing via `ide_gateway_url` / `ide_gateway_key`)
[^admin-routes]: backend/src/routes/admin.routes.ts (`IdeSchema`, `PUT /settings/ide`)
