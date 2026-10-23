import type { MateState, VirtualMachine } from '@prisma/client';
import { AxiosError, type AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma.js';
import { isInFlight } from '../lib/in-flight.js';
import { envNumber } from '../lib/env-number.js';
import { getConfig } from './config.service.js';
import { notify } from './notify.service.js';
import { recordAudit } from './audit.service.js';
import * as pve from './proxmox.service.js';
import {
  kindOf,
  syncVmNodeChecked,
  settleFailedCreate,
  settleFailedRebuild,
  markVmError,
  requireOurGuest,
  tagsMarkRow,
  holdErroredRow,
  OP_SETTLED,
  RESTORE_FAILED_MESSAGE,
  deleteVmRow,
  type VmOpKind,
} from './vm.service.js';

// ─── Interrupted background operations ────────────────────────
//
// Creates, clones, upload restores, rebuilds, MateState backups and in-place
// restores run inside the request (or scheduler tick) that started them. When the
// backend restarts mid-way, that continuation is gone: the row stays `creating`
// (or its MateState `creating`/`restoring`) for good, and the live-status sync
// deliberately leaves `creating` rows alone. This pass, run at startup and then on
// the scheduler, settles such rows from what Proxmox shows:
//
// - never a row whose operation is running in this process (lib/in-flight), nor
//   one younger than STUCK_AFTER_MS, nor one whose Proxmox task is still running or
//   whose guest holds a Proxmox lock — those are looked at again next pass;
// - a create whose only remaining step was the isolation firewall (ISO VM, LXC,
//   ISO rebuild) and whose task finished OK on a guest carrying this row's tag is
//   completed and left stopped;
// - anything else that got part-way is held exactly as a failed create, rebuild or
//   restore is (status `error` + holdReason), and admins are notified;
// - a create that never produced a guest is settled as a failed create is (the
//   row is dropped, since its VMID will go to the next guest anyone creates).
//
// Nothing here deletes a guest or a backup.

/** How long an operation's row must be untouched before it counts as interrupted. */
export const STUCK_AFTER_MS = envNumber('RECONCILE_STUCK_MINUTES', 15, 1) * 60_000;

/** Why the settled row's operation failed, as the owner and admins read it. */
const INTERRUPTED = 'ProxMate was restarted before this finished, so it stopped part-way';

export type ReconcileOutcome =
  | 'in-flight'
  | 'recent'
  | 'busy'
  | 'unreachable'
  | 'completed'
  | 'held'
  | 'dropped'
  | 'failed';

export interface ReconcileSummary {
  checked: number;
  completed: number;
  held: number;
  dropped: number;
  failed: number;
  /** Left for a later pass (in flight here, too recent, still busy in Proxmox, or Proxmox unreachable). */
  deferred: number;
}

/** The node a UPID names (`UPID:<node>:…`), or null for something that isn't one. */
export function upidNode(upid: string | null | undefined): string | null {
  const parts = (upid ?? '').split(':');
  return parts[0] === 'UPID' && parts[1] ? parts[1] : null;
}

type TaskVerdict = 'running' | 'ok' | 'failed' | 'unknown';

async function taskVerdict(upid: string | null, client: AxiosInstance): Promise<TaskVerdict> {
  const node = upidNode(upid);
  if (!upid || !node) return 'unknown';
  try {
    const st = await pve.getTaskStatus(node, upid, client);
    if (st.status === 'running') return 'running';
    if (st.status !== 'stopped') return 'unknown';
    return !st.exitstatus || st.exitstatus === 'OK' || st.exitstatus.startsWith('WARNINGS') ? 'ok' : 'failed';
  } catch {
    return 'unknown';
  }
}

/** The guest config at a row's VMID; null when there is no guest there. Throws when Proxmox can't say. */
async function guestConfig(vm: VirtualMachine, client: AxiosInstance): Promise<Record<string, string> | null> {
  try {
    return await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, client, kindOf(vm));
  } catch (err) {
    if (/does not exist|not found/i.test(pve.pveMessage(err))) return null;
    // A pool-scoped token is refused (403) on any VMID outside its pool, an empty
    // one included. Only a VMID Proxmox would hand out next is provably empty;
    // anything else may be a guest the token can't see, and is left alone.
    if (err instanceof AxiosError && err.response?.status === 403) {
      if (await pve.isVmIdFree(vm.proxmoxVmId, client)) return null;
    }
    throw err;
  }
}

