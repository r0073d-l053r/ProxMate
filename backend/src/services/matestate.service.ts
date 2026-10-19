import type { MateState, VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getConfig, setConfig } from './config.service.js';
import { cronMatches } from './power-schedule.service.js';
import { notify } from './notify.service.js';
import * as pve from './proxmox.service.js';
import {
  requireOurGuest,
  markClonedGuest,
  approvedPciLines,
  assertRestoreWithinQuota,
  syncRestoredGuest,
} from './vm.service.js';
import { parseGuestConfigText } from '../lib/guest-config.js';

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
 * Shape a MateState for a JSON API response. `size` is a `BigInt` in the DB
 * (backups routinely exceed Int32's ~2.1 GB), and `JSON.stringify` throws on
 * BigInt — so convert it to a Number (byte counts stay well under
 * Number.MAX_SAFE_INTEGER). Without this the whole matestates response 500s.
 */
export function serializeMateState(ms: MateState): Omit<MateState, 'size'> & { size: number } {
  return { ...ms, size: Number(ms.size) };
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
  // Never back up a guest that isn't this row's into this row's backup list.
  vm = await requireOurGuest(vm, { client });
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
      size: BigInt(0),
      status: 'creating',
      kind,
    },
  });

  let upid: string | undefined;
  try {
    upid = await pve.startBackup(
      { node: vm.proxmoxNode, vmid: vm.proxmoxVmId, storage, mode: 'snapshot' },
      client,
    );
    // vzdump can take a while on real workloads — give it up to 30 minutes.
    await pve.waitForTask(vm.proxmoxNode, upid, client, 30 * 60 * 1000);

    // Record the volume this task wrote, as its own log names it. Any backup file
    // for this VMID that merely appeared meanwhile (an uploaded archive can carry
    // any VMID in its name) is not evidence of what this run produced. Only when
    // the log names nothing is a lone new volume accepted.
    const after = (await pve.listBackups(storage, client)).filter((b) => b.vmid === vm.proxmoxVmId);
    const logged = pve.backupVolidFromLog(
      await pve.getTaskLog(vm.proxmoxNode, upid, client).catch(() => [] as string[]),
      storage,
    );
    const added = after.filter((b) => !before.has(b.volid));
    const fresh = logged ? after.find((b) => b.volid === logged) : added.length === 1 ? added[0] : undefined;
    if (!fresh) throw new Error('Backup finished but its volume could not be identified on Proxmox.');

    const updated = await prisma.mateState.update({
      where: { id: placeholder.id },
      data: { volid: fresh.volid, size: BigInt(Math.trunc(fresh.size ?? 0)), status: 'ready' },
    });

    await pruneOldMateStates(vm.id, vm.backupKeep ?? MATESTATE_RETENTION);
    return updated;
  } catch (err) {
    await prisma.mateState.update({ where: { id: placeholder.id }, data: { status: 'error' } });
    if (upid && /timed out/i.test(pve.pveMessage(err))) {
      await abandonBackup(vm.proxmoxNode, upid, storage, client);
    }
    throw err;
  }
}

/**
 * Give up on a vzdump task we stopped waiting for. Left running, it would still
 * write an archive that no MateState row records — and retention only prunes
 * recorded ones, while vzdump's own pruning is off (`remove=0`) — so every slow
 * run would leave a full-size file behind until the backup storage filled up.
 * Stop the task, then delete whatever archive its log says it wrote. Best-effort.
 */
