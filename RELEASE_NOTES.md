## Highlights

**GPU / PCI passthrough now moves the VM to the device automatically.** Proxmox PCI
mappings are node-scoped — a passed-through GPU only works on the physical node it lives
on. Previously ProxMate would attach the device wherever the VM happened to be, so on a
multi-node cluster the VM failed to start with `PCI device mapping not found`. Approving a
passthrough now **relocates the VM to the node that hosts the approved device** first — live
for a running guest, with full disk relocation when needed — so it actually boots with the
GPU.

## Features

- **Automatic placement on approve.** When an admin approves a GPU/PCI passthrough, ProxMate
  resolves the device's node from the Proxmox resource mapping and, if the VM isn't already
  there, migrates it. If the mapping spans several nodes, the best-fit one is chosen
  (capacity-scored, architecture-aware — the same scheduler used for new VMs).
- **Live migration with cross-storage disk relocation.** A running guest migrates **live**
  (no downtime during the disk copy) even when its disk sits on node-local storage the target
  doesn't have — disks are mirrored to a storage available on the destination. Stopped guests
  migrate offline, preferring a format-compatible storage. Generated cloud-init drives (which
  Proxmox can't move across storage types) are transparently dropped and regenerated on the
  target.
- **Background apply with live progress.** The stop → migrate → attach → restart sequence can
  take minutes to hours for a large disk, so approval runs in the background: the admin review
  card shows the live state (migrating / attaching), a pre-approval preview of the move
  ("will migrate pve → pve-4"), boot-readiness warnings, and — on failure — the reason with a
  one-click **Retry**.
- **Conservative boot handling.** GPU passthrough usually wants `q35` + OVMF; ProxMate
  **surfaces these as warnings rather than rewriting an installed guest's firmware** (that can
  break its boot). PCIe is only requested on q35 machines, so attaching to an i440fx guest no
  longer fails at start.
- **Restart-safe.** A new startup reconciler recovers any approval that was mid-migration when
  the backend last stopped (a long disk copy can outlast a deploy): it re-syncs the VM's node,
  restores any dropped cloud-init drive, and marks the request failed-retryable so nothing is
  left half-applied.
- Every step is audited (`passthrough.approve_started` / `approve` / `apply_failed` /
  `apply_interrupted`), and the VM owner gets the standard maintenance-email heads-up when a
  running VM is moved.

## Upgrade notes

- **Two database migrations** (`add_passthrough_apply_state`, `add_passthrough_ci_dropped`),
  applied automatically on deploy. No new environment variables; no configuration changes.
- **Behavior change:** approving a passthrough for a VM that isn't on the device's node now
  **migrates the VM** (previously it attached in place and the VM couldn't start). Migration
  requires a storage on the target node that can hold the VM's disks; ProxMate reports a clear
  error if none is available.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## Verification

- Backend suite green: **425 tests** (target-node resolution, cross-type storage relocation,
  cloud-init drop/regenerate ordering, live-vs-offline selection, pcie-only-on-q35, boot
  readiness, the background worker's rollback rules, and startup reconciliation). Typecheck +
  lint clean on backend and frontend; frontend production build green.
- **Live-verified on a real 3-node cluster:** a running VM on node-local ZFS was
  live-migrated to the GPU's node with its 8 GB disk relocated across storage types
  (`zfspool → nfs`), its cloud-init drive regenerated on the target, the GPU attached, and the
  guest restarted — running on the device's node with the mapping bound. The startup
  reconciler was verified to restore a simulated restart-interrupted apply.
- Host VFIO/IOMMU setup and defining the Proxmox PCI resource mapping remain the admin's job
  (not doable over the API); ProxMate surfaces host-side start failures with a clear pointer.