function tooRecent(since: Date, now: Date): boolean {
  return now.getTime() - since.getTime() < STUCK_AFTER_MS;
}

/** Settle one `creating` VirtualMachine row. Exported for tests. */
export async function reconcileCreatingVm(
  row: VirtualMachine,
  client: AxiosInstance,
  now: Date = new Date(),
): Promise<ReconcileOutcome> {
  if (isInFlight(row.id)) return 'in-flight';
  if (tooRecent(row.opStartedAt ?? row.updatedAt, now)) return 'recent';

  // "Not at the stored node" only means gone when the cluster-wide lookup worked.
  const { vm, synced } = await syncVmNodeChecked(row);
  if (!synced) return 'unreachable';

  const task = await taskVerdict(vm.opUpid, client);
  if (task === 'running') return 'busy';
  let cfg: Record<string, string> | null;
  try {
    cfg = await guestConfig(vm, client);
  } catch {
    return 'unreachable';
  }
  // A Proxmox lock (create, clone, backup, ...) means Proxmox is still working on it.
  if (cfg?.['lock']) return 'busy';

  const kind = (vm.opKind ?? null) as VmOpKind | null;
  const err = new Error(INTERRUPTED);

  if (
    (kind === 'create' || kind === 'create-lxc' || kind === 'rebuild-iso') &&
    task === 'ok' &&
    cfg &&
    cfg['template'] !== '1' &&
    tagsMarkRow(cfg['tags'], vm.id)
  ) {
    try {
      await completeFirewallOnlyCreate(vm, kind, client);
      return 'completed';
    } catch (e) {
      console.warn(`[reconcile] could not finish "${vm.name}": ${pve.pveMessage(e)}`);
      // Held below, like any create that got part-way.
    }
  }

  if (kind === 'import') {
    // An import isolates the guest first and writes its tag last: tagged → only the
    // final status write was missing, so it is completed; not yet tagged → the
    // import didn't happen, so the row is dropped and the guest stays importable.
    // The guest is never ProxMate's to remove.
    if (cfg && tagsMarkRow(cfg['tags'], vm.id)) {
      const live = await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, client, kindOf(vm)).catch(() => null);
      const status = live?.status === 'running' || live?.status === 'paused' ? live.status : 'stopped';
      await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status, ...OP_SETTLED } });
      return 'completed';
    } else {
      await deleteVmRow(vm.id);
    }
  } else if (kind === 'rebuild-iso' || kind === 'rebuild-template') {
    await settleFailedRebuild(vm, err, false);
  } else if (cfg === null && task !== 'ok' && (kind !== null || (await prisma.mateState.count({ where: { vmId: vm.id } })) === 0)) {
    // A create that never produced a guest (a bulk-deploy copy that never got its
    // turn, a create cut off before its task): dropped exactly as a failed create
    // with an empty VMID is, which also gives its quota back.
    await deleteVmRow(vm.id);
    await notify({
      event: 'vm.error',
      title: vm.name,
      message: `Provisioning of "${vm.name}" failed: ${INTERRUPTED}`,
    }).catch(() => undefined);
  } else if (kind === 'restore-upload' && task === 'ok') {
    // The restore landed, but none of the checks a restored guest needs before it
    // is tied to its row (its own volumes only, rebuilt NICs, isolation) ran. So
    // it is held and left untagged: an admin adopting it runs those checks.
    await markVmError(vm.id, vm.name, err);
  } else if (kind === null && (await prisma.mateState.count({ where: { vmId: vm.id } })) > 0) {
    // An older row with no record of its operation, and backups hanging off it:
    // kept (held) so those backups stay reachable, whatever is at the VMID.
    await markVmError(vm.id, vm.name, err);
  } else {
    // A clone's verdict comes from its own task (tagging the finished copy as the
    // row's, as a create that outlived its wait does). An upload restore's never
    // does — tagging is what the skipped checks would have earned it.
    const upid = vm.opUpid;
    const node = upidNode(upid);
    const withTask = kind !== 'restore-upload' && upid && node ? { task: { node, upid } } : {};
    await settleFailedCreate(vm, err, false, withTask);
  }

  const after = await prisma.virtualMachine.findUnique({ where: { id: vm.id } });
  const outcome: ReconcileOutcome = after ? 'held' : 'dropped';
  await recordAudit({
    action: 'vm.reconcile',
    targetType: 'vm',
    targetId: vm.id,
    detail:
      `${kind ?? 'operation'} of "${vm.name}" was interrupted by a restart; ` +
      (outcome === 'held'
        ? 'machine held'
        : kind === 'import'
          ? 'guest was not yet tagged, record removed'
          : 'no guest was created, record removed'),
  });
  return outcome;
}

