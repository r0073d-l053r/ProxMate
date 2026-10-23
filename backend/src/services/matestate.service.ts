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
  reserveRestoreGrowth,
  releaseRestoreReservation,
  holdErroredRow,
  RESTORE_FAILED_MESSAGE,
  type RestoreReservation,
  syncRestoredGuest,
  assertOwnerAccessActive,
  assertOwnVolumes,
  FOREIGN_VOLUME_MESSAGE,
  PROVISION_FAILED_MESSAGE,
} from './vm.service.js';
import { parseGuestConfigText, pciLines, foreignVolumeKeys, hostLevelKeys } from '../lib/guest-config.js';
import { IDE_GUEST_PORT } from './ide-provision.service.js';
import { beginInFlight } from '../lib/in-flight.js';

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
  vm = await requireOurGuest(vm, { allowError: true, client });
  // A guest whose provisioning didn't finish, or that referenced another guest's
  // volumes, is not backed up: the archive would carry whatever it was left with,
  // and backups can be downloaded.
  if (vm.holdReason === FOREIGN_VOLUME_MESSAGE || vm.holdReason === PROVISION_FAILED_MESSAGE) {
    throw new Error(vm.holdReason);
  }
  const liveCfg = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, client, vm.type === 'lxc' ? 'lxc' : 'qemu');
  if (foreignVolumeKeys(liveCfg, vm.proxmoxVmId).length > 0) {
    throw new Error("This machine references disks that aren't its own, so it can't be backed up. Ask an admin to check it.");
  }
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
  const done = beginInFlight(placeholder.id);

  let upid: string | undefined;
  let unidentified = false;
  try {
    upid = await pve.startBackup(
      { node: vm.proxmoxNode, vmid: vm.proxmoxVmId, storage, mode: 'snapshot' },
      client,
    );
    // Kept so a restart mid-backup can still settle this row from the task.
    await recordMateStateTask(placeholder.id, upid);
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
    if (!fresh) {
      unidentified = true;
      throw new Error('Backup finished but its volume could not be identified on Proxmox.');
    }

    const updated = await prisma.mateState.update({
      where: { id: placeholder.id },
      data: { volid: fresh.volid, size: BigInt(Math.trunc(fresh.size ?? 0)), status: 'ready', upid: null },
    });

    await pruneOldMateStates(vm.id, vm.backupKeep ?? MATESTATE_RETENTION);
    return updated;
  } catch (err) {
    await prisma.mateState.update({ where: { id: placeholder.id }, data: { status: 'error' } });
    if (upid && /timed out/i.test(pve.pveMessage(err))) {
      await abandonBackup(vm.proxmoxNode, upid, storage, vm.proxmoxVmId, client);
    } else if (upid && unidentified) {
      // Nothing records this run's archive either — remove it the same way.
      await removeTaskArchive(vm.proxmoxNode, upid, storage, vm.proxmoxVmId, client);
    }
    throw err;
  } finally {
    done();
  }
}

