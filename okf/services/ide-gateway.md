---
type: Backend Service
title: IDE-gateway service (ProxMate LLM gateway policy)
description: Per-VM `pmide_` bearer tokens and the model-routing policy behind the OpenAI-compatible `/api/ide/:id/llm/v1` endpoint used by the in-guest OpenCode agent.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-gateway.service.ts
tags: [proxmate, ide, llm, gateway, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: gw
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-gateway.service.ts
    title: backend/src/services/ide-gateway.service.ts
---

# Purpose

OpenCode runs inside the tenant VM with no ProxMate session cookie, and tenants must never see the admin's model endpoint or any upstream key. OpenCode calls `.../api/ide/:id/llm/v1` with a per-VM gateway token; the gateway resolves it to (user, vm), re-checks ownership and policy, enforces the model allow-list, and forwards upstream. It is the single controlled egress for IDE LLM traffic. The module is transport-free; the route layer does the fetch/stream.[^gw]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `issueGatewayToken` | `(user, vmId, publicApiBaseUrl) => { token, baseUrl } \| null` | Checks `ide` capability, that the user OWNS the VM, and policy; mints `pmide_` + 24 random bytes base64url; upserts on `(userId, vmId)` (rotation) storing SHA-256 `tokenHash` and 12-char `prefix`; returns `<base>/api/ide/<vmId>/llm/v1`. |
| `revokeGatewayToken` | `(userId, vmId)` | Sets `revokedAt` on the active row. |
| `verifyGatewayToken` | `(raw, pathVmId) => { user, vmId } \| null` | Hash lookup; token must be bound to the path VM; not revoked/expired; owner not access-expired; live `getVmWithCap` + VM ownership + `getIdeCapability`; stamps `lastUsedAt`. |
| `listGatewayModels` | `(user) => OpenAiModel[]` | `/v1/models` shape: picker ids plus `byo:<keyId>` when BYO is allowed. |
| `listModelPickerEntries` | `(user)` | Same with labels; used to build the guest's `opencode.json`. |
| `probeModels` | `(baseUrl, apiKey?) => { ok, models, error? }` | GET `<base>/models` with 8 s timeout; never throws. |
| `resolveModelRoute` | `(user, modelId) => UpstreamRoute \| null` | Maps `local:`, `shared:` (or bare shared id) and `byo:` ids to `{ url, apiKey, model, label, kind }`; null when not permitted. |

# Data

- [IdeGatewayToken](/database/ide-gateway-token.md): `userId`, `vmId` (unique pair), `tokenHash`, `prefix`, `revokedAt`, `expiresAt`, `lastUsedAt`.[^gw]
- [TenantLlmKey](/database/tenant-llm-key.md) (`keyEnc` decrypted in memory, `lastUsedAt`), [User](/database/user.md) `accessExpiresAt`.
- SystemConfig `ide_gateway_url`, `ide_gateway_key` (legacy shared models), `ide_local_models` — see [ide config](/config/ide.md).

# Gotchas

- The gateway router mounts bare (no shared auth middleware), so the access-window check is enforced here; otherwise a lapsed tenant's agent would keep spending the admin's LLM credits.[^gw]
- Mint-time checks are not enough; every request re-authorises ownership and the admin policy live.[^gw]
- Tokens are issued to and honoured for the VM's owner only. The token lives inside the owner's guest, so it must never carry an admin's or sharee's identity, models or keys; a token held by anyone else is rejected.[^gw]
- Re-provisioning a VM's IDE rotates its token (upsert).[^gw]
- `resolveModelRoute` is the single choke point stopping access to an unshared model, or BYO keys when BYO is disabled.[^gw]
- BYO forward-time SSRF re-check (`assertSafeOutboundUrl`) for non-`openai` providers blocks DNS rebinding or keys saved before the save-time guard; admins are exempt.[^gw]
- Real upstream model names, endpoints and keys are never exposed to the tenant.[^gw]

# Relationships

- Called by the [ide-gateway router](/api/ide-gateway.md) (bearer, mounted early in `app.ts` with a 15 MB JSON limit), the [ide router](/api/ide.md) and [admin router](/api/admin.md); used by [ide-provision](/services/ide-provision.md).
- Uses [vm](/services/vm.md), [ide](/services/ide.md), [access](/services/access.md), [tenant-llm-key](/services/tenant-llm-key.md), [config](/services/config.md).

[^gw]: backend/src/services/ide-gateway.service.ts