async function abandonBackup(
  node: string,
  upid: string,
  storage: string,
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<void> {
  try {
    await pve.stopTask(node, upid, client);
    await pve.waitForTask(node, upid, client, 60_000).catch(() => undefined);
  } catch (err) {
    console.warn(`[matestate] Failed to stop backup task ${upid}: ${pve.pveMessage(err)}`);
  }
  try {
    const volid = pve.backupVolidFromLog(await pve.getTaskLog(node, upid, client), storage);
    if (!volid) return;
    const present = (await pve.listBackups(storage, client)).find((b) => b.volid === volid);
    if (present) await pve.deleteBackup(present.node, storage, volid, client);
  } catch (err) {
    console.warn(`[matestate] Failed to remove the abandoned backup of task ${upid}: ${pve.pveMessage(err)}`);
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
  const kind: pve.GuestKind = vm.type === 'lxc' ? 'lxc' : 'qemu';
  // A restore overwrites the guest at this VMID — only ever this row's (or an empty slot).
  vm = await requireOurGuest(vm, { allowAbsent: true, client });

  // The archive brings back the guest's whole config as it was at backup time.
  // Refuse one that would grow the guest past its owner's quota, and note which PCI
  // devices are approved now (a device detached since the backup must not return).
  await assertRestoreWithinQuota(
    vm,
    parseGuestConfigText(await pve.extractBackupConfig(vm.proxmoxNode, mateState.volid, client)),
  );
  const approvedPci = await approvedPciLines(vm, client);

  // Stop first if running — Proxmox refuses to restore over a running guest, and
  // stop is async (same pattern as destroyVm).
  try {
    const status = await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, client, kind);
    if (status.status !== 'stopped') {
      await pve.stopVm(vm.proxmoxNode, vm.proxmoxVmId, client, kind);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await sleep(1000);
        try {
          if ((await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, client, kind)).status === 'stopped') break;
        } catch {
          break;
        }
      }
    }
  } catch {
    /* status unknown — try anyway */
  }

  // LXC restore must target a container-capable rootfs storage: the backup
  // storage (often a directory like `local`) usually can't hold a container
  // rootfs, so Proxmox 400s unless we pass one. Reuse the container's current
  // rootfs pool, falling back to the configured default. (QEMU reads the target
  // from the vzdump config, so it needs no explicit storage.)
  let restoreStorage: string | undefined;
  if (kind === 'lxc') {
    const cfg = await pve
      .getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, client, 'lxc')
      .catch(() => ({}) as Record<string, string>);
    restoreStorage = cfg.rootfs?.split(':')[0] || (await getConfig('default_storage')) || undefined;
  }

  await prisma.mateState.update({ where: { id: mateState.id }, data: { status: 'restoring' } });
  try {
    const upid = await pve.restoreBackup(
      { node: vm.proxmoxNode, vmid: vm.proxmoxVmId, volid: mateState.volid, storage: restoreStorage },
      client,
      kind,
    );
    await pve.waitForTask(vm.proxmoxNode, upid, client, 30 * 60 * 1000);
    // The archive's config replaces the guest's, tags included (a backup taken
    // before ownership tags existed has none) — tag it as this row's again.
    await markClonedGuest(vm, client);
    await prisma.mateState.update({ where: { id: mateState.id }, data: { status: 'ready' } });
    // Re-sync the row from the restored config (and strip unapproved PCI devices)
    // before anything can start the guest.
    vm = await syncRestoredGuest(vm, { approvedPci, client });
    // Restore creates a fresh config; re-assert tenant isolation on the NIC.
    const isolate = (await getConfig('isolation_enabled')) !== 'false';
    if (isolate) {
      try {
        await pve.ensureNicFirewall(vm.proxmoxNode, vm.proxmoxVmId, client, kind);
      } catch {
        /* not fatal */
      }
    }
    await pve.startVm(vm.proxmoxNode, vm.proxmoxVmId, client, kind);
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

/**
 * Cluster-wide weekly tick: back up every VM that does NOT have its own per-VM
 * schedule (those are handled by runDueBackups, so we never double-back-up).
 */
export async function runScheduledBackups(): Promise<{ ran: number; failed: number }> {
  const vms = await prisma.virtualMachine.findMany({
    where: { status: { not: 'creating' }, backupCron: null },
  });
  return backupEach(vms);
}

/** Whether a VM's own backup schedule fires at the given minute. */
export function isBackupDue(vm: Pick<VirtualMachine, 'backupCron'>, now: Date): boolean {
  return !!vm.backupCron && cronMatches(vm.backupCron, now);
}

/** Longest stretch of missed minutes a late per-VM backup tick still catches up. */
const MAX_CATCH_UP_MINUTES = 24 * 60;

/**
 * Whether a VM's own backup schedule fired at any minute after `since` up to and
 * including `now`'s minute (just `now`'s minute when `since` is omitted).
 */
export function isBackupDueSince(vm: Pick<VirtualMachine, 'backupCron'>, now: Date, since?: Date): boolean {
  if (!vm.backupCron) return false;
  const end = new Date(now);
  end.setSeconds(0, 0);
  const start = new Date(since ?? end);
  start.setSeconds(0, 0);
  if (since) start.setMinutes(start.getMinutes() + 1);
  const floor = end.getTime() - MAX_CATCH_UP_MINUTES * 60_000;
  if (start.getTime() < floor) start.setTime(floor);
  for (const d = start; d.getTime() <= end.getTime(); d.setMinutes(d.getMinutes() + 1)) {
    if (cronMatches(vm.backupCron, d)) return true;
  }
  return false;
}

/**
 * Per-minute tick for VMs with their own backup schedule: back up each one whose
 * `backupCron` fires this minute (retention honors its `backupKeep`). `since` is
 * the minute the previous tick covered: a tick that comes late because the one
 * before it was still busy backing up also takes the schedules that fired in
 * between, each VM once.
 */
export async function runDueBackups(now: Date = new Date(), since?: Date): Promise<{ ran: number; failed: number }> {
  const vms = await prisma.virtualMachine.findMany({
    where: { status: { not: 'creating' }, backupCron: { not: null } },
  });
  return backupEach(vms.filter((vm) => isBackupDueSince(vm, now, since)));
}

/** Back up a list of VMs sequentially, isolating per-VM failures. */
async function backupEach(vms: VirtualMachine[]): Promise<{ ran: number; failed: number }> {
  let ran = 0;
  let failed = 0;
  for (const vm of vms) {
    try {
      await createMateState(vm, 'scheduled');
      ran++;
    } catch (err) {
      console.error(`[matestate] scheduled backup failed for VM ${vm.proxmoxVmId}:`, err);
      failed++;
      await notify({
        event: 'backup.failed',
        title: vm.name,
        message: `Scheduled backup of "${vm.name}" (VMID ${vm.proxmoxVmId}) failed: ${pve.pveMessage(err)}`,
      }).catch(() => undefined);
    }
  }
  return { ran, failed };
}

/** Set (or clear, with nulls) a VM's per-VM backup schedule + retention. */
export async function setBackupPolicy(
  vm: VirtualMachine,
  data: { backupCron: string | null; backupKeep: number | null },
): Promise<VirtualMachine> {
  return prisma.virtualMachine.update({ where: { id: vm.id }, data });
}
