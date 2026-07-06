import type { VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import * as pve from './proxmox.service.js';
import { syncVmNode, migrateVmToNode, startVm } from './vm.service.js';
import { getConfig } from './config.service.js';
import { recordAudit } from './audit.service.js';

/** A passthrough-request error carrying an HTTP status the route can surface. */
export class PassthroughRequestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// v1 attaches a single device at hostpci0. Detach takes an explicit index so a
// future multi-device flow needs no signature change.
const HOSTPCI_INDEX = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a VM until it reports stopped. Returns false if the timeout elapses. */
async function waitStopped(
  node: string,
  vmid: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  timeoutMs = 120_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      if ((await pve.getVmStatus(node, vmid, client, 'qemu')).status === 'stopped') return true;
    } catch {
      return true; // gone / unreadable — nothing to wait for
    }
  }
  return false;
}

/**
 * Create a pending passthrough request for a VM. QEMU-only, one pending per VM,
 * and not if a device is already attached. The route has already authorized the
 * caller's write access to `vm`.
 */
export async function createPassthroughRequest(
  userId: string,
  vm: VirtualMachine,
  reason?: string,
): Promise<void> {
  if (vm.type === 'lxc') {
    throw new PassthroughRequestError('PCI passthrough is only available for VMs, not containers.', 400);
  }
  if (vm.hasPassthrough) {
    throw new PassthroughRequestError('This VM already has a PCI device attached.', 409);
  }
  const existing = await prisma.passthroughRequest.findFirst({ where: { vmId: vm.id, status: 'pending' } });
  if (existing) {
    throw new PassthroughRequestError('There is already a pending passthrough request for this VM.', 409);
  }
  await prisma.passthroughRequest.create({
    data: { userId, vmId: vm.id, reason: reason?.trim() || null },
  });
}

/** The caller's own passthrough requests, newest first (with VM name). */
export function listMyPassthroughRequests(userId: string) {
  return prisma.passthroughRequest.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { vm: { select: { id: true, name: true } } },
  });
}

export interface PendingPassthroughRequest {
  id: string;
  reason: string | null;
  createdAt: string;
  user: { id: string; email: string; displayName: string };
  vm: { id: string; name: string; node: string; vmid: number };
  // Background-apply progress (null until an approval is started).
  applyState: string | null; // queued | stopping | migrating | attaching | failed
  applyError: string | null;
  targetNode: string | null;
  mapping: string | null;
  /** Best-effort q35/OVMF/EFI readiness warnings (empty when unreadable). */
  bootWarnings: string[];
}

/** Pending requests + VM + requester + apply progress (admin review queue). */
export async function listPendingPassthroughRequests(): Promise<PendingPassthroughRequest[]> {
  const rows = await prisma.passthroughRequest.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    include: {
      user: { select: { id: true, email: true, displayName: true } },
      vm: { select: { id: true, name: true, proxmoxNode: true, proxmoxVmId: true } },
    },
  });
  if (rows.length === 0) return [];

  // Best-effort boot-readiness per VM so the admin sees q35/OVMF warnings
  // BEFORE approving. Never blocks the queue if a config read fails.
  let client: Awaited<ReturnType<typeof pve.getClient>> | null = null;
  try {
    client = await pve.getClient();
  } catch {
    /* Proxmox unreachable — list without warnings */
  }
  const warnings = await Promise.all(
    rows.map(async (r) => {
      if (!client) return [];
      try {
        const cfg = await pve.getVmConfig(r.vm.proxmoxNode, r.vm.proxmoxVmId, client, 'qemu');
        return pve.passthroughBootReadiness(cfg).warnings;
      } catch {
        return [];
      }
    }),
  );

  return rows.map((r, i) => ({
    id: r.id,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    user: { id: r.user.id, email: r.user.email, displayName: r.user.displayName },
    vm: { id: r.vm.id, name: r.vm.name, node: r.vm.proxmoxNode, vmid: r.vm.proxmoxVmId },
    applyState: r.applyState,
    applyError: r.applyError,
    targetNode: r.targetNode,
    mapping: r.mapping,
    bootWarnings: warnings[i]!,
  }));
}