/**
 * The remaining step of an ISO VM, LXC or ISO rebuild whose create task finished:
 * its isolation firewall. Applied on the row's own guest, then the row is left
 * `stopped` (the owner starts it) — exactly what the interrupted create would have
 * written before booting it.
 */
async function completeFirewallOnlyCreate(
  vm: VirtualMachine,
  kind: 'create' | 'create-lxc' | 'rebuild-iso',
  client: AxiosInstance,
): Promise<void> {
  // A rebuild is a repair path, so it may run on a row that was held before it.
  const current = await requireOurGuest(vm, { client, allowError: kind === 'rebuild-iso', settlingInterrupted: true });
  if ((await getConfig('isolation_enabled')) !== 'false') {
    await pve.configureVmIsolation(
      current.proxmoxNode,
      current.proxmoxVmId,
      await pve.readIsolationOptions(),
      client,
      kindOf(current),
    );
  }
  await prisma.virtualMachine.update({
    where: { id: current.id },
    data: {
      status: 'stopped',
      ...OP_SETTLED,
      // What a finished rebuild clears: its hold, and anything about the old disk.
      ...(kind === 'rebuild-iso'
        ? { holdReason: null, ideState: null, ideStateAt: null, deployState: null, deployStateAt: null, pendingCiPassword: null }
        : {}),
    },
  });
  await recordAudit({
    action: 'vm.reconcile',
    targetType: 'vm',
    targetId: current.id,
    detail: `${kind} of "${current.name}" finished while ProxMate was restarting; completed and left stopped`,
  });
}

/** Settle one MateState left `restoring` (an in-place restore). Exported for tests. */
export async function reconcileRestoringMateState(
  ms: MateState,
  client: AxiosInstance,
  now: Date = new Date(),
): Promise<ReconcileOutcome> {
  if (isInFlight(ms.id) || isInFlight(ms.vmId)) return 'in-flight';
  if (tooRecent(ms.updatedAt, now)) return 'recent';
  const row = await prisma.virtualMachine.findUnique({ where: { id: ms.vmId } });
  if (!row) return 'unreachable';
  const { vm, synced } = await syncVmNodeChecked(row);
  if (!synced) return 'unreachable';

  if ((await taskVerdict(ms.upid, client)) === 'running') return 'busy';
  let cfg: Record<string, string> | null;
  try {
    cfg = await guestConfig(vm, client);
  } catch {
    return 'unreachable';
  }
  if (cfg?.['lock']) return 'busy';

  // The backup itself is untouched by a restore: it is usable again.
  await prisma.mateState.update({ where: { id: ms.id }, data: { status: 'ready', upid: null } });

  // What the guest now holds is unknown — the restore's checks (tag, isolation,
  // own volumes, sizes, PCI devices) never ran. As after any restore that didn't
  // finish: stop it if it is running (only ever this row's own guest), and hold
  // the row until a repair. A more specific hold already on it is kept.
  try {
    const ours = await requireOurGuest(vm, { allowError: true, client });
    const st = await pve.getVmStatus(ours.proxmoxNode, ours.proxmoxVmId, client, kindOf(ours));
    if (st.status !== 'stopped') await pve.stopVm(ours.proxmoxNode, ours.proxmoxVmId, client, kindOf(ours));
  } catch {
    /* not provably ours, or gone — the hold below still keeps it from being started */
  }
  if (!vm.holdReason) await holdErroredRow(vm, RESTORE_FAILED_MESSAGE);
  await notify({
    event: 'vm.error',
    title: vm.name,
    message: `The restore of "${vm.name}" was interrupted by a ProxMate restart, so the machine is held. Restore the backup again, rebuild it, or ask an admin to check it.`,
  }).catch(() => undefined);
  await recordAudit({
    action: 'vm.reconcile',
    targetType: 'vm',
    targetId: vm.id,
    detail: `restore of "${vm.name}" was interrupted by a restart; machine held`,
  });
  return 'held';
}

