---
type: Backend Service
title: VNC-proxy service (console tickets and WebSocket relay)
description: Obtains Proxmox vncproxy/termproxy tickets and relays browser WebSockets to the node's vncwebsocket endpoint using the stored API token, for graphical and serial consoles.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vnc-proxy.service.ts
tags: [proxmate, console, vnc, websocket, proxmox]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: vnc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vnc-proxy.service.ts
    title: backend/src/services/vnc-proxy.service.ts
---

# Purpose

Backs the noVNC (RFB) and xterm.js (serial) consoles. The browser connects to ProxMate's `/console` or `/serial` upgrade (handled in `console.routes.ts`); this service opens the matching Proxmox socket and pipes bytes. The browser never sees the Proxmox token.[^vnc]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `requestVncProxy` | `(node, vmid, kind = 'qemu') => { ticket, port }` | POST `/nodes/<node>/<kind>/<vmid>/vncproxy` with `websocket=1`; the ticket is the RFB password. |
| `requestTermProxy` | `(node, vmid, client?, kind) => { ticket, port, user }` | POST `.../termproxy`; client authenticates in-band with `${user}:${ticket}\n`. |
| `connectVncTarget` / `connectSerialTarget` | `(node, vmid, port, ticket, kind)` | Open `wss://<host>/api2/json/nodes/<node>/<kind>/<vmid>/vncwebsocket?port=..&vncticket=..` with `Authorization: PVEAPIToken=<id>=<secret>`. |
| `relay` | `(browser, target)` | Bidirectional pipe, buffering browser messages until the target opens; closes both on either side's close/error. |

# Data

No DB. Uses the Proxmox connection (`host`, `tokenId`, `tokenSecret`, `verifySsl`) from `proxmox.service.getConnectionConfig` — see [proxmox-connection config](/config/proxmox-connection.md).[^vnc]

# Gotchas

- Always `wss://`: Proxmox's API listens on HTTPS only, and a host saved as `http://` works for REST (301) but not for the ws client.[^vnc]
- The text/binary opcode is preserved in both directions: RFB is binary, but termproxy control frames (`0:len:data`, `1:cols:rows:`, `2`) are text.[^vnc]
- TLS verification follows the stored `verifySsl` flag (`rejectUnauthorized`). The private CA from `PROXMOX_CA_CERT` / `PROXMOX_CA_CERT_FILE` (`config.ca`) is passed to the WebSocket as `ca`, the same trust anchor the REST client uses.[^vnc]
- Non-1000 target closes are logged as errors.[^vnc]

# Relationships

- Called by the [console router](/api/console.md) WebSocket handler (dispatched from `index.ts`) and the [vm router](/api/vm.md).
- Uses [proxmox service](/services/proxmox.md); see [PVE API surface](/proxmox/pve-api-surface.md) and [privileges](/proxmox/privileges.md).

[^vnc]: backend/src/services/vnc-proxy.service.ts
