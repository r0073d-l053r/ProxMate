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
  - id: filter
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/console-view-filter.ts
    title: backend/src/lib/console-view-filter.ts
---

# Purpose

Not an Express router: `handleConsoleUpgrade(req, socket, head)` is called from the single HTTP `upgrade` dispatcher in `index.ts` (console first, then the IDE proxy, else the socket is destroyed).[^index] It owns two WebSocket paths and relays bytes between the browser and the Proxmox node using a `noServer` `ws` server.[^routes]

# Authentication

Checked per upgrade, in order:[^routes]

1. **Origin check**: `req.headers.origin` must equal `FRONTEND_URL` (default `http://localhost:3000`), else `403` (anti cross-site WebSocket hijacking).
2. **Session cookie**: `proxmate_session` is read from the raw `Cookie` header and checked with `verifyToken`, which also returns null for a lapsed compute-access window.[^auth] Failure: `401`.
3. **Ticket grant**: `claimConsoleGrant(vncticket, …)` must find the grant recorded when ProxMate minted that ticket, for the same VM, user, transport (`vnc` for `/console`, `serial` for `/serial`) and `port`; only then is it removed (a mismatched attempt leaves it unused). Grants are single use and live one minute. Missing `vncticket`/`port`, or no matching grant: `403`.
4. **Capability**: `resolveVmAccess` + `consoleModeFor` again (the same rule as the mint). Neither `console` nor `console_view`: `403`. The session is interactive only when the grant was minted interactive **and** the caller still holds `console`; otherwise it is view-only (a share downgraded since the mint drops to view-only).

No JWT is ever put in the URL. No API-token support (cookie only).

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET (WS upgrade) | `/api/vms/:id/console?vncticket=…&port=…` | session cookie + Origin + grant + `console`/`console_view` cap | Graphical console; relays via `connectVncTarget` to the node's `vncwebsocket` for a `vncproxy` ticket. |
| GET (WS upgrade) | `/api/vms/:id/serial?vncticket=…&port=…` | session cookie + Origin + grant + `console`/`console_view` cap | Text console; relays via `connectSerialTarget` to the node's `vncwebsocket` for a `termproxy` ticket. |

# View-only sessions

A view-only session runs through `relay(browser, target, filter)` with an input filter from `console-view-filter.ts` on the browser→Proxmox direction; Proxmox→browser is untouched.[^filter] Both filters parse a byte stream (`vncwebsocket` joins frames), so messages split across or coalesced into frames are framed the same, and a large dropped message is skipped without buffering.

- **`RfbViewOnlyFilter`** (graphical): the client's ProtocolVersion must be 3.7 or 3.8; security type None (1), VNC auth (2) or VeNCrypt (19) 0.2 with subtype None, VNC auth or Plain (256, credentials up to 4096 bytes each); the auth reply passes. ClientInit is rewritten to shared (`1`). Then SetPixelFormat (0), SetEncodings (2, at most 256 encodings), FramebufferUpdateRequest (3), EnableContinuousUpdates (150) and ClientFence (248, payload ≤ 64) pass; KeyEvent (4), PointerEvent (5; 7 bytes when the client listed the extended-mouse-buttons pseudo-encoding −316 and set the marker bit), ClientCutText (6, either length sign), xvp (250), SetDesktopSize (251) and QEMU extended key/audio (255/0, 255/1) are dropped.
- **`TermViewOnlyFilter`** (text): the `user:ticket\n` line (≤ 4096 bytes, through the first `\n`) passes; then only `2` keepalives pass, at most one a second. `0:<len>:<data>` is dropped with its `len` data bytes, and `1:<cols>:<rows>:` (≤ 5 digits each, still validated) is dropped too: termproxy's `process_queue` parses whatever its fixed buffer holds after each read, so a resize cut at the buffer's end is half consumed and the rest re-parsed, and a `0` at the front starts the input path. With only `2` bytes after the auth line, no split reaches it.
- Anything else — an unknown type or subtype, a bad length or version, a TLS VeNCrypt subtype — throws `ConsoleFilterError`; the relay closes the browser with `1008` and closes the Proxmox side. Nothing from the bad chunk is forwarded.

The ticket/port are minted first by `POST /api/vms/:id/console` or `POST /api/vms/:id/serial` in the [VM router](/api/vm.md).[^vm]

# Gotchas

- The path match is synchronous and returns `true` before async auth, so the dispatcher never races; once matched, auth failures still close the socket.[^routes]
- The WS gate and the ticket-minting POST must use the same capability rule (`consoleModeFor`); a past bug was them diverging.[^routes]
- The browser never says whether a session is view-only: the mode comes from the recorded grant and the caller's capabilities at upgrade time.[^routes]
- Before relaying it calls `syncVmNode` (the VM may have migrated) and `kindOf` (qemu vs lxc). Proxmox connection failure closes with code `1011`.[^routes]
- `setupConsoleWebSocket(server)` is a back-compat helper; production uses the unified dispatcher.

# Relationships

- Uses the [vm service](/services/vm.md) (`resolveVmAccess`, `syncVmNode`, `kindOf`), the [vm-share service](/services/vm-share.md) (`consoleModeFor`) and the [vnc-proxy service](/services/vnc-proxy.md) (`claimConsoleGrant`, `relay`).
- Session validated against [Session](/database/session.md) and [User](/database/user.md) via the [auth service](/services/auth.md).
- Reads [VirtualMachine](/database/virtual-machine.md) and [VmShare](/database/vm-share.md) for capability checks.
- See [HTTP API](/api/http-api.md) for the WebSocket dispatcher; Proxmox side in [PVE API surface](/proxmox/pve-api-surface.md).

[^routes]: backend/src/routes/console.routes.ts
[^index]: backend/src/index.ts
[^vm]: backend/src/routes/vm.routes.ts
[^auth]: backend/src/services/auth.service.ts
[^filter]: backend/src/lib/console-view-filter.ts
