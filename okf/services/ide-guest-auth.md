---
type: Backend Service
title: IDE guest-auth service (per-VM code-server credential)
description: Generates, stores and checks the per-VM secret that a guest's code-server must prove before the IDE proxy relays to it, and that authenticates every proxied request.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-guest-auth.service.ts
tags: [proxmate, ide, security, code-server]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: guest
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-guest-auth.service.ts
    title: backend/src/services/ide-guest-auth.service.ts
---

# Purpose

The IDE proxy dials the address the guest's own agent reports, so reaching a code-server there says nothing about which VM it belongs to. Each install therefore gets its own secret, and code-server runs with password auth keyed to it. The proxy relays only to a guest that proves the secret, and adds the matching session cookie to every request.[^guest]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `newIdeGuestSecret` | `() => string` | 32 random bytes, base64url. |
| `ideGuestCookieValue` | `(secret) => string` | SHA-256 hex of the secret: the guest's `HASHED_PASSWORD` and the `code-server-session` cookie value. |
| `saveIdeGuestSecret` / `loadIdeGuestSecret` | `(vmId, secret)` / `(vmId) => string \| null` | Encrypted upsert / decrypt of [IdeGuestSecret](/database/ide-guest-secret.md); null when missing or undecryptable. |
| `proveIdeGuest` | `(target, secret, timeoutMs?) => boolean` | POSTs the secret to the guest's `/login` and requires the returned `code-server-session` cookie to equal the expected hash. |
| `resolveIdeTargetUrl` | `(vm: { ipAddress }, env?) => string \| null` | `IDE_TARGET_OVERRIDE` if set; else `http://<ipAddress>:<IDE_GUEST_PORT or 8080>`; null if no IP or the IP is loopback/link-local. |
| `proveIdeGuestTarget` | `(vm, secret, env?) => string \| null` | Running VMs only. Reuses a proof under 5 minutes old while the VM's recorded address still matches it; otherwise reads the address live from the guest agent (recording it if it moved), proves the guest there and returns the target. A stopped VM or a changed address drops the cached proof. Concurrent misses for a VM share one agent read and one proof. In a proof's last 60 seconds a request starts a background re-proof at the same target (sharing that single flight) and keeps getting the still-valid entry; success extends it, failure lets it expire. |

# Gotchas

- The guarantee is that the answering code-server holds this VM's secret. It assumes the address is the one this VM's guest agent reports now and that the backend-to-guest network path is trusted (as the isolation pinhole already does); it does not authenticate the network itself.[^guest]

- Uses code-server's SHA256 password mode (`--auth password` with a non-argon2 `HASHED_PASSWORD`), where the session cookie must equal the hash string; verified against code-server 4.128.0. A successful login does not consume code-server's login rate limit.[^guest]
- The browser never receives the guest cookie; the proxy adds it server-side.[^guest]
- Applies to `IDE_TARGET_OVERRIDE` targets too: a rig stand-in must run code-server with the VM's credential.[^guest]

# Relationships

- Used by [ide-proxy](/services/ide-proxy.md) (every request), [ide-provision](/services/ide-provision.md) (secret at install, readiness) and the [ide router](/api/ide.md) (`reinstallRequired`).

[^guest]: backend/src/services/ide-guest-auth.service.ts