/** Settle one MateState left `creating` (a backup). Exported for tests. */
export async function reconcileCreatingMateState(
  ms: MateState,
  client: AxiosInstance,
  now: Date = new Date(),
): Promise<ReconcileOutcome> {
  if (isInFlight(ms.id)) return 'in-flight';
  if (tooRecent(ms.createdAt, now)) return 'recent';

  const task = await taskVerdict(ms.upid, client);
  if (task === 'running') return 'busy';
  if (!ms.upid) {
    // No task recorded: vzdump may still hold the guest's backup lock.
    const vm = await prisma.virtualMachine.findUnique({ where: { id: ms.vmId } });
    if (vm) {
      try {
        if ((await guestConfig(vm, client))?.['lock'] === 'backup') return 'busy';
      } catch {
        return 'unreachable';
      }
    }
  }

  if (task === 'ok') {
    // Record the archive the task's own log names (as a backup that finished in
    // time does) — only when it is listed as this guest's.
    const node = upidNode(ms.upid)!;
    const lines = await pve.getTaskLog(node, ms.upid!, client).catch(() => [] as string[]);
    const volid = pve.backupVolidFromLog(lines, ms.storage);
    const listed = volid
      ? (await pve.listBackups(ms.storage, client).catch(() => [])).find(
          (b) => b.volid === volid && b.vmid === ms.proxmoxVmId,
        )
      : undefined;
    if (listed) {
      await prisma.mateState.update({
        where: { id: ms.id },
        data: { volid: listed.volid, size: BigInt(Math.trunc(listed.size ?? 0)), status: 'ready', upid: null },
      });
      await recordAudit({
        action: 'matestate.reconcile',
        targetType: 'vm',
        targetId: ms.vmId,
        detail: `backup ${listed.volid} finished while ProxMate was restarting; recorded`,
      });
      return 'completed';
    }
  }

  // Failed, or no way to tell what it wrote: the row says so. Any archive the
  // task did write is left where it is (nothing is deleted here).
  await prisma.mateState.update({ where: { id: ms.id }, data: { status: 'error', upid: null } });
  const vm = await prisma.virtualMachine.findUnique({ where: { id: ms.vmId }, select: { name: true } });
  await notify({
    event: 'backup.failed',
    title: vm?.name ?? `VMID ${ms.proxmoxVmId}`,
    message: `A backup of "${vm?.name ?? ms.proxmoxVmId}" was interrupted by a ProxMate restart and did not finish.`,
  }).catch(() => undefined);
  await recordAudit({
    action: 'matestate.reconcile',
    targetType: 'vm',
    targetId: ms.vmId,
    detail: 'backup was interrupted by a restart; marked failed',
  });
  return 'failed';
}

/**
 * One reconcile pass over every row an interrupted operation may have left
 * behind. Cheap when there is nothing to do (two indexed queries). Each row is
 * settled on its own; one that errors is left for the next pass.
 */
export async function reconcileStuckOperations(now: Date = new Date()): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, completed: 0, held: 0, dropped: 0, failed: 0, deferred: 0 };
  const [vms, states] = await Promise.all([
    prisma.virtualMachine.findMany({ where: { status: 'creating' } }),
    prisma.mateState.findMany({ where: { status: { in: ['creating', 'restoring'] } } }),
  ]);
  if (vms.length === 0 && states.length === 0) return summary;

  let client: AxiosInstance;
  try {
    client = await pve.getClient();
  } catch {
    summary.deferred = vms.length + states.length; // Proxmox unreachable — next pass
    return summary;
  }

  const count = (o: ReconcileOutcome) => {
    summary.checked += 1;
    if (o === 'completed') summary.completed += 1;
    else if (o === 'held') summary.held += 1;
    else if (o === 'dropped') summary.dropped += 1;
    else if (o === 'failed') summary.failed += 1;
    else summary.deferred += 1;
  };

  for (const vm of vms) {
    try {
      count(await reconcileCreatingVm(vm, client, now));
    } catch (err) {
      console.error(`[reconcile] "${vm.name}" (row ${vm.id}) could not be settled:`, err);
      count('unreachable');
    }
  }
  for (const ms of states) {
    try {
      count(
        ms.status === 'restoring'
          ? await reconcileRestoringMateState(ms, client, now)
          : await reconcileCreatingMateState(ms, client, now),
      );
    } catch (err) {
      console.error(`[reconcile] MateState ${ms.id} could not be settled:`, err);
      count('unreachable');
    }
  }
  return summary;
}