/** How the apply will (or did) place the VM relative to the device's node. */
export interface PassthroughPlan {
  targetNode: string;
  willMigrate: boolean;
  /** Set when the VM's disks must be relocated onto this storage on the target. */
  targetstorage?: string;
  bootWarnings: string[];
}

const IN_FLIGHT = new Set(['queued', 'stopping', 'migrating', 'attaching']);

/**
 * Resolve where the VM must run for `mapping` to work, and how to get it there.
 * Proxmox PCI mappings are node-scoped: the VM can only start on a node that
 * has a device entry for the mapping. Already on one → no migration. On the
 * wrong node → plan an offline migration, relocating disks when the target
 * lacks the VM's storage (targetstorage). Throws PassthroughRequestError with
 * an actionable message when no placement can work.
 */
async function planPassthroughPlacement(
  vm: VirtualMachine,
  mapping: pve.PciMapping,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  opts: { running: boolean },
): Promise<PassthroughPlan> {
  if (mapping.nodes.length === 0) {
    throw new PassthroughRequestError(
      `Mapping "${mapping.id}" has no per-node device entries — add the device to the mapping in Proxmox (Datacenter → Resource Mappings).`,
      400,
    );
  }
  const online = new Set((await pve.getNodes(client)).filter((n) => n.status === 'online').map((n) => n.node));
  const candidates = mapping.nodes.filter((n) => online.has(n));
  if (candidates.length === 0) {
    throw new PassthroughRequestError(
      `Every node hosting "${mapping.id}" (${mapping.nodes.join(', ')}) is currently offline.`,
      409,
    );
  }

  // Boot readiness is informational (never a hard block, never auto-rewritten):
  // flipping an installed guest to OVMF/q35 can break its boot — worse than a
  // device that needs manual host attention.
  const config = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, client, 'qemu');
  const readiness = pve.passthroughBootReadiness(config);

  // Already on a node that has the device → nothing to move.
  if (candidates.includes(vm.proxmoxNode)) {
    return { targetNode: vm.proxmoxNode, willMigrate: false, bootWarnings: readiness.warnings };
  }

  // Pick the best target among the device's nodes (capacity-scored, arch-aware).
  const arch = (await pve.getNodeArchMap(client)).get(vm.proxmoxNode);
  const targetNode =
    candidates.length === 1
      ? candidates[0]!
      : await pve.pickBestNode(
          { cpu: vm.cpu, ramMb: vm.ram, storageGb: vm.storage },
          (await getConfig('default_storage')) ?? undefined,
          client,
          candidates,
          arch && arch !== 'unknown' ? arch : undefined,
        );

  // Disk placement: if any of the VM's volumes live on storage the target node
  // doesn't have, the offline migration must relocate them (targetstorage).
  const volumeStorages = pve.getVolumeStorages(config);
  const targetStorages = await pve.getNodeImagesStorages(targetNode, client);
  const available = new Set(targetStorages.map((s) => s.storage));
  const missing = volumeStorages.filter((s) => !available.has(s));

  let targetstorage: string | undefined;
  if (missing.length > 0) {
    if (targetStorages.length === 0) {
      throw new PassthroughRequestError(
        `Node ${targetNode} has no storage that can hold disk images — the VM's disks (on ${missing.join(', ')}) can't be relocated there.`,
        409,
      );
    }
    // Live migration mirrors disks over NBD (any storage type works). OFFLINE
    // migration needs a common export/import format between the source and
    // target storage TYPES (e.g. zfspool → nfs is impossible offline), so for a
    // stopped guest prefer a same-type storage on the target first.
    const bySpace = (list: pve.NodeImagesStorage[]) =>
      [...list].sort((a, b) => (b.availBytes ?? -1) - (a.availBytes ?? -1));
    let compatible = targetStorages;
    if (!opts.running) {
      const typeByName = new Map((await pve.getStorages(client)).map((s) => [s.storage, s.type]));
      const sourceTypes = new Set(missing.map((s) => typeByName.get(s)).filter(Boolean));
      const sameType = targetStorages.filter((s) => sourceTypes.has(s.type));
      if (sameType.length > 0) compatible = sameType;
      // No same-type storage on the target: attempt the best available anyway —
      // some type pairs do share a format — but the error, if Proxmox refuses,
      // is surfaced verbatim to the admin (start the VM to move it live, or add
      // a compatible storage).
    }
    const defaultStorage = await getConfig('default_storage');
    const preferred = defaultStorage ? compatible.find((s) => s.storage === defaultStorage) : undefined;
    const pick = preferred ?? bySpace(compatible)[0]!;
    const needBytes = vm.storage * 1024 ** 3;
    if (pick.availBytes !== null && pick.availBytes < needBytes) {
      throw new PassthroughRequestError(
        `Storage "${pick.storage}" on ${targetNode} has ~${Math.floor(pick.availBytes / 1024 ** 3)} GB free, but the VM needs ${vm.storage} GB. Free up space or add storage on ${targetNode}.`,
        409,
      );
    }
    targetstorage = pick.storage;
  }

  return { targetNode, willMigrate: true, targetstorage, bootWarnings: readiness.warnings };
}

