---
type: Backend Service
title: IDE-proxy service (code-server reverse proxy)
description: HTTP and WebSocket reverse proxy that serves a guest's code-server at `/api/ide/:id/proxy/`, authenticated by session cookie, VM ownership and the admin IDE policy, relaying only to a guest that proves the VM's IDE secret and never passing ProxMate cookies across.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-proxy.service.ts
tags: [proxmate, ide, proxy, websocket, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: proxy
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-proxy.service.ts
    title: backend/src/services/ide-proxy.service.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
---

# Purpose

The browser only ever talks to ProxMate; the guest is never exposed. code-server emits relative asset URLs, so the proxy strips the `/api/ide/:id/proxy` prefix and forwards the rest.[^proxy]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `resolveIdeTargetUrl` | `(vm: { ipAddress }, env?) => string \| null` | Re-exported from [ide-guest-auth](/services/ide-guest-auth.md): `IDE_TARGET_OVERRIDE` if set; else `http://<ipAddress>:<IDE_GUEST_PORT or 8080>`; null if no IP or the IP is loopback/link-local. |
| `mountIdeProxy` | `(app: Express)` | Middleware claiming `^/api/ide/([^/]+)/proxy(/...)?`; 302 to add the trailing slash; 401 without a valid session; 403 when not allowed (including a non-owner, with an owner-only message); 409 when the install has no guest secret (reinstall needed); 502 when the guest can't prove the secret; else `proxy.web` with the guest cookie attached. |
| `guestCookieHeader` | `(header, guestCookie) => string` | The Cookie header sent to the guest: the browser's cookies minus every `proxmate_*` cookie and any `code-server-session*`, plus the server-held guest cookie. |
| `sanitizeGuestResponseHeaders` | `(headers) => void` | Removes `Service-Worker-Allowed`, any nameless `Set-Cookie`, and any `Set-Cookie` for `proxmate_*` or `code-server-session*` (also when hidden behind leading `=` or whitespace) from a guest response (HTTP via `proxyRes`, WebSocket 101/refusals via `proxyReqWs`). |
| `handleIdeUpgrade` | `(req, socket, head) => boolean` | WebSocket upgrade for IDE paths (terminals, extension host); Origin check, cookie auth, target resolution and guest proof (same status codes as HTTP), `proxy.ws`. Returns false for non-IDE paths. |

# Data

Reads [VirtualMachine](/database/virtual-machine.md) `ipAddress` via `vm.service.getVmWithCap(vmId, user, 'ide')`; the VM's [IdeGuestSecret](/database/ide-guest-secret.md) via [ide-guest-auth](/services/ide-guest-auth.md); the session via the `SESSION_COOKIE` cookie and [auth service](/services/auth.md) `verifyToken`. Env `IDE_TARGET_OVERRIDE`, `IDE_GUEST_PORT`, `FRONTEND_URL`.[^proxy]

# Gotchas

- Mounted FIRST in `app.ts`, ahead of helmet/CORS/JSON parsing/rate limiting, so request bodies stream untouched; code-server's own headers pass through except the ones `sanitizeGuestResponseHeaders` removes.[^app]
- Only the VM's owner is served (admins and sharees with the `ide` capability get 403): guest content runs on the ProxMate origin under the guest root user's control.[^proxy]
- ProxMate's own credentials never reach the guest: every `proxmate_*` cookie and the `Authorization` header are removed from proxied HTTP and WebSocket requests.[^proxy]
- `changeOrigin` MUST stay false: code-server validates the WebSocket Origin against Host; rewriting Host makes it reject the management WS with 403 (verified against code-server 4.127).[^proxy]
- The entry URL must end in `/` or relative resolution breaks (hence the 302).[^proxy]
- Only a running VM that is not held (`holdReason` unset) is proxied (409 otherwise, with the hold's explanation). The guest IP comes from the guest's own agent and is re-read live before each proof; loopback/link-local/metadata targets are refused, and the target must prove the VM's per-install secret before anything is relayed (a proof is reused for up to 5 minutes while the recorded IP is unchanged). A different VM's code-server or an unrelated service can't prove it, so the proxy refuses it. This assumes the backend-to-guest network path is trusted.[^proxy]
- An install without a guest secret (made before guest authentication) is refused with 409 and a reinstall message; reinstalling creates the secret.[^proxy]
- `IDE_TARGET_OVERRIDE` is TEST-ONLY: it sends every VM's IDE to the same box. The guest proof still applies to it.[^proxy]
- WS Origin check is lenient (absent, `FRONTEND_URL`, or the backend's own host) because the IDE page is served from the backend origin; cookie + ownership are the real gate.[^proxy]
- `verifyToken` returns null for access-expired users, so suspended tenants lose the IDE immediately.[^proxy]
- Reaching code-server through tenant isolation requires the managed pinhole on `IDE_GUEST_PORT` (8080 by default) added by [ide-provision](/services/ide-provision.md).[^proxy]
- Upstream errors produce 502 `ProxMate IDE: upstream unreachable` or a destroyed socket.[^proxy]

# Relationships

- Wired in `backend/src/app.ts` (`mountIdeProxy`) and `backend/src/index.ts` (upgrade dispatcher, after the console relay).
- Uses [auth](/services/auth.md), [vm](/services/vm.md), [ide](/services/ide.md), [ide-guest-auth](/services/ide-guest-auth.md). See [Proxmox networking](/proxmox/networking.md).

[^proxy]: backend/src/services/ide-proxy.service.ts
[^app]: backend/src/app.ts
