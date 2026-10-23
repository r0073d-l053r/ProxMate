import type { VirtualMachine } from '@prisma/client';
import type { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma.js';
import { getConfig, setConfig } from './config.service.js';
import * as pve from './proxmox.service.js';

// ─── Automatic snapshots before risky changes ─────────────────
//
// Before a resize (CPU/RAM or disk grow), a data-disk grow, or booting into
// rescue, ProxMate takes a Proxmox snapshot of the VM (QEMU only — containers
// have no snapshot support here yet) so the owner can roll the change back.
// Each one is recorded in AutoSnapshot; retention keeps the newest N per VM and
// only ever deletes a snapshot that is recorded there AND still has the recorded
// name and snaptime, so a snapshot a user took is never removed.
//
// A rebuild is deliberately NOT covered: it deletes the guest, and Proxmox deletes
// a guest's snapshots with it, so a snapshot cannot outlive a rebuild. A backup
// (MateState) is the way to keep a copy across one.

/** Name prefix reserved for automatic snapshots (refused for user-made ones). */
export const AUTO_SNAPSHOT_PREFIX = 'pm-auto-';

/** Snapshots per VM, user and automatic together: they use host storage and aren't quota-counted. */
export const MAX_SNAPSHOTS_PER_VM = 12;

export const AUTO_SNAPSHOT_DEFAULT_KEEP = 3;
export const AUTO_SNAPSHOT_MAX_KEEP = 10;

export type AutoSnapshotOp = 'resize' | 'disk-resize' | 'rescue';

const OP_LABEL: Record<AutoSnapshotOp, string> = {
  resize: 'a resize',
  'disk-resize': 'a data-disk resize',
  rescue: 'booting into rescue mode',
};

export interface AutoSnapshotSettings {
  enabled: boolean;
  keep: number;
}

/** Whether the automatic snapshots are on (default on) and how many to keep per VM (default 3). */
export async function getAutoSnapshotSettings(): Promise<AutoSnapshotSettings> {
  const [enabled, keep] = await Promise.all([getConfig('auto_snapshot_enabled'), getConfig('auto_snapshot_keep')]);
  const n = Number(keep);
  return {
    enabled: enabled !== 'false',
    keep: Number.isInteger(n) && n >= 1 && n <= AUTO_SNAPSHOT_MAX_KEEP ? n : AUTO_SNAPSHOT_DEFAULT_KEEP,
  };
}

export async function saveAutoSnapshotSettings(s: AutoSnapshotSettings): Promise<void> {
  await setConfig('auto_snapshot_enabled', String(s.enabled));
  await setConfig('auto_snapshot_keep', String(s.keep));
}

/** Thrown when the snapshot a change depends on couldn't be taken; the change is not made. */
export class AutoSnapshotError extends Error {
  constructor(detail: string) {
    super(
      `Couldn't take the automatic snapshot this change starts with (${detail}), so nothing was changed. ` +
        'Try again, or an admin can turn automatic snapshots off under Settings → Maintenance.',
    );
    this.name = 'AutoSnapshotError';
  }
}

/** What happened about the automatic snapshot of one change. */
export type AutoSnapshotResult =
  | { taken: string }
  | { taken: null; skipped: 'disabled' | 'container' | 'unsupported' };

/** The snapshot name for an op at a time, e.g. `pm-auto-resize-20261023-153000`. */
export function autoSnapshotName(op: AutoSnapshotOp, at: Date): string {
  const iso = at.toISOString(); // 2026-10-23T15:30:00.000Z
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  return `${AUTO_SNAPSHOT_PREFIX}${op}-${stamp}`;
}

/** Whether a user-chosen snapshot name falls in the reserved automatic range. */
export function isReservedSnapshotName(name: string): boolean {
  return name.toLowerCase().startsWith(AUTO_SNAPSHOT_PREFIX);
}

/**
 * Take the automatic snapshot that precedes `op` on a VM whose guest the caller
 * has just confirmed is its own (requireOurGuest), then apply retention. Throws
 * AutoSnapshotError when it is on and the snapshot can't be made — the caller
 * must then not make the change. Skipped (and said so) when the feature is off,
 * for containers, and when the VM's storage can't take snapshots at all.
 */
export async function autoSnapshotBefore(
  vm: VirtualMachine,
  op: AutoSnapshotOp,
  client: AxiosInstance,
  now: Date = new Date(),
): Promise<AutoSnapshotResult> {
  const settings = await getAutoSnapshotSettings();
  if (!settings.enabled) return { taken: null, skipped: 'disabled' };
  if (vm.type === 'lxc') return { taken: null, skipped: 'container' };

  // Plain LVM or raw-file disks can't be snapshotted at all; that is the storage,
  // not a failure, so the change goes ahead and the caller reports the skip. When
  // the probe itself fails, try the snapshot anyway and let that decide.
  const supported = await pve.canSnapshot(vm.proxmoxNode, vm.proxmoxVmId, client).catch(() => true);
  if (!supported) return { taken: null, skipped: 'unsupported' };

  let snaps: pve.PveSnapshot[];
  try {
    snaps = await pve.listSnapshots(vm.proxmoxNode, vm.proxmoxVmId, client);
  } catch (err) {
    throw new AutoSnapshotError(pve.pveMessage(err));
  }

  // At the per-VM cap, make room by dropping this VM's oldest automatic snapshots
  // only; a VM full of the user's own snapshots refuses the change instead.
  if (snaps.length >= MAX_SNAPSHOTS_PER_VM) {
    const removable = (await deletableAutoSnapshots(vm, snaps)).reverse(); // oldest first
    for (const r of removable) {
      if (snaps.length < MAX_SNAPSHOTS_PER_VM) break;
      if (await deleteAutoSnapshot(vm, r, client)) snaps = snaps.filter((s) => s.name !== r.name);
    }
    if (snaps.length >= MAX_SNAPSHOTS_PER_VM) {
      throw new AutoSnapshotError(
        `this machine already has the maximum of ${MAX_SNAPSHOTS_PER_VM} snapshots — delete one first`,
      );
    }
  }

  let name = autoSnapshotName(op, now);
  if (snaps.some((s) => s.name === name)) name = `${name}-2`;
  try {
    const upid = await pve.createSnapshot(
      vm.proxmoxNode,
      vm.proxmoxVmId,
      name,
      { description: `Taken automatically by ProxMate before ${OP_LABEL[op]}.` },
      client,
    );
    await pve.waitForTask(vm.proxmoxNode, upid, client, 300_000);
  } catch (err) {
    throw new AutoSnapshotError(pve.pveMessage(err));
  }

  // Recorded only once it exists, with Proxmox's own snaptime: a snapshot that
  // isn't recorded is never deleted by retention, so any doubt keeps it.
  const after = await pve.listSnapshots(vm.proxmoxNode, vm.proxmoxVmId, client).catch(() => [] as pve.PveSnapshot[]);
  const made = after.find((s) => s.name === name);
  // The snapshot is what protects the change; failing to record it only means
  // retention will leave it for the owner to delete.
  await prisma.autoSnapshot
    .create({ data: { vmId: vm.id, name, op, snaptime: made?.snaptime ?? null } })
    .catch((err: unknown) => console.warn(`[auto-snapshot] could not record "${name}": ${String(err)}`));

  await pruneAutoSnapshots(vm, settings.keep, client, after.length > 0 ? after : undefined).catch((err) =>
    console.warn(`[auto-snapshot] retention for "${vm.name}" failed: ${pve.pveMessage(err)}`),
  );
  return { taken: name };
}

type Recorded = { id: string; name: string; snaptime: number | null; createdAt: Date };

/**
 * This VM's recorded automatic snapshots that exist on Proxmox as recorded,
 * newest first. A record whose snapshot is gone (deleted by hand, or with the
 * guest) is dropped here. A snapshot whose snaptime differs from the record is a
 * different snapshot that reuses the name, and is never a candidate.
 */
async function deletableAutoSnapshots(vm: VirtualMachine, snaps: pve.PveSnapshot[]): Promise<Recorded[]> {
  const recorded = await prisma.autoSnapshot.findMany({ where: { vmId: vm.id }, orderBy: { createdAt: 'desc' } });
  const live = new Map(snaps.map((s) => [s.name, s]));
  const out: Recorded[] = [];
  for (const r of recorded) {
    const s = live.get(r.name);
    if (!s) {
      await prisma.autoSnapshot.delete({ where: { id: r.id } }).catch(() => undefined);
      continue;
    }
    if (!r.name.startsWith(AUTO_SNAPSHOT_PREFIX)) continue;
    // Without a recorded snaptime nothing proves the live snapshot is the one taken.
    if (r.snaptime === null || s.snaptime === undefined || s.snaptime !== r.snaptime) continue;
    out.push(r);
  }
  return out.sort((a, b) => (b.snaptime ?? 0) - (a.snaptime ?? 0) || b.createdAt.getTime() - a.createdAt.getTime());
}

async function deleteAutoSnapshot(vm: VirtualMachine, r: Recorded, client: AxiosInstance): Promise<boolean> {
  try {
    const upid = await pve.deleteSnapshot(vm.proxmoxNode, vm.proxmoxVmId, r.name, client);
    await pve.waitForTask(vm.proxmoxNode, upid, client, 300_000);
  } catch (err) {
    console.warn(`[auto-snapshot] could not delete "${r.name}" of "${vm.name}": ${pve.pveMessage(err)}`);
    return false;
  }
  await prisma.autoSnapshot.delete({ where: { id: r.id } }).catch(() => undefined);
  return true;
}

/** Keep the newest `keep` automatic snapshots of a VM; delete older recorded ones. */
export async function pruneAutoSnapshots(
  vm: VirtualMachine,
  keep: number,
  client: AxiosInstance,
  snaps?: pve.PveSnapshot[],
): Promise<number> {
  const list = snaps ?? (await pve.listSnapshots(vm.proxmoxNode, vm.proxmoxVmId, client));
  const candidates = await deletableAutoSnapshots(vm, list);
  let deleted = 0;
  for (const r of candidates.slice(keep)) {
    if (await deleteAutoSnapshot(vm, r, client)) deleted += 1;
  }
  return deleted;
}
