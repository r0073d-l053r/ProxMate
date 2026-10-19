---
type: Backend Service
title: IDE-proxy service (code-server reverse proxy)
description: HTTP and WebSocket reverse proxy that serves a guest's code-server at `/api/ide/:id/proxy/`, authenticated by session cookie, VM `ide` capability and the admin IDE policy.
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
| `resolveIdeTargetUrl` | `(vm: { ipAddress }, env?) => string \| null` | `IDE_TARGET_OVERRIDE` if set; else `http://<ipAddress>:<IDE_GUEST_PORT or 8080>`; null if no IP or the IP is loopback/link-local. |
| `mountIdeProxy` | `(app: Express)` | Middleware claiming `^/api/ide/([^/]+)/proxy(/...)?`; 302 to add the trailing slash; 401 without a valid session; 403 when not allowed; else `proxy.web`. |
| `handleIdeUpgrade` | `(req, socket, head) => boolean` | WebSocket upgrade for IDE paths (terminals, extension host); Origin check, cookie auth, target resolution, `proxy.ws`. Returns false for non-IDE paths. |

# Data

Reads [VirtualMachine](/database/virtual-machine.md) `ipAddress` via `vm.service.getVmWithCap(vmId, user, 'ide')`; the session via the `SESSION_COOKIE` cookie and [auth service](/services/auth.md) `verifyToken`. Env `IDE_TARGET_OVERRIDE`, `IDE_GUEST_PORT`, `FRONTEND_URL`.[^proxy]

# Gotchas

- Mounted FIRST in `app.ts`, ahead of helmet/CORS/JSON parsing/rate limiting, so request bodies stream untouched and code-server's own headers pass through.[^app]
- `changeOrigin` MUST stay false: code-server validates the WebSocket Origin against Host; rewriting Host makes it reject the management WS with 403 (verified against code-server 4.127).[^proxy]
- The entry URL must end in `/` or relative resolution breaks (hence the 302).[^proxy]
- A tenant with root could report a bogus guest IP via the agent, so loopback/link-local/metadata targets are refused; private LAN is allowed.[^proxy]
- `IDE_TARGET_OVERRIDE` is TEST-ONLY: it sends every VM's IDE to the same box.[^proxy]
- WS Origin check is lenient (absent, `FRONTEND_URL`, or the backend's own host) because the IDE page is served from the backend origin; cookie + ownership are the real gate.[^proxy]
- `verifyToken` returns null for access-expired users, so suspended tenants lose the IDE immediately.[^proxy]
- Reaching code-server through tenant isolation requires the managed `:8080` pinhole added by [ide-provision](/services/ide-provision.md).[^proxy]
- Upstream errors produce 502 `ProxMate IDE: upstream unreachable` or a destroyed socket.[^proxy]

# Relationships

- Wired in `backend/src/app.ts` (`mountIdeProxy`) and `backend/src/index.ts` (upgrade dispatcher, after the console relay).
- Uses [auth](/services/auth.md), [vm](/services/vm.md), [ide](/services/ide.md). See [Proxmox networking](/proxmox/networking.md).

[^proxy]: backend/src/services/ide-proxy.service.ts
[^app]: backend/src/app.ts
