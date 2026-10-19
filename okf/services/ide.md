---
type: Backend Service
title: IDE service (ProxMate IDE admin policy)
description: Config-only admin policy for the in-guest ProxMate IDE - availability tier, BYO-key switch, admin-sourced local models with visibility, legacy shared models and the ingress CIDR - and per-user capability resolution.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide.service.ts
tags: [proxmate, ide, llm, policy]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: ide
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide.service.ts
    title: backend/src/services/ide.service.ts
---

# Purpose

The ProxMate IDE is an in-guest code-server (with OpenCode) that ProxMate reverse-proxies. This module owns only the ADMIN POLICY; transport is [ide-proxy](/services/ide-proxy.md), install is [ide-provision](/services/ide-provision.md), LLM routing is [ide-gateway](/services/ide-gateway.md).[^ide]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `isValidIngressCidr` | `(v) => boolean` | Empty or IPv4 CIDR (octets 0..255, prefix 0..32). |
| `getIdeConfig` | `() => IdeConfig` | `{ enabled, allowByoKeys, localModels, sharedModels, gatewayUrl, hasGatewayKey, ingressCidr }`; gateway key masked to a boolean. Malformed JSON parses to `[]`. |
| `saveIdeConfig` | `(data)` | Writes tier and BYO flag always; models/URL/CIDR only when provided; `gatewayKey` only when non-blank (encrypted). Assigns UUIDs to local models without one. |
| `getIdeCapability` | `(user: { role }) => { available, allowByoKeys, models, sharedModels }` | Applies tier and per-model visibility; returns picker ids `shared:<id>` and `local:<id>`. |

Tiers: `off` (nobody), `admin` (admins only), `tenants` (admins + tenants). Local-model visibility: `admin`, `shared` (all users), `none` (hidden from everyone).[^ide]

# Data

SystemConfig keys `ide_enabled`, `ide_allow_byo_keys`, `ide_local_models` (JSON), `ide_shared_models` (JSON, legacy), `ide_gateway_url` (legacy), `ide_gateway_key` (sensitive, legacy), `ide_ingress_cidr` — see [ide config](/config/ide.md). Local models reference an admin-owned [TenantLlmKey](/database/tenant-llm-key.md) by `sourceKeyId`.[^ide]

# Gotchas

- Unknown or missing tier parses to `off`; unknown visibility parses to `none` (fail closed).[^ide]
- Tenants never see a local model's source endpoint or key; the gateway resolves `sourceKeyId` at request time.[^ide]
- An empty `ide_ingress_cidr` means no firewall pinhole is added; on an isolated cluster the IDE is unreachable until it is set.[^ide]

# Relationships

- Called by the [ide router](/api/ide.md) and [admin router](/api/admin.md); used by [ide-proxy](/services/ide-proxy.md) and [ide-gateway](/services/ide-gateway.md).
- Uses [config service](/services/config.md).

[^ide]: backend/src/services/ide.service.ts