/**
 * Phase 1 of approval (synchronous): validate the request + mapping, compute
 * the placement plan, and mark the request queued. The route then fires
 * `applyPassthroughApproval` in the background (a stop + offline migration with
 * disk relocation can take many minutes — far past edge-proxy timeouts) and
 * returns 202 with the plan so the admin sees what's about to happen.
 */
export async function beginPassthroughApproval(
  id: string,
  mapping: string,
): Promise<PassthroughPlan & { vmName: string; sourceNode: string }> {
  const row = await prisma.passthroughRequest.findUnique({ where: { id }, include: { vm: true } });
  if (!row) throw new PassthroughRequestError('Request not found', 404);
  if (row.status !== 'pending') throw new PassthroughRequestError('This request was already resolved.', 409);
  if (row.applyState && IN_FLIGHT.has(row.applyState)) {
    throw new PassthroughRequestError('This approval is already being applied.', 409);
  }
  if (row.vm.type !== 'qemu') throw new PassthroughRequestError('PCI passthrough is only available for VMs.', 400);

  const client = await pve.getClient();
  const map = (await pve.listPciMappings(client)).find((m) => m.id === mapping);
  if (!map) {
    throw new PassthroughRequestError(`No PCI mapping named "${mapping}" exists on the cluster.`, 400);
  }

  const vm = await syncVmNode(row.vm);
  let running = false;
  try {
    running = (await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, client, 'qemu')).status !== 'stopped';
  } catch {
    /* status unknown — plan as stopped (stricter storage rules) */
  }
  const plan = await planPassthroughPlacement(vm, map, client, { running });

  await prisma.passthroughRequest.update({
    where: { id },
    data: { mapping, targetNode: plan.targetNode, applyState: 'queued', applyError: null },
  });
  return { ...plan, vmName: vm.name, sourceNode: vm.proxmoxNode };
}

/**
 * Phase 2 (background worker): migrate (if needed) → stop → attach → resolve →
 * restart. Progress is persisted on the request row (`applyState`) for the UI.
 *
 * Migration comes FIRST, and is LIVE for a running guest: the device isn't
 * attached yet, so nothing pins the VM, and live migration mirrors disks over
 * NBD — which works across storage types (offline can't, e.g. zfspool → nfs)
 * and shrinks the downtime to just the stop-attach-start window at the end. A
 * guest that's already stopped migrates offline (same-type storage preferred
 * by the planner for format compatibility).
 *
 * Rollback rules — the VM must never be left broken:
 *  - fail during a live migrate → the guest keeps RUNNING on the source node
 *    (Proxmox aborts leave the source intact); nothing to undo.
 *  - fail during an offline migrate → the guest stays intact on the source.
 *  - fail at attach (after a migrate) → the guest stays on the target WITHOUT
 *    the device (fully bootable); restarted if we stopped it; the request stays
 *    pending+failed so a retry (which no-ops the migration) is one click.
 *  - `hasPassthrough` is only ever set after a successful attach.
 */
