import type { MateState, VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getConfig, setConfig } from './config.service.js';
import * as pve from './proxmox.service.js';

/** Rolling retention: only this many MateStates are kept per VM. */
export const MATESTATE_RETENTION = 2;

/**
 * Pick a backup-capable storage on the cluster. Preference order:
 *   1) the `backup_storage` SystemConfig key, if set
 *   2) the first storage whose content includes "backup"
 * Caches the chosen value into SystemConfig on first use.
 */
export async function getBackupStorage(): Promise<string> {
  const stored = await getConfig('backup_storage');
  if (stored) return stored;

  const all = await pve.getStorages();
  const candidate = all.find((s) => s.content?.includes('backup'));
  if (!candidate) {
    throw new Error('No backup-capable storage found on the cluster. Add one in Proxmox (Datacenter → Storage → enable "VZDump backup file" content).');
  }
  await setConfig('backup_storage', candidate.storage);
  return candidate.storage;
}

/** All MateStates for a VM, newest first. */
export function listForVm(vmId: string): Promise<MateState[]> {
  return prisma.mateState.findMany({ where: { vmId }, orderBy: { createdAt: 'desc' } });
}

/**
 * Prune older MateStates so only the N most recent `ready` ones remain.
 * Deletes both the DB rows and the underlying Proxmox backup files.
 * Errors during file deletion are logged but do not block the prune
 * (a stale DB row is worse UX than a missing remote file).
 */
export async function pruneOldMateStates(vmId: string, keep = MATESTATE_RETENTION): Promise<void> {
  const ready = await prisma.mateState.findMany({
    where: { vmId, status: 'ready' },
    orderBy: { createdAt: 'desc' },
  });
  const toPrune = ready.slice(keep);
  for (const ms of toPrune) {
    try {
      await pve.deleteBackup(ms.proxmoxNode, ms.storage, ms.volid);
    } catch (err) {
      console.warn(`[matestate] Failed to delete backup ${ms.volid}: ${pve.pveMessage(err)}`);
    }
    await prisma.mateState.delete({ where: { id: ms.id } });
  }
}

/**
 * Take a backup of the given VM, wait for Proxmox to finish, record the
 * resulting volid in the DB, then enforce rolling retention.
 *
 * Returns the new MateState row in `ready` status.
 */
export async function createMateState(
  vm: VirtualMachine,
  kind: 'scheduled' | 'manual' = 'manual',
): Promise<MateState> {
  const client = await pve.getClient();
  const storage = await getBackupStorage();

  // Snapshot the set of existing backups for this VM so we can identify the new one.
  const before = new Set((await pve.listBackups(storage, client))
    .filter((b) => b.vmid === vm.proxmoxVmId)
    .map((b) => b.volid));

  // Provisional row so the UI can show "creating" immediately.
  const placeholder = await prisma.mateState.create({
    data: {
      vmId: vm.id,
      proxmoxVmId: vm.proxmoxVmId,
      proxmoxNode: vm.proxmoxNode,
      storage,
      volid: `pending:${vm.proxmoxVmId}:${Date.now()}`,
      size: 0,
      status: 'creating',
      kind,
    },
  });

  try {
    const upid = await pve.startBackup(
      { node: vm.proxmoxNode, vmid: vm.proxmoxVmId, storage, mode: 'snapshot' },
      client,
    );
    // vzdump can take a while on real workloads — give it up to 30 minutes.
    await pve.waitForTask(vm.proxmoxNode, upid, client, 30 * 60 * 1000);

    // Find the volume that wasn't there before.
    const after = (await pve.listBackups(storage, client)).filter((b) => b.vmid === vm.proxmoxVmId);
    const fresh = after.find((b) => !before.has(b.volid));
    if (!fresh) throw new Error('Backup finished but no new volume was found on Proxmox.');

    const updated = await prisma.mateState.update({
      where: { id: placeholder.id },
      data: { volid: fresh.volid, size: fresh.size, status: 'ready' },
    });

    await pruneOldMateStates(vm.id);
    return updated;
  } catch (err) {
    await prisma.mateState.update({ where: { id: placeholder.id }, data: { status: 'error' } });
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Restore a VM from one of its MateStates. Stops the VM (if running), waits
 * for it to be stopped, and runs a Proxmox restore-in-place (force=1) into
 * the SAME VMID — so the VM's identity, NIC, and isolation stay intact.
 */
export async function restoreFromMateState(vm: VirtualMachine, mateState: MateState): Promise<void> {
  if (mateState.vmId !== vm.id) throw new Error('MateState does not belong to this VM');
  if (mateState.status !== 'ready') throw new Error('MateState is not ready');

  const client = await pve.getClient();

  // Stop first if running — Proxmox refuses to restore over a running VM, and
  // stop is async (same pattern as destroyVm).
  try {
    const status = await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, client);
    if (status.status !== 'stopped') {
      await pve.stopVm(vm.proxmoxNode, vm.proxmoxVmId, client);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await sleep(1000);
        try {
          if ((await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, client)).status === 'stopped') break;
        } catch {
          break;
        }
      }
    }
  } catch {
    /* status unknown — try anyway */
  }

  await prisma.mateState.update({ where: { id: mateState.id }, data: { status: 'restoring' } });
  try {
    const upid = await pve.restoreBackup(
      { node: vm.proxmoxNode, vmid: vm.proxmoxVmId, volid: mateState.volid },
      client,
    );
    await pve.waitForTask(vm.proxmoxNode, upid, client, 30 * 60 * 1000);
    await prisma.mateState.update({ where: { id: mateState.id }, data: { status: 'ready' } });
    // Restore creates a fresh config; re-assert tenant isolation on the NIC.
    const isolate = (await getConfig('isolation_enabled')) !== 'false';
    if (isolate) {
      try {
        await pve.ensureNicFirewall(vm.proxmoxNode, vm.proxmoxVmId, client);
      } catch {
        /* not fatal */
      }
    }
    await pve.startVm(vm.proxmoxNode, vm.proxmoxVmId, client);
  } catch (err) {
    await prisma.mateState.update({ where: { id: mateState.id }, data: { status: 'ready' } });
    throw err;
  }
}

/** Manually delete one MateState (DB + Proxmox file). */
export async function deleteMateState(mateState: MateState): Promise<void> {
  try {
    await pve.deleteBackup(mateState.proxmoxNode, mateState.storage, mateState.volid);
  } catch (err) {
    const msg = pve.pveMessage(err);
    // If the file is already gone, still drop the DB row.
    if (!/not exist|not found/i.test(msg)) throw err;
  }
  await prisma.mateState.delete({ where: { id: mateState.id } });
}

/** Run a scheduled-backup tick: back up every VM, oldest-touched first. */
export async function runScheduledBackups(): Promise<{ ran: number; failed: number }> {
  const vms = await prisma.virtualMachine.findMany({ where: { status: { not: 'creating' } } });
  let ran = 0;
  let failed = 0;
  for (const vm of vms) {
    try {
      await createMateState(vm, 'scheduled');
      ran++;
    } catch (err) {
      console.error(`[matestate] scheduled backup failed for VM ${vm.proxmoxVmId}:`, err);
      failed++;
    }
  }
  return { ran, failed };
}
