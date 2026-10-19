---
type: API Router
title: Console WebSocket relay
description: WebSocket upgrade handler that relays the browser's noVNC and xterm.js consoles to Proxmox vncproxy/termproxy for /api/vms/:id/console and /api/vms/:id/serial.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/console.routes.ts
tags: [proxmate, api, websocket, console, vnc]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/console.routes.ts
    title: backend/src/routes/console.routes.ts
  - id: index
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/index.ts
    title: backend/src/index.ts
  - id: vm
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/vm.routes.ts
    title: backend/src/routes/vm.routes.ts
  - id: auth
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auth.service.ts
    title: backend/src/services/auth.service.ts
---

# Purpose

Not an Express router: `handleConsoleUpgrade(req, socket, head)` is called from the single HTTP `upgrade` dispatcher in `index.ts` (console first, then the IDE proxy, else the socket is destroyed).[^index] It owns two WebSocket paths and relays bytes between the browser and the Proxmox node using a `noServer` `ws` server.[^routes]

# Authentication

Checked per upgrade, in order:[^routes]

1. **Origin check**: `req.headers.origin` must equal `FRONTEND_URL` (default `http://localhost:3000`), else `403` (anti cross-site WebSocket hijacking).
2. **Session cookie**: `proxmate_session` is read from the raw `Cookie` header and checked with `verifyToken`, which also returns null for a lapsed compute-access window.[^auth] Failure: `401`.
3. **Capability**: `getVmWithCap(vmId, user, 'console')` (owner/admin and shares with the console capability; viewer shares rejected). Missing VM, `vncticket` or `port` query params: `403`.

No JWT is ever put in the URL. No API-token support (cookie only).

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET (WS upgrade) | `/api/vms/:id/console?vncticket=…&port=…` | session cookie + Origin + `console` cap | Graphical console; relays via `connectVncTarget` to the node's `vncwebsocket` for a `vncproxy` ticket. |
| GET (WS upgrade) | `/api/vms/:id/serial?vncticket=…&port=…` | session cookie + Origin + `console` cap | Text console; relays via `connectSerialTarget` to the node's `vncwebsocket` for a `termproxy` ticket. |

The ticket/port are minted first by `POST /api/vms/:id/console` or `POST /api/vms/:id/serial` in the [VM router](/api/vm.md).[^vm]

# Gotchas

- The path match is synchronous and returns `true` before async auth, so the dispatcher never races; once matched, auth failures still close the socket.[^routes]
- The WS gate and the ticket-minting POST must use the same `'console'` capability; a past bug was them diverging.[^routes]
- Before relaying it calls `syncVmNode` (the VM may have migrated) and `kindOf` (qemu vs lxc). Proxmox connection failure closes with code `1011`.[^routes]
- `setupConsoleWebSocket(server)` is a back-compat helper; production uses the unified dispatcher.

# Relationships

- Uses the [vm service](/services/vm.md) (`getVmWithCap`, `syncVmNode`, `kindOf`) and the [vnc-proxy service](/services/vnc-proxy.md).
- Session validated against [Session](/database/session.md) and [User](/database/user.md) via the [auth service](/services/auth.md).
- Reads [VirtualMachine](/database/virtual-machine.md) and [VmShare](/database/vm-share.md) for capability checks.
- See [HTTP API](/api/http-api.md) for the WebSocket dispatcher; Proxmox side in [PVE API surface](/proxmox/pve-api-surface.md).

[^routes]: backend/src/routes/console.routes.ts
[^index]: backend/src/index.ts
[^vm]: backend/src/routes/vm.routes.ts
[^auth]: backend/src/services/auth.service.ts