export async function applyPassthroughApproval(id: string, adminId: string): Promise<void> {
  const setState = (data: Record<string, unknown>) =>
    prisma.passthroughRequest.update({ where: { id }, data });

  const row = await prisma.passthroughRequest.findUnique({ where: { id }, include: { user: true, vm: true } });
  if (!row || row.status !== 'pending' || row.applyState !== 'queued' || !row.mapping || !row.targetNode) return;
  const admin = await prisma.user.findUnique({ where: { id: adminId } });
  const actor = { id: adminId, email: admin?.email ?? null };
  const mapping = row.mapping;

  let vm = await syncVmNode(row.vm);
  const sourceNode = vm.proxmoxNode;
  let wasRunning = false;
  let stoppedByUs = false;
  let migrated = false;
  // Generated cloud-init drives can't be storage-migrated across storage TYPES
  // (not even live — Proxmox copies them via storage_migrate, not NBD). Their
  // content is derived from config keys, so we drop them before the move and
  // regenerate them on the target storage while the guest is stopped to attach.
  let ciDropped: pve.CloudInitDrive[] = [];
  let ciRestored = false;
  let ciTargetStorage: string | undefined;

  const client = await pve.getClient();

  const stopAndWait = async (): Promise<void> => {
    await pve.stopVm(vm.proxmoxNode, vm.proxmoxVmId, client, 'qemu');
    if (!(await waitStopped(vm.proxmoxNode, vm.proxmoxVmId, client))) {
      throw new PassthroughRequestError(`"${vm.name}" did not stop within 2 minutes — try again once it's down.`, 409);
    }
    stoppedByUs = true;
    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });
  };

  try {
    try {
      const st = await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, client, 'qemu');
      wasRunning = st.status !== 'stopped';
    } catch {
      /* status unknown — treat as stopped; later steps surface real problems */
    }

    // ── Migrate to the device's node (live while running / offline if not) ──
    if (row.targetNode !== vm.proxmoxNode) {
      await setState({ applyState: 'migrating' });
      // Re-resolve the plan against live state (it may have changed between
      // begin and now); cheap compared to the migration itself.
      const map = (await pve.listPciMappings(client)).find((m) => m.id === mapping);
      if (!map) throw new PassthroughRequestError(`Mapping "${mapping}" no longer exists.`, 409);
      const plan = await planPassthroughPlacement(vm, map, client, { running: wasRunning });
      if (plan.willMigrate) {
        // Cloud-init drives whose storage the target doesn't have must be
        // dropped pre-move (regenerated after). Removing a cdrom-slot drive
        // needs the guest stopped, so a running guest gets a brief bounce —
        // the long disk copy still happens live afterwards.
        if (plan.targetstorage) {
          const cfg = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, client, 'qemu');
          const targetAvail = new Set((await pve.getNodeImagesStorages(plan.targetNode, client)).map((s) => s.storage));
          const toDrop = pve.getCloudInitDrives(cfg).filter((d) => !targetAvail.has(d.storage));
          if (toDrop.length > 0) {
            if (wasRunning) await stopAndWait();
            await pve.deleteVmConfigKeys(vm.proxmoxNode, vm.proxmoxVmId, toDrop.map((d) => d.slot), client);
            ciDropped = toDrop;
            ciTargetStorage = plan.targetstorage;
            // Persist so a startup reconciler can restore these if we're killed
            // (backend restart) before the regenerate step below.
            await setState({ ciDropped: JSON.stringify(toDrop.map((d) => ({ slot: d.slot, storage: d.storage }))) });
            if (wasRunning) {
              const upid = await pve.startVm(vm.proxmoxNode, vm.proxmoxVmId, client, 'qemu');
              await pve.waitForTask(vm.proxmoxNode, upid, client);
              stoppedByUs = false;
              await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
            }
          }
        }
        vm = await migrateVmToNode(vm, plan.targetNode, {
          offline: !wasRunning,
          targetstorage: plan.targetstorage,
          notifyOwner: true,
          actorId: adminId,
          // Relocating a large guest's disks (hundreds of GB over the wire)
          // can far exceed the default 30-min task wait — allow up to 6 hours.
          timeoutMs: 6 * 60 * 60 * 1000,
        });
        migrated = true;
        await setState({ targetNode: plan.targetNode });
      }
    }

    // ── Stop (hostpci can only be set on a stopped guest) ──
    if (wasRunning) {
      await setState({ applyState: 'stopping' });
      await stopAndWait();
    }

    // ── Regenerate dropped cloud-init drives on the target storage ──
    if (ciDropped.length > 0) {
      for (const d of ciDropped) {
        await pve.addCloudInitDrive(vm.proxmoxNode, vm.proxmoxVmId, d.slot, ciTargetStorage ?? d.storage, client);
      }
      ciRestored = true;
      await setState({ ciDropped: null }); // regenerated — no longer needs recovery
    }

    // ── Attach (pcie only on q35 — Proxmox refuses to start i440fx + pcie=1) ──
    await setState({ applyState: 'attaching' });
    const config = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, client, 'qemu');
    const readiness = pve.passthroughBootReadiness(config);
    await pve.attachPci(vm.proxmoxNode, vm.proxmoxVmId, HOSTPCI_INDEX, mapping, client, { pcie: readiness.q35 });

    await prisma.$transaction([
      prisma.virtualMachine.update({ where: { id: vm.id }, data: { hasPassthrough: true } }),
      prisma.passthroughRequest.update({
        where: { id },
        data: { status: 'approved', applyState: 'done', resolvedAt: new Date(), resolvedById: adminId },
      }),
    ]);

    // ── Restart if we took it down (best-effort: a start failure here is a
    // host-side passthrough problem — device attached, admin investigates) ──
    let startNote = '';
    if (wasRunning) {
      try {
        await startVm(vm);
      } catch (err) {
        startNote = ` Start failed after attach: ${pve.pveMessage(err)} — check host IOMMU/VFIO and the device on ${vm.proxmoxNode}.`;
        await setState({ applyError: startNote.trim() });
      }
    }

    await recordAudit({
      action: 'passthrough.approve',
      actor,
      targetType: 'vm',
      targetId: vm.id,
      detail:
        `${vm.name} ← mapping ${mapping}` +
        (migrated ? ` (migrated ${sourceNode} → ${vm.proxmoxNode})` : '') +
        (readiness.warnings.length ? ` [warnings: ${readiness.warnings.length}]` : '') +
        startNote,
    });
  } catch (err) {
    let message = err instanceof PassthroughRequestError ? err.message : pve.pveMessage(err);
    if (/cannot migrate from storage type/i.test(message) && !wasRunning) {
      message += ' Tip: start the VM and approve again — live migration can move disks across storage types.';
    }
    await setState({ applyState: 'failed', applyError: message }).catch(() => undefined);
    // Put back any cloud-init drive we dropped (on the storage matching
    // wherever the guest now lives), so its next boot still gets its config.
    if (ciDropped.length > 0 && !ciRestored) {
      try {
        vm = await syncVmNode(vm);
        for (const d of ciDropped) {
          await pve.addCloudInitDrive(vm.proxmoxNode, vm.proxmoxVmId, d.slot, migrated ? (ciTargetStorage ?? d.storage) : d.storage, client);
        }
        await setState({ ciDropped: null }); // restored — reconciler needn't
      } catch {
        /* best-effort — leave ciDropped set so the startup reconciler retries */
      }
    }
    // Leave the VM usable: a failed LIVE migrate never stopped it, so only
    // restart when WE took it down (bounce/stop/attach failures).
    if (stoppedByUs) {
      try {
        vm = await syncVmNode(vm);
        await startVm(vm);
      } catch {
        /* it stays stopped — the admin sees the failure reason either way */
      }
    }
    await recordAudit({
      action: 'passthrough.apply_failed',
      actor,
      targetType: 'vm',
      targetId: vm.id,
      detail: `${vm.name} ← mapping ${mapping}: ${message}`,
    });
  }
}