/** Best-effort: note the Proxmox task now driving a MateState row (backup or restore). */
async function recordMateStateTask(id: string, upid: string): Promise<void> {
  await (async () => prisma.mateState.update({ where: { id }, data: { upid } }))().catch(() => undefined);
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
  vmid: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<void> {
  try {
    await pve.stopTask(node, upid, client);
    await pve.waitForTask(node, upid, client, 60_000).catch(() => undefined);
  } catch (err) {
    console.warn(`[matestate] Failed to stop backup task ${upid}: ${pve.pveMessage(err)}`);
  }
  await removeTaskArchive(node, upid, storage, vmid, client);
}

/**
 * Delete the archive a vzdump task's log names — only when it is listed on the
 * backup storage as this guest's (same VMID), so nothing else is ever removed.
 * Best-effort.
 */
async function removeTaskArchive(
  node: string,
  upid: string,
  storage: string,
  vmid: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<void> {
  try {
    const volid = pve.backupVolidFromLog(await pve.getTaskLog(node, upid, client), storage);
    if (!volid) return;
    const present = (await pve.listBackups(storage, client)).find((b) => b.volid === volid && b.vmid === vmid);
    if (present) await pve.deleteBackup(present.node, storage, volid, client);
  } catch (err) {
    console.warn(`[matestate] Failed to remove the archive of backup task ${upid}: ${pve.pveMessage(err)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Put a restored guest back on the network placement and isolation it has NOW.
 * An in-place restore (and a rollback) brings back the NIC line — bridge, VLAN
 * tag — and the firewall as they were when the backup or snapshot was taken, so
 * a bridge, VLAN or rule change made since would otherwise be undone. Mirrors the
 * restore-from-upload path; the IDE's firewall pinhole is re-added while the IDE
 * is installed. Also run by an admin's adopt before it clears a hold.
 */
export async function reapplyIsolation(
  vm: VirtualMachine,
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<void> {
  const kind: pve.GuestKind = vm.type === 'lxc' ? 'lxc' : 'qemu';
  await pve.applyDefaultBridge(vm.proxmoxNode, vm.proxmoxVmId, client, kind);
  if ((await getConfig('isolation_enabled')) === 'false') return;
  await pve.configureVmIsolation(vm.proxmoxNode, vm.proxmoxVmId, await pve.readIsolationOptions(), client, kind);
  await pve.ensureNicFirewall(vm.proxmoxNode, vm.proxmoxVmId, client, kind);
  const ingress = (await getConfig('ide_ingress_cidr'))?.trim();
  if (vm.ideState === 'ready' && ingress) {
    // Same port the IDE installer opens and code-server binds to.
    await pve.ensureIdePinhole(vm.proxmoxNode, vm.proxmoxVmId, { port: IDE_GUEST_PORT, source: ingress }, client, kind);
  }
}

/**
 * Restore a VM from one of its MateStates. Stops the VM (if running), waits
 * for it to be stopped, and runs a Proxmox restore-in-place (force=1) into
 * the SAME VMID — so the VM's identity, NIC, and isolation stay intact.
 */
export async function restoreFromMateState(vm: VirtualMachine, mateState: MateState): Promise<void> {
  if (mateState.vmId !== vm.id) throw new Error('MateState does not belong to this VM');
  if (mateState.status !== 'ready') throw new Error('MateState is not ready');
  const done = beginInFlight(vm.id, mateState.id);
  try {
    await restoreFromMateStateTracked(vm, mateState);
  } finally {
    done();
  }
}

async function restoreFromMateStateTracked(vm: VirtualMachine, mateState: MateState): Promise<void> {

  const client = await pve.getClient();
  const kind: pve.GuestKind = vm.type === 'lxc' ? 'lxc' : 'qemu';
  // A restore overwrites the guest at this VMID — only ever this row's (or an empty slot).
  vm = await requireOurGuest(vm, { allowAbsent: true, allowError: true, client });

  // The guest may have moved since the backup (Proxmox HA, the PVE UI). On
  // node-local backup storage the archive is only on the node it was taken on, so
  // say so plainly rather than let the restore fail inside Proxmox.
  const backupNodes = await pve.getBackupNodes(mateState.storage, mateState.volid, client);
  if (!backupNodes.includes(vm.proxmoxNode)) {
    throw new Error(
      backupNodes.length > 0
        ? `This backup is stored on ${backupNodes.join(', ')}, but the VM is now on ${vm.proxmoxNode}. Move the VM back to restore it.`
        : 'This backup is not available on any online node.',
    );
  }

  // The archive brings back the guest's whole config as it was at backup time.
  // Note which PCI devices are approved now (a device detached since the backup
  // must not return), then reserve the archive's sizes against the owner's quota
  // (refused when they don't fit).
  const archiveCfg = parseGuestConfigText(await pve.extractBackupConfig(vm.proxmoxNode, mateState.volid, client));
  const approvedPci = await approvedPciLines(vm, client);
  const reservation = await reserveRestoreGrowth(vm, archiveCfg);
  let taskStarted = false;
  try {
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
    const upid = await pve.restoreBackup(
      // No `pool`: an in-place restore keeps the guest's pool membership, and naming
      // a pool would fail for a guest an admin has since put in another one.
      { node: vm.proxmoxNode, vmid: vm.proxmoxVmId, volid: mateState.volid, storage: restoreStorage },
      client,
      kind,
    );
    taskStarted = true;
    await recordMateStateTask(mateState.id, upid);
    await pve.waitForTask(vm.proxmoxNode, upid, client, 30 * 60 * 1000);
    await prisma.mateState.update({ where: { id: mateState.id }, data: { status: 'ready', upid: null } });
    vm = await settleRestoredGuest(vm, approvedPci, client);
    // Powering on is what every start path gates on the owner's compute-access
    // window; a restore by a share-holder must not revive a suspended owner's
    // machine. The data is restored either way; the guest just stays off.
    const ownerActive = await assertOwnerAccessActive(vm).then(() => true, () => false);
    if (ownerActive) await pve.startVm(vm.proxmoxNode, vm.proxmoxVmId, client, kind);
    await prisma.virtualMachine.update({
      where: { id: vm.id },
      data: { status: ownerActive ? 'running' : 'stopped', holdReason: null },
    });
  } catch (err) {
    await prisma.mateState.update({ where: { id: mateState.id }, data: { status: 'ready', upid: null } });
    await afterFailedRestore(vm, reservation, taskStarted, err);
    throw err;
  }
}

/**
 * Once a restore or rollback task has replaced the guest's config, in this order
 * and before anything may start it: tag it as this row's, put it back on the
 * network placement and isolation it has now (even when tagging failed), then
 * re-sync the row's sizes and strip PCI devices that aren't approved.
 */
async function settleRestoredGuest(
  vm: VirtualMachine,
  approvedPci: string[],
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<VirtualMachine> {
  const kind: pve.GuestKind = vm.type === 'lxc' ? 'lxc' : 'qemu';
  // Loaded lazily (restore-upload imports this module).
  const { stripRestoreFlags, neutraliseAfterFailure } = await import('./restore-upload.service.js');
  // A restored config may carry autostart or protection: nothing may start the
  // guest on its own while it is being made safe, so they go first.
  await stripRestoreFlags(vm.proxmoxNode, vm.proxmoxVmId, client, kind).catch(() => undefined);
  // A container restore applies the `etc/vzdump/pct.conf` it finds in the backed-up
  // rootfs, which the tenant controls: check what Proxmox actually restored before
  // the guest is tagged, isolated or started. Loaded lazily (restore-upload imports
  // this module).
  if (vm.type === 'lxc') {
    const { assertRestoredGuestConfig, neutraliseRestoredGuest, RestoredConfigError } = await import(
      './restore-upload.service.js'
    );
    try {
      await assertRestoredGuestConfig(vm.proxmoxNode, vm.proxmoxVmId, 'lxc', client, { allowSnapshots: true });
    } catch (err) {
      // The tenant's own machine is kept (held), but nothing may start it as it is.
      const bad = err instanceof RestoredConfigError ? err : null;
      await neutraliseRestoredGuest(vm.proxmoxNode, vm.proxmoxVmId, 'lxc', client, {
        keys: bad?.keys,
        pendingKeys: bad?.pendingKeys,
        destroy: false,
      });
      throw err;
    }
    // Its guest firewall came from the archive, which the rootfs can override:
    // isolation below writes ProxMate's own again.
    await pve.resetRestoredFirewall(vm.proxmoxNode, vm.proxmoxVmId, client, 'lxc');
  }
  try {
    try {
      // The config came back with its tags (a backup or snapshot from before
      // ownership tags existed has none) — tag it as this row's again.
      await markClonedGuest(vm, client);
    } finally {
      await reapplyIsolation(vm, client);
    }
    // Only this guest's own volumes, whatever the archive or snapshot referenced.
    await assertOwnVolumes(vm, client);
    return await syncRestoredGuest(vm, { approvedPci, client });
  } catch (err) {
    // The row is held after this; until an admin looks, the guest neither starts on
    // its own nor reaches the network.
    await neutraliseAfterFailure(vm.proxmoxNode, vm.proxmoxVmId, kind, client, err);
    throw err;
  }
}

/**
 * A restore or rollback failed. Before its task started the guest is unchanged:
 * give back the reserved quota. After, the guest's state is unknown — keep the
 * reservation (it never undercounts), stop it if it is running, and put the row
 * in `error` so nothing starts it until a repair. An over-quota hold set by
 * syncRestoredGuest is left as it is.
 */
async function afterFailedRestore(
  vm: VirtualMachine,
  reservation: RestoreReservation,
  taskStarted: boolean,
  err: unknown,
): Promise<void> {
  if (!taskStarted) {
    await releaseRestoreReservation(vm, reservation).catch(() => undefined);
    return;
  }
  const kind: pve.GuestKind = vm.type === 'lxc' ? 'lxc' : 'qemu';
  try {
    const st = await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, undefined, kind);
    if (st.status !== 'stopped') await pve.stopVm(vm.proxmoxNode, vm.proxmoxVmId, undefined, kind);
  } catch {
    /* gone or unreachable — the error state below still keeps it from being started */
  }
  // Held already, with a more specific reason, by syncRestoredGuest / assertOwnVolumes.
  if (err instanceof Error && (err.name === 'QuotaError' || err.name === 'ForeignVolumeError')) return;
  await holdErroredRow(vm, RESTORE_FAILED_MESSAGE).catch(() => undefined);
}

/**
 * Roll a VM back to one of its Proxmox snapshots. The snapshot holds the whole
 * guest config as it was then — cores, memory, disks, PCI devices — so it is
 * refused when that config would grow the guest past its owner's quota, and
 * afterwards the row is re-synced from the guest and PCI devices not approved
 * now are removed. Returns the re-synced row.
 */
export async function rollbackToSnapshot(vm: VirtualMachine, snapname: string): Promise<VirtualMachine> {
  const client = await pve.getClient();
  vm = await requireOurGuest(vm, { allowError: true, client });
  const snapCfg = await pve.getSnapshotConfig(vm.proxmoxNode, vm.proxmoxVmId, snapname, client);
  // A snapshot with RAM state comes back running, so it is a power-on like any
  // other and needs the owner's compute-access window open.
  if (snapCfg['vmstate']) await assertOwnerAccessActive(vm);
  const approvedPci = await approvedPciLines(vm, client);
  // A RAM snapshot comes back running with its devices attached, before anything
  // could strip them — so a snapshot holding a PCI device that isn't approved now
  // is refused outright rather than cleaned up afterwards.
  const unapproved = pciLines(snapCfg).filter((l) => !approvedPci.includes(l.value));
  if (unapproved.length > 0) {
    throw new Error(
      `This snapshot has a PCI device (${unapproved.map((l) => l.key).join(', ')}) that isn't approved for this VM any more, so it can't be rolled back to.`,
    );
  }
  // Likewise anything no tenant guest may have — a host device or host-level
  // setting (raw `args`, host USB/serial, `virtiofs`, a hook script) or another
  // guest's volume — whatever put it in the snapshot: refused up front, since a
  // rollback (a RAM one especially) brings it back before anything could strip it.
  const hostLevel = hostLevelKeys(snapCfg, vm.type === 'lxc' ? 'lxc' : 'qemu').filter((k) => !/^hostpci\d+$/.test(k));
  const foreign = foreignVolumeKeys(snapCfg, vm.proxmoxVmId);
  if (hostLevel.length > 0 || foreign.length > 0) {
    throw new Error(
      `This snapshot holds settings a machine here may not have (${[...hostLevel, ...foreign].join(', ')}), so it can't be rolled back to. ` +
        'Delete the snapshot, or ask an admin.',
    );
  }
  const reservation = await reserveRestoreGrowth(vm, snapCfg);

  let taskStarted = false;
  try {
    const upid = await pve.rollbackSnapshot(vm.proxmoxNode, vm.proxmoxVmId, snapname, client);
    taskStarted = true;
    await pve.waitForTask(vm.proxmoxNode, upid, client, 300_000);
    // The snapshot's tags, NIC line (bridge, VLAN tag), sizes and devices came back with it.
    const synced = await settleRestoredGuest(vm, approvedPci, client);
    return await prisma.virtualMachine.update({
      where: { id: synced.id },
      data: { status: snapCfg['vmstate'] ? 'running' : 'stopped', holdReason: null },
    });
  } catch (err) {
    await afterFailedRestore(vm, reservation, taskStarted, err);
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
