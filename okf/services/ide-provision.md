---
type: Backend Service
title: IDE-provision service (in-guest install and AVX relocate)
description: Installs pinned code-server and OpenCode natively into a tenant VM through the QEMU guest agent under an `installing` lock, and relocates VMs on non-AVX nodes to an AVX-capable node.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-provision.service.ts
tags: [proxmate, ide, provisioning, guest-agent]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: prov
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-provision.service.ts
    title: backend/src/services/ide-provision.service.ts
---

# Purpose

On first "Open IDE", ProxMate runs a self-contained bootstrap through the guest agent so the IDE truly is the VM (real users, hostname, services, opened at `/`). The VM is locked with `ideState='installing'` so nothing can console/stop/delete it mid-install. Re-running is idempotent (updates config, restarts the service).[^prov]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `IDE_CODE_SERVER_VERSION` / `IDE_OPENCODE_VERSION` | env override, defaults `4.128.0` / `1.17.18` | Pinned in-guest tool versions. |
| `ideStateOf` / `isIdeInstalling` | `(vm)` | `none/installing/ready/failed`; the latter gates destructive VM actions. |
| `startIdeProvision` | `(vm, user, publicApiBaseUrl) => 'installing'` | Guardrails (caller owns the VM, no install already running unless it timed out, QEMU, running, agent ping, RAM floor, AVX), managed pinhole, mints gateway token, renders `opencode.json`, generates a fresh guest secret, writes the bootstrap (base64) via `guestFileWrite`, runs it detached with `setsid`, then stores the encrypted secret and sets `ideState`. |
| `probeIdeReachability` | `(vm) => { ok, target, error? }` | Dials the same target the proxy uses (4 s); a timeout points at `ide_ingress_cidr` / pinhole. |
| `refreshIdeState` | `(vm)` | `installing` → `ready` when the guest proves the VM's secret (not merely answers), → `failed` after 10 min. |
| `planIdeRelocate` | `(vm) => targetNode` | Validates (QEMU, no passthrough, not busy, node confirmed no AVX) and picks a confirmed AVX-capable online node via `pickBestNode`. |
| `startIdeRelocate` | `(vm, actorId) => targetNode` | Background shutdown → offline `migrateVmToNode` → start; progress in an in-memory map. |
| `getIdeRelocateStatus` | `(vmId)` | `running/done/failed`; finished entries expire after 10 min. |
| `IdeProvisionError` | `(message, code?: 'reboot_required' \| 'node_no_avx' \| 'install_in_progress')` | Machine-readable refusal reasons for the UI. |

# Data

- [VirtualMachine](/database/virtual-machine.md): `ideState`, `ideStateAt`, `type`, `status`, `ram`, `ipAddress`, `hasPassthrough`, `deployState`.[^prov]
- SystemConfig `ide_min_ram_mb` (default 8192), `ide_ingress_cidr` — see [ide config](/config/ide.md).
- [IdeGuestSecret](/database/ide-guest-secret.md): the install's secret, encrypted, rotated on every (re)provision.
- In guest: `/etc/proxmate-ide.env` (`PROXMATE_IDE_TOKEN`, `HASHED_PASSWORD` = SHA-256 of the guest secret, umask 077), `/etc/systemd/system/proxmate-ide.service`, `/root/.config/opencode/opencode.json`, log `/var/log/pmide-provision.log`.
- Env `IDE_GUEST_PORT` (default 8080: code-server's bind port, the pinhole port and the probe port), `IDE_TARGET_OVERRIDE`.

# Gotchas

- Only the VM's owner may provision: the gateway token and model list written into the guest are the caller's, and the guest's root user can read them.[^prov]
- RAM floor: 4 GB OOMs and wedges the VM during install; 8 GB is the proven-safe default.[^prov]
- AVX: OpenCode's Bun runtime needs it. The service sets the VM CPU to `host` first; if the guest still lacks AVX it returns `reboot_required`, unless the node is known to lack AVX (`node_no_avx`) in which case only a relocate helps.[^prov]
- Without `ide_ingress_cidr` no pinhole is added and an isolated guest stays unreachable; this only logs a warning.[^prov]
- code-server runs as root with `--auth password` bound to `0.0.0.0:<IDE_GUEST_PORT>` (8080 by default). Only the backend holds the secret behind `HASHED_PASSWORD`, so only proxied requests authenticate; the isolation firewall pinhole additionally limits who can reach the port. code-server removes `HASHED_PASSWORD` from its environment at startup, so IDE terminals don't inherit it.[^prov]
- The bootstrap restarts `proxmate-ide.service` (not just enables it), so a reinstall replaces a running code-server and an install made before guest authentication gains its secret.[^prov]
- Relocation is deliberately OFFLINE: live-migrating a `cpu: host` guest between heterogeneous CPUs is unsafe. Targets must be CONFIRMED AVX-capable (fail-closed). Tenants never choose nodes.[^prov]
- Relocation status lives in process memory (single-process backend); a restart loses it.[^prov]
- The bootstrap is shipped base64 because raw non-ASCII/newlines break Proxmox's `agent/file-write` content parameter. It is decoded under `umask 077`, the encoded copy is removed once decoded, and the script deletes itself as soon as it starts, since it carries the gateway token and the guest credential hash.[^prov]

# Relationships

- Called by the [ide router](/api/ide.md), [vm router](/api/vm.md) and [admin router](/api/admin.md).
- Uses [proxmox service](/services/proxmox.md) (guest agent, `ensureIdePinhole`, `ensureHostCpu`, `getNodeAvxMap`, `migratableTargets`, `pickBestNode`, `shutdownVm`), [vm](/services/vm.md), [ide-gateway](/services/ide-gateway.md), [ide-guest-auth](/services/ide-guest-auth.md), [config](/services/config.md).
- Assets come from the generated `ide-assets.generated.ts` (built from the repo's `ide/` directory). The same lock pattern is used by [deploy-lock](/services/deploy-lock.md).

[^prov]: backend/src/services/ide-provision.service.ts