/**
 * Startup recovery. A passthrough apply runs in the background, and a large disk
 * relocation can take hours — longer than a ProxMate deploy. If the backend
 * restarts mid-apply the worker is gone, but the Proxmox migration may have
 * finished on its own, leaving the guest on the target with its cloud-init drive
 * dropped and the DB node stale. Runs once at boot: for every apply left in
 * flight, re-sync the true node, restore any dropped cloud-init drive (on the
 * storage the guest now uses), and mark the request failed-retryable so the
 * admin gets a clear "review and approve again". We never auto-resume — guessing
 * the exact interrupted step is unsafe. Best-effort; never throws.
 */
export async function reconcileInterruptedPassthroughApplies(): Promise<number> {
  let rows: Array<{ id: string; vmId: string; ciDropped: string | null }>;
  try {
    rows = await prisma.passthroughRequest.findMany({
      where: { status: 'pending', applyState: { in: [...IN_FLIGHT] } },
      select: { id: true, vmId: true, ciDropped: true },
    });
  } catch {
    return 0; // DB not ready — never block boot
  }

  let recovered = 0;
  for (const row of rows) {
    try {
      const dbVm = await prisma.virtualMachine.findUnique({ where: { id: row.vmId } });
      // Correct the DB node in case a migration completed after the worker died.
      const vm = dbVm ? await syncVmNode(dbVm) : null;

      if (row.ciDropped && vm) {
        const drives = JSON.parse(row.ciDropped) as Array<{ slot: string; storage: string }>;
        const client = await pve.getClient();
        const cfg = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, client, 'qemu');
        // Regenerate on whatever storage the guest's disks now live on (source
        // or target, wherever it ended up); fall back to the recorded storage.
        const diskStorage = pve.getVolumeStorages(cfg)[0];
        const present = new Set(pve.getCloudInitDrives(cfg).map((d) => d.slot));
        for (const d of drives) {
          if (!present.has(d.slot)) {
            await pve.addCloudInitDrive(vm.proxmoxNode, vm.proxmoxVmId, d.slot, diskStorage ?? d.storage, client);
          }
        }
      }

      await prisma.passthroughRequest.update({
        where: { id: row.id },
        data: {
          applyState: 'failed',
          applyError:
            'Interrupted by a ProxMate restart while applying. The VM was left safe — review it and approve again.',
          ciDropped: null,
        },
      });
      await recordAudit({
        action: 'passthrough.apply_interrupted',
        targetType: 'vm',
        targetId: row.vmId,
        detail: 'recovered on startup',
      }).catch(() => undefined);
      recovered += 1;
    } catch (err) {
      console.error(`[passthrough] startup reconcile of ${row.id} failed:`, err);
    }
  }
  if (recovered > 0) console.log(`[passthrough] recovered ${recovered} interrupted apply(s) on startup`);
  return recovered;
}

