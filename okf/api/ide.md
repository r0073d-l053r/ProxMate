---
type: API Router
title: IDE router
description: Session-authed ProxMate IDE endpoints (capability, gateway-token minting, in-guest provisioning, AVX relocation, BYO AI keys) under /api/ide.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/ide.routes.ts
tags: [proxmate, api, ide, llm, provisioning]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/ide.routes.ts
    title: backend/src/routes/ide.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
  - id: proxy
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-proxy.service.ts
    title: backend/src/services/ide-proxy.service.ts
---

# Purpose

Browser-facing ProxMate IDE management (code-server + OpenCode inside a guest). Mounted at `/api/ide` after the shared middleware; `/api/ide/:id/llm/v1/*` is claimed earlier by the [IDE gateway router](/api/ide-gateway.md) and `/api/ide/:id/proxy/*` even earlier by the IDE reverse proxy.[^app]

# Authentication

- `router.use(requireAuth)` (cookie with CSRF, session JWT Bearer, or API token). No `enforceMfaSetup`.[^routes]
- Per-route checks: VM capability `'ide'` via `getVmWithCap` for mutations, plus VM ownership for provision, relocate and gateway-token (admins and sharees get 403 with an owner-only message) and owner-or-admin for the install log, `getViewableVm` for status polls; `getIdeCapability({ role }).available` for provision/relocate; `canManageKeys` (IDE available AND (`allowByoKeys` OR admin)) for BYO key routes.[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/ide/config` | user | `getIdeCapability({ role })`: `{ available, allowByoKeys, models (shared:* and visible local:*), sharedModels }`. No gateway URL or secrets. |
| POST | `/api/ide/:id/gateway-token` | VM owner + `ide` cap + IDE available (checked in `issueGatewayToken`) | Mint/rotate the per-VM gateway token for the owner; returns `{ token, baseUrl, models }` once. 403 for a non-owner or if IDE not available for the VM. Audited `ide.gateway_token_mint`. |
| POST | `/api/ide/:id/provision` | VM owner + `ide` cap + IDE available | Start installing code-server + OpenCode via the guest agent; returns `{ state }`. 403 with an owner-only message for admins and sharees. `IdeProvisionError` gives 400 with optional `code` (409 with `install_in_progress` while an install is running and not yet timed out). Audited `ide.provision`. |
| GET | `/api/ide/:id/status` | user + viewable VM | `{ state }` from `refreshIdeState` (install progress poll); adds `reinstallRequired: true` for a `ready` install that has no guest secret, which the UI then reinstalls. |
| POST | `/api/ide/:id/relocate` | VM owner + `ide` cap + IDE available | Background stop, offline-migrate to an AVX-capable node, start. 202 `{ started, target }`; server picks the node. `IdeProvisionError` gives 409. Audited `vm.ide_relocate`. 403 with an owner-only message for admins and sharees. |
| GET | `/api/ide/:id/install-log` | `ide` cap + VM owner or admin + `guestLogLimiter` | Tail of `/var/log/pmide-provision.log` read through the guest agent with a fixed `tail -c 65536` (last 500 lines, control characters and ANSI escapes stripped): `{ path, log, truncated, missing }`. 403 for a manager share; 409 when the agent does not answer, for LXC, or when the guest is not the row's own. See [guest-file service](/services/guest-file.md). |
| GET | `/api/ide/:id/relocate-status` | user + viewable VM | Relocation progress, or `{ state: 'none' }`. |
| GET | `/api/ide/keys` | user + `canManageKeys` | Caller's BYO AI keys (no secrets). |
| POST | `/api/ide/keys` | user + `canManageKeys` | Save a BYO key; 201. Audited `ide.llm_key_add`. |
| POST | `/api/ide/keys/:keyId/test` | user + `canManageKeys` | Probe the key's endpoint; returns `{ ok, modelCount, models (max 100), error }`. |
| DELETE | `/api/ide/keys/:keyId` | user (ownership-checked) | Delete a BYO key; 204. Allowed even after BYO is disabled. Audited `ide.llm_key_delete`. |

# Gotchas

- zod `KeySchema`: `label` 1..60, `provider` in `KNOWN_PROVIDERS`, `model` 1..120, `baseUrl` optional URL max 300 or `''`, `key` 1..400.[^routes]
- Tenants are held to public endpoints and preset providers (`addLlmKey(..., { allowPrivate: isAdmin, allowCustomBase: isAdmin })`); `/keys/:keyId/test` runs `assertSafeOutboundUrl` for non-admins (SSRF guard). Admins are exempt so they can use LAN sources such as a private Ollama.[^routes]
- `TooManyLlmKeysError` / `InvalidLlmKeyError` give 400. Keys are encrypted at rest and never returned.[^routes]
- `publicBaseUrl(req)`: `BACKEND_PUBLIC_URL` wins; otherwise derived from `x-forwarded-proto` / `req.protocol` + Host. It must be https in production, because an edge http-to-https 301 turns the agent's POST into a GET and drops the body and Bearer token.[^routes]
- The IDE itself is served by the reverse proxy at `/api/ide/:id/proxy/*` (HTTP and WebSocket), authed by the session cookie and VM ownership (owner only), mounted ahead of helmet/CORS; ProxMate cookies and `Authorization` are stripped from proxied requests, and ProxMate-named `Set-Cookie` and `Service-Worker-Allowed` from responses. It relays only to a guest that proves the VM's per-install secret (see [ide-guest-auth](/services/ide-guest-auth.md)).[^proxy]

# Relationships

- Services: [ide](/services/ide.md), [ide-gateway](/services/ide-gateway.md), [ide-provision](/services/ide-provision.md), [ide-proxy](/services/ide-proxy.md), [tenant-llm-key](/services/tenant-llm-key.md), [vm](/services/vm.md), [audit](/services/audit.md).
- Data: [VirtualMachine](/database/virtual-machine.md) (IDE state), [IdeGatewayToken](/database/ide-gateway-token.md), [IdeGuestSecret](/database/ide-guest-secret.md), [TenantLlmKey](/database/tenant-llm-key.md).
- Admin policy: `PUT /api/admin/settings/ide` in the [admin router](/api/admin.md); [IDE config](/config/ide.md).

[^routes]: backend/src/routes/ide.routes.ts
[^app]: backend/src/app.ts
[^proxy]: backend/src/services/ide-proxy.service.ts