/** Deny: mark resolved without touching the VM. */
export async function denyPassthroughRequest(
  id: string,
  adminId: string,
): Promise<{ email: string; vmName: string }> {
  const row = await prisma.passthroughRequest.findUnique({ where: { id }, include: { user: true, vm: true } });
  if (!row) throw new PassthroughRequestError('Request not found', 404);
  if (row.status !== 'pending') throw new PassthroughRequestError('This request was already resolved.', 409);
  if (row.applyState && IN_FLIGHT.has(row.applyState)) {
    throw new PassthroughRequestError('An approval is currently being applied to this request.', 409);
  }
  await prisma.passthroughRequest.update({
    where: { id },
    data: { status: 'denied', resolvedAt: new Date(), resolvedById: adminId },
  });
  return { email: row.user.email, vmName: row.vm.name };
}

/**
 * Admin: detach a PCI device (`hostpci{index}`) from a VM. Stops it first if
 * running (Proxmox needs the guest stopped), then recomputes `hasPassthrough`
 * from the live config so the balancer/drain skip only while a device remains.
 */
export async function detachPassthrough(vm: VirtualMachine, index: number): Promise<void> {
  if (vm.type !== 'qemu') throw new PassthroughRequestError('PCI passthrough is only available for VMs.', 400);
  const client = await pve.getClient();
  const current = await syncVmNode(vm);

  try {
    const st = await pve.getVmStatus(current.proxmoxNode, current.proxmoxVmId, client, 'qemu');
    if (st.status !== 'stopped') {
      await pve.stopVm(current.proxmoxNode, current.proxmoxVmId, client, 'qemu');
      await waitStopped(current.proxmoxNode, current.proxmoxVmId, client);
      await prisma.virtualMachine.update({ where: { id: current.id }, data: { status: 'stopped' } });
    }
  } catch {
    /* status unknown — proceed to detach */
  }

  await pve.detachPci(current.proxmoxNode, current.proxmoxVmId, index, client);

  const cfg = await pve.getVmConfig(current.proxmoxNode, current.proxmoxVmId, client, 'qemu');
  const remaining = pve.getPassthroughDevices(cfg).length;
  await prisma.virtualMachine.update({ where: { id: current.id }, data: { hasPassthrough: remaining > 0 } });
}
