import type { MateState, VirtualMachine } from '@prisma/client';
import { AxiosError, type AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma.js';
import { beginInFlight, isInFlight, inFlightCount } from '../lib/in-flight.js';
import { envNumber } from '../lib/env-number.js';
import { getConfig } from './config.service.js';
import { notify } from './notify.service.js';
import { recordAudit } from './audit.service.js';
import * as pve from './proxmox.service.js';
import {
  kindOf,
  syncVmNodeChecked,
  requireOurGuest,
  tagsMarkRow,
  tagsWithMarker,
  parsePveTags,
  guestMarker,
  templateMarker,
  notifyOwnerOfFailedRebuild,
  cloneNonce,
  OP_SETTLED,
  PROVISION_FAILED_MESSAGE,
  type VmOpKind as FollowKind,
  RESTORE_FAILED_MESSAGE,
  type VmOpKind,
} from './vm.service.js';
import { stripRestoreFlags, cleanupUploadedArchive, checkRestoredOrRemove } from './restore-upload.service.js';

// ─── Interrupted background operations ────────────────────────
//
// Creates, clones, upload restores, rebuilds, imports, MateState backups and
// in-place restores run in this process: inside the request (or scheduler tick)
// that started them, or — for creates, which answer as soon as their row exists —
// in the background after it. When the backend restarts mid-way, that
// continuation is gone: the row stays `creating` (or its MateState
// `creating`/`restoring`) for good, and the live-status sync deliberately leaves
// `creating` rows alone. This pass, run at
// startup and then on the scheduler, settles such rows from what Proxmox shows:
//
// - never a row whose operation is running in this process (lib/in-flight), nor
//   one younger than STUCK_AFTER_MS, nor one whose Proxmox task is still running,
//   whose task can't be read right now, or whose guest holds a Proxmox lock — those
//   are looked at again next pass. The in-flight check is repeated right before
//   each write, and every write is conditional on the row still being the one that
//   was read (`creating`, same `opStartedAt`), so a row something else picked up
//   meanwhile is left to it;
// - a guest is only ever treated as the row's when it carries the row's tag. A
//   clone whose task finished before it was tagged is tagged here only when nothing
//   else could claim it: no other row has its VMID, it carries no ProxMate tag but
//   its source's, and its name is the row's. A task result alone is never enough —
//   the VMID may have gone to someone else's guest since;
// - a create whose only remaining step was the isolation firewall (ISO VM, LXC, ISO
//   rebuild) is completed and left stopped; an import whose tag was written (the
//   last step) is completed;
// - anything else that got part-way is held with the provisioning hold, admins
//   are notified (once per row), and a create that never produced a guest is
//   dropped, which frees its quota.
//
// Nothing here deletes a guest or a backup.

/** How long an operation's row must be untouched before it counts as interrupted. */
export const STUCK_AFTER_MS = envNumber('RECONCILE_STUCK_MINUTES', 15, 1) * 60_000;

/** After this long under a Proxmox lock, an admin is told (once) and the row is still left alone. */
export const LOCK_NOTICE_AFTER_MS = 24 * 60 * 60 * 1000;

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

/** Rows whose long-lock notice has gone out (per process: a restart may repeat it once). */
const lockNoticeSent = new Set<string>();

/** Test hook. */
export function resetReconcileNotices(): void {
  lockNoticeSent.clear();
  longWaitNoticeSent.clear();
  longWaitFirstSeen.clear();
}

/** The node a UPID names (`UPID:<node>:…`), or null for something that isn't one. */
export function upidNode(upid: string | null | undefined): string | null {
  const parts = (upid ?? '').split(':');
  return parts[0] === 'UPID' && parts[1] ? parts[1] : null;
}

/**
 * What a recorded task says: `none` when no task was recorded, `unreachable` when
 * one was but can't be read now (a node down, a hiccup) — the row is then left for
 * the next pass rather than settled on a guess.
 */
type TaskVerdict = 'running' | 'ok' | 'failed' | 'none' | 'unknown' | 'unreachable';

/**
 * `unknown`: Proxmox answered that there is no such task (its log rotated away, or
 * the UPID is from a node that was reinstalled). That answer won't change, so it
 * is not retried: nothing about the task can be proven any more.
 */
async function readTask(
  upid: string | null,
  client: AxiosInstance,
): Promise<{ verdict: TaskVerdict; starttime?: number }> {
  if (!upid) return { verdict: 'none' };
  const node = upidNode(upid);
  if (!node) return { verdict: 'none' };
  try {
    const st = await pve.getTaskStatus(node, upid, client);
    if (st.status === 'running') return { verdict: 'running', starttime: st.starttime };
    if (st.status !== 'stopped') return { verdict: 'unreachable' };
    const ok = !st.exitstatus || st.exitstatus === 'OK' || st.exitstatus.startsWith('WARNINGS');
    return { verdict: ok ? 'ok' : 'failed', starttime: st.starttime };
  } catch (err) {
    if (/no such task|unable to open file|no such file/i.test(pve.pveMessage(err))) return { verdict: 'unknown' };
    return { verdict: 'unreachable' };
  }
}

async function taskVerdict(upid: string | null, client: AxiosInstance): Promise<TaskVerdict> {
  return (await readTask(upid, client)).verdict;
}

/**
 * Task types that leave the guest at a VMID where it is and what it is. Any other
 * task at the VMID since our own (a create, restore, clone, destroy, migration,
 * tunnel, or a type not known here) counts against the proof.
 */
const HARMLESS_TASKS = new Set([
  'qmstart',
  'qmstop',
  'qmshutdown',
  'qmreboot',
  'qmsuspend',
  'qmresume',
  'qmsnapshot',
  'qmconfig',
  'vzstart',
  'vzstop',
  'vzshutdown',
  'vzreboot',
  'vzsnapshot',
  'vncproxy',
  'vncshell',
  'termproxy',
  'vzdump',
]);

/** Allowance for clock differences between nodes when reading task lists. */
const TASK_CLOCK_SLACK_S = 60;

/**
 * Proof that nothing has happened at a VMID since our own task started, from every
 * node's task list. It holds only when, for every node: the token has Sys.Audit on
 * exactly that node's path (without it Proxmox silently lists only the token's own
 * tasks), the node's log reaches back to the restore's start (the restore's own
 * node by listing our task, every other node by holding a task at least that old),
 * the node's list for the VMID could be read in full, and no task other than ours
 * at that VMID is of a type outside HARMLESS_TASKS. Anything that can't be shown
 * counts as no proof: a freshly rebuilt or idle node with no task that old holds.
 */
async function untouchedSince(vmid: number, since: number | undefined, ownUpid: string, client: AxiosInstance): Promise<boolean> {
  const ownNode = upidNode(ownUpid);
  if (!since || !ownNode) return false;
  const from = since - TASK_CLOCK_SLACK_S;
  try {
    const nodes = await pve.getNodes(client);
    if (nodes.length === 0 || !nodes.some((n) => n.node === ownNode)) return false;
    for (const { node } of nodes) {
      const perms = await pve.getPathPermissions(`/nodes/${node}`, client);
      // Proxmox answers privilege => propagate flag; a key present with 0 (a
      // non-propagating grant on the node itself) is still held there.
      if (perms['Sys.Audit'] === undefined) return false;
    }
    for (const { node } of nodes) {
      if (node !== ownNode && !(await pve.taskLogReaches(node, from, client))) return false;
      const tasks = await pve.listVmidTasks(node, vmid, from, client);
      if (tasks === null) return false; // too long to be shown complete
      if (node === ownNode && !tasks.some((t) => t.upid === ownUpid)) return false;
      if (tasks.some((t) => t.upid !== ownUpid && !HARMLESS_TASKS.has(t.type))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Notices already sent per row and reason (per process: a restart may repeat one once). */
const longWaitNoticeSent = new Set<string>();
/** When this process first saw each row waiting for each reason. */
const longWaitFirstSeen = new Map<string, number>();

/**
 * Once a row has waited over a day on something that doesn't clear (a lock, a task
 * that can't be read, a task still running), tell an admin once. The day counts
 * from when this process first saw it waiting for that reason (kept in memory, so
 * a restart starts the count again). The row is still left alone.
 */
async function noticeLongWait(vm: VirtualMachine, reason: string, now: Date): Promise<void> {
  const key = `${vm.id}:${reason}`;
  const first = longWaitFirstSeen.get(key) ?? now.getTime();
  longWaitFirstSeen.set(key, first);
  if (now.getTime() - first <= LOCK_NOTICE_AFTER_MS || longWaitNoticeSent.has(key)) return;
  longWaitNoticeSent.add(key);
  await notify({
    event: 'vm.error',
    title: vm.name,
    message:
      `"${vm.name}" (VMID ${vm.proxmoxVmId} on ${vm.proxmoxNode}) has waited over a day for ProxMate to finish settling ` +
      `it: ${reason}. Check it in Proxmox; ProxMate keeps leaving it alone until that clears.`,
  }).catch(() => undefined);
}

/**
 * Whether something other than the caller holds the row in flight. `own` is how
 * many of its registrations belong to the caller: a pass holds the row while it
 * settles it, and a resumed follower settles it while still holding it (see
 * resumeFollowing), so that one registration doesn't count.
 */
function busyElsewhere(id: string, own = 0): boolean {
  return inFlightCount(id) > own;
}

/** The one in-flight registration a settle holds on its row (a pass's, or a resumed follower's). */
const HELD_BY_PASS = 1;

/** Forget a settled row's long-wait counts. */
function forgetLongWaits(id: string): void {
  for (const key of [...longWaitFirstSeen.keys()]) if (key.startsWith(`${id}:`)) longWaitFirstSeen.delete(key);
  for (const key of [...longWaitNoticeSent]) if (key.startsWith(`${id}:`)) longWaitNoticeSent.delete(key);
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

/** The write condition that the row is still exactly the one this pass read. */
function unchanged(row: VirtualMachine) {
  return { id: row.id, status: row.status, opStartedAt: row.opStartedAt };
}

class RowChanged extends Error {}

/** Conditional update of a row still as read; throws RowChanged when it isn't. */
async function settleRow(row: VirtualMachine, data: Record<string, unknown>, own = 0): Promise<void> {
  if (busyElsewhere(row.id, own)) throw new RowChanged();
  const r = await prisma.virtualMachine.updateMany({ where: unchanged(row), data });
  if (r.count === 0) throw new RowChanged();
  forgetLongWaits(row.id);
}

/** Conditional removal of a row still as read (with its IDE credential rows). */
async function dropRow(row: VirtualMachine, own = 0): Promise<void> {
  if (busyElsewhere(row.id, own)) throw new RowChanged();
  const r = await prisma.virtualMachine.deleteMany({ where: unchanged(row) });
  if (r.count === 0) throw new RowChanged();
  forgetLongWaits(row.id);
  await prisma.ideGuestSecret.deleteMany({ where: { vmId: row.id } }).catch(() => undefined);
  await prisma.ideGatewayToken.deleteMany({ where: { vmId: row.id } }).catch(() => undefined);
}

const holdData = { status: 'error', holdReason: PROVISION_FAILED_MESSAGE, ...OP_SETTLED };

/** The ProxMate tags on a guest other than this row's and its operation's source's. */
function otherMarkers(cfg: Record<string, string>, row: VirtualMachine): string[] {
  const allowed = new Set([guestMarker(row.id)]);
  if (row.opSourceId) {
    allowed.add(row.opKind === 'duplicate' ? guestMarker(row.opSourceId) : templateMarker(row.opSourceId));
  }
  return parsePveTags(cfg['tags']).filter((t) => t.startsWith('proxmate-') && !allowed.has(t));
}

/** Whether another row also references this VMID. */
async function vmidShared(row: VirtualMachine): Promise<boolean> {
  return (await prisma.virtualMachine.count({ where: { proxmoxVmId: row.proxmoxVmId, id: { not: row.id } } })) > 0;
}

/** Whether a Template Store entry references this VMID. */
async function vmidIsTemplate(row: VirtualMachine): Promise<boolean> {
  return (await prisma.template.count({ where: { proxmoxVmId: row.proxmoxVmId } })) > 0;
}

/** Whether a guest's description carries exactly this row's clone nonce on a line of its own. */
function carriesNonce(cfg: Record<string, string>, row: VirtualMachine): boolean {
  const want = cloneNonce(row.id);
  return (cfg['description'] ?? '').split(/\r?\n/).some((l) => l.trim() === want);
}

/**
 * Positive proof that an untagged guest at the VMID is what this row's clone (or
 * rebuild clone) produced: the clone was created with this row's nonce as its
 * description (clones of one template otherwise look alike), the task finished OK,
 * no other row and no Template Store entry has the VMID, the guest carries no
 * ProxMate tag but its source's, it isn't a template, and its name is the row's.
 */
async function claimableClone(row: VirtualMachine, cfg: Record<string, string>, task: TaskVerdict): Promise<boolean> {
  if (task !== 'ok' || cfg['template'] === '1') return false;
  if (!carriesNonce(cfg, row)) return false;
  if (otherMarkers(cfg, row).length > 0) return false;
  const name = kindOf(row) === 'lxc' ? cfg['hostname'] : cfg['name'];
  if (name !== row.name) return false;
  return !(await vmidShared(row)) && !(await vmidIsTemplate(row));
}

/**
 * Settle one `creating` VirtualMachine row. The row is held in flight while it is
 * settled, so an adopt (or anything else that checks) can't start on it half-way;
 * the settle counts that one registration as its own. Exported for tests.
 */
export async function reconcileCreatingVm(
  row: VirtualMachine,
  client: AxiosInstance,
  now: Date = new Date(),
): Promise<ReconcileOutcome> {
  if (busyElsewhere(row.id)) return 'in-flight';
  const done = beginInFlight(row.id);
  try {
    return await reconcileCreatingVmHeld(row, client, now);
  } finally {
    done();
  }
}

async function reconcileCreatingVmHeld(row: VirtualMachine, client: AxiosInstance, now: Date): Promise<ReconcileOutcome> {
  const since = row.opStartedAt ?? row.updatedAt;
  if (tooRecent(since, now)) return 'recent';

  // "Not at the stored node" only means gone when the cluster-wide lookup worked.
  const { vm, synced } = await syncVmNodeChecked(row);
  if (!synced) return 'unreachable';

  const task = await taskVerdict(vm.opUpid, client);
  if (task === 'running') return 'busy';
  if (task === 'unreachable') {
    await noticeLongWait(vm, `its Proxmox task ${vm.opUpid} can't be read`, now);
    return 'unreachable';
  }
  let cfg: Record<string, string> | null;
  try {
    cfg = await guestConfig(vm, client);
  } catch {
    return 'unreachable';
  }
  // A Proxmox lock (create, clone, backup, ...) means Proxmox is still working on it.
  if (cfg?.['lock']) {
    if (now.getTime() - since.getTime() > LOCK_NOTICE_AFTER_MS && !lockNoticeSent.has(vm.id)) {
      lockNoticeSent.add(vm.id);
      await notify({
        event: 'vm.error',
        title: vm.name,
        message:
          `"${vm.name}" (VMID ${vm.proxmoxVmId}) has been held by a Proxmox lock (${cfg['lock']}) for over a day ` +
          'while ProxMate waits to finish creating it. Check it in Proxmox; ProxMate leaves it alone until the lock clears.',
      }).catch(() => undefined);
    }
    return 'busy';
  }

  try {
    return await settleCreatingVm(vm, row, cfg, task, client);
  } catch (err) {
    if (err instanceof RowChanged) return 'in-flight'; // picked up meanwhile — not ours to settle
    throw err;
  }
}

async function settleCreatingVm(
  vm: VirtualMachine,
  row: VirtualMachine,
  cfg: Record<string, string> | null,
  task: TaskVerdict,
  client: AxiosInstance,
): Promise<ReconcileOutcome> {
  const kind = (vm.opKind ?? null) as VmOpKind | null;
  const ours = !!cfg && tagsMarkRow(cfg['tags'], vm.id);
  const rebuild = kind === 'rebuild-iso' || kind === 'rebuild-template';
  const archive = vm.opArchive; // read before the settling write clears it
  const node = vm.proxmoxNode;
  const hasBackups = async () => (await prisma.mateState.count({ where: { vmId: vm.id } })) > 0;

  const done = async (outcome: ReconcileOutcome, what: string, notice?: string) => {
    if (notice) {
      await notify({ event: 'vm.error', title: vm.name, message: notice }).catch(() => undefined);
    }
    await recordAudit({
      action: 'vm.reconcile',
      targetType: 'vm',
      targetId: vm.id,
      detail: `${kind ?? 'operation'} of "${vm.name}" was interrupted by a restart; ${what}`,
    });
    return outcome;
  };
  const failedNotice = `${rebuild ? 'Rebuild' : 'Provisioning'} of "${vm.name}" failed: ${INTERRUPTED}`;
  const hold = async (what: string, notice?: string) => {
    await settleRow(row, holdData, HELD_BY_PASS);
    if (archive) await cleanupUploadedArchive(archive, node, vm.id).catch(() => undefined);
    if (rebuild) await notifyOwnerOfFailedRebuild(vm, true, new Error(INTERRUPTED)).catch(() => undefined);
    return done('held', what, notice ?? failedNotice);
  };
  // In doubt: hold the row, write nothing to the guest, and tell an admin which
  // guest to look at.
  const holdForAdmin = (what: string, advice: string) =>
    hold(
      what,
      `${failedNotice}. The machine is held and guest ${vm.proxmoxVmId} on ${vm.proxmoxNode} was left untouched: ${advice}`,
    );
  const drop = async (what: string) => {
    await dropRow(row, HELD_BY_PASS);
    if (archive) await cleanupUploadedArchive(archive, node, vm.id).catch(() => undefined);
    if (rebuild) await notifyOwnerOfFailedRebuild(vm, false, new Error(INTERRUPTED)).catch(() => undefined);
    return done('dropped', what, kind === 'import' ? undefined : failedNotice);
  };

  // ── Import: isolation first, the tag last. Tagged → every step but the final
  // status write ran; not tagged → the import didn't happen. The guest is never
  // ProxMate's to remove either way.
  if (kind === 'import') {
    if (ours) {
      const current = await requireOurGuest(vm, { client, settlingInterrupted: true });
      const live = await pve.getVmStatus(current.proxmoxNode, current.proxmoxVmId, client, kindOf(current)).catch(() => null);
      const status = live?.status === 'running' || live?.status === 'paused' ? live.status : 'stopped';
      await settleRow(row, { status, ...OP_SETTLED }, HELD_BY_PASS);
      return done('completed', 'its tag was written, so the import was completed');
    }
    return drop('the guest was not tagged yet, so the record was removed and the guest stays importable');
  }

  // ── Our tagged guest whose only remaining step was the isolation firewall.
  if ((kind === 'create' || kind === 'create-lxc' || kind === 'rebuild-iso') && task === 'ok' && ours && cfg!['template'] !== '1') {
    try {
      await completeFirewallOnlyCreate(vm, row, kind, client);
      return done('completed', 'its create task had finished, so it was completed and left stopped');
    } catch (e) {
      if (e instanceof RowChanged) throw e;
      console.warn(`[reconcile] could not finish "${vm.name}": ${pve.pveMessage(e)}`);
      return hold('it could not be completed, so the machine is held');
    }
  }

  // ── No guest at the VMID.
  if (cfg === null) {
    if ((rebuild || kind === null) && (await hasBackups())) {
      return hold('there is no guest at its VMID, but it has backups to restore from; machine held');
    }
    return drop('no guest was created, record removed');
  }

  // ── A guest carrying this row's tag, but part-way through. The tag is the
  // proof: only this row's own operation writes it.
  if (ours) {
    if (kind === 'restore-upload') {
      if (busyElsewhere(row.id, HELD_BY_PASS)) throw new RowChanged();
      await quarantineRestoredGuest(vm, client);
    }
    return hold('machine held');
  }

  // ── A guest that doesn't carry this row's tag.
  if ((kind === 'clone' || kind === 'duplicate' || kind === 'rebuild-template') && (await claimableClone(vm, cfg, task))) {
    if (busyElsewhere(row.id, HELD_BY_PASS)) throw new RowChanged();
    // The finished clone is this row's: tag it so the owner can delete it with its
    // row (a full clone is never left unowned), and hold it — its configuration
    // (cloud-init, sizing, isolation) never ran.
    await client.put(
      `/nodes/${vm.proxmoxNode}/${kindOf(vm)}/${vm.proxmoxVmId}/config`,
      new URLSearchParams({ tags: tagsWithMarker(cfg['tags'], vm.id) }),
    );
    return hold('its clone had finished, so the guest was tagged as its own and the machine held');
  }
  if (kind === 'restore-upload') {
    // Nothing ties an untagged guest to this restore: after an outage the VMID may
    // hold anything (another guest, a template, a cloud-image build). So nothing is
    // written to it; an admin decides.
    const archiveName = archive ? archive.slice(archive.indexOf(':') + 1) : 'the uploaded archive';
    return holdForAdmin(
      'the guest at its VMID is untagged, so it was left untouched; machine held',
      `check guest ${vm.proxmoxVmId}: if it is the interrupted restore of ${archiveName}, adopt it or delete it ` +
        '(it may still have onboot set from the archive); otherwise delete this machine.',
    );
  }
  // Another machine's (or build's, or template's) guest at the VMID — it may have
  // been reused since: nothing is written to it, and the row is dropped unless it
  // has backups hanging off it.
  if (otherMarkers(cfg, vm).length > 0) {
    if ((rebuild || kind === null) && (await hasBackups())) return hold('its VMID holds another guest; machine held');
    return drop("its VMID holds another machine's guest, record removed");
  }
  // Another row (or a Template Store entry) names the same VMID but the guest
  // carries no tag: it may be that row's real guest, so this row is held rather
  // than dropped, and the guest is left alone.
  if ((await vmidShared(vm)) || (await vmidIsTemplate(vm))) {
    return holdForAdmin(
      'another record names its VMID; machine held, guest untouched',
      `another ProxMate record also names VMID ${vm.proxmoxVmId}. Check which machine that guest belongs to, then delete the wrong record.`,
    );
  }
  if (kind === 'create' || kind === 'create-lxc' || kind === 'rebuild-iso') {
    // These creates tag the guest as they make it: an untagged guest isn't theirs.
    if ((rebuild || kind === null) && (await hasBackups())) return hold('its VMID holds an untagged guest; machine held');
    return drop('its VMID holds an untagged guest that is not its own, record removed');
  }
  return holdForAdmin(
    'the guest at its VMID could not be confirmed as its own; it was left untouched, machine held',
    `check guest ${vm.proxmoxVmId}: if it is this machine's interrupted ${kind ?? 'create'}, adopt it; otherwise delete this machine.`,
  );
}

/**
 * An interrupted upload restore's guest, before it is held: drop the archive's
 * onboot/startup/protection and take its NICs down, so Proxmox can't boot it on a
 * node reboot with the archive's network and no isolation.
 */
async function quarantineRestoredGuest(vm: VirtualMachine, client: AxiosInstance): Promise<void> {
  const kind = kindOf(vm);
  try {
    await stripRestoreFlags(vm.proxmoxNode, vm.proxmoxVmId, client, kind);
    const cfg = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, client, kind);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(cfg)) {
      if (/^net\d+$/.test(k) && !/(^|,)link_down=1(,|$)/.test(v)) params.set(k, `${v.replace(/(^|,)link_down=\d/, '')},link_down=1`);
    }
    if ([...params.keys()].length > 0) {
      await client.put(`/nodes/${vm.proxmoxNode}/${kind}/${vm.proxmoxVmId}/config`, params);
    }
  } catch (err) {
    console.warn(`[reconcile] could not keep restored guest ${vm.proxmoxVmId} from booting: ${pve.pveMessage(err)}`);
  }
}

/**
 * The remaining step of an ISO VM, LXC or ISO rebuild whose create task finished:
 * its isolation firewall. Applied on the row's own guest, then the row is left
 * `stopped` (the owner starts it) — exactly what the interrupted create would have
 * written before booting it.
 */
async function completeFirewallOnlyCreate(
  vm: VirtualMachine,
  row: VirtualMachine,
  kind: 'create' | 'create-lxc' | 'rebuild-iso',
  client: AxiosInstance,
): Promise<void> {
  // A rebuild is a repair path, so it may run on a row that was held before it.
  const current = await requireOurGuest(vm, { client, allowError: kind === 'rebuild-iso', settlingInterrupted: true });
  if (busyElsewhere(row.id, HELD_BY_PASS)) throw new RowChanged();
  if ((await getConfig('isolation_enabled')) !== 'false') {
    await pve.configureVmIsolation(
      current.proxmoxNode,
      current.proxmoxVmId,
      await pve.readIsolationOptions(),
      client,
      kindOf(current),
    );
  }
  await settleRow(row, {
    status: 'stopped',
    ...OP_SETTLED,
    // What a finished rebuild clears: its hold, and anything about the old disk.
    ...(kind === 'rebuild-iso'
      ? { holdReason: null, ideState: null, ideStateAt: null, ideFailReason: null, deployState: null, deployStateAt: null, pendingCiPassword: null }
      : {}),
  }, HELD_BY_PASS);
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

  const task = await taskVerdict(ms.upid, client);
  if (task === 'running') return 'busy';
  if (task === 'unreachable') return 'unreachable';
  let cfg: Record<string, string> | null;
  try {
    cfg = await guestConfig(vm, client);
  } catch {
    return 'unreachable';
  }
  if (cfg?.['lock']) return 'busy';

  // The backup itself is untouched by a restore: it is usable again.
  if (isInFlight(ms.id) || isInFlight(ms.vmId)) return 'in-flight';
  const freed = await prisma.mateState.updateMany({ where: { id: ms.id, status: 'restoring' }, data: { status: 'ready', upid: null } });
  if (freed.count === 0) return 'in-flight';

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
  if (!vm.holdReason) {
    await prisma.virtualMachine.updateMany({
      where: { id: vm.id, holdReason: null },
      data: { status: 'error', holdReason: RESTORE_FAILED_MESSAGE },
    });
  }
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
  // A recorded task that can't be read now is not a failed backup: next pass.
  if (task === 'unreachable') return 'unreachable';
  if (task === 'none') {
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
    let lines: string[];
    let backups: pve.PveBackup[];
    try {
      lines = await pve.getTaskLog(node, ms.upid!, client);
      backups = await pve.listBackups(ms.storage, client);
    } catch {
      return 'unreachable';
    }
    const volid = pve.backupVolidFromLog(lines, ms.storage);
    const listed = volid ? backups.find((b) => b.volid === volid && b.vmid === ms.proxmoxVmId) : undefined;
    if (listed) {
      if (isInFlight(ms.id)) return 'in-flight';
      const r = await prisma.mateState.updateMany({
        where: { id: ms.id, status: 'creating' },
        data: { volid: listed.volid, size: BigInt(Math.trunc(listed.size ?? 0)), status: 'ready', upid: null },
      });
      if (r.count === 0) return 'in-flight';
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
  if (isInFlight(ms.id)) return 'in-flight';
  const r = await prisma.mateState.updateMany({ where: { id: ms.id, status: 'creating' }, data: { status: 'error', upid: null } });
  if (r.count === 0) return 'in-flight';
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

/** The operations whose late task is followed after their wait gives up (settleCreateTask). */
const FOLLOW_KINDS: FollowKind[] = ['clone', 'duplicate', 'restore-upload'];

/** How long a resumed follower waits for its task before leaving it to the next pass. */
const RESUME_FOLLOW_MS = 6 * 60 * 60 * 1000;

async function resumeFollowing(vm: VirtualMachine, node: string, upid: string, client: AxiosInstance): Promise<void> {
  // Held in flight from here until the row is settled, so the periodic pass never
  // settles it at the same time; the settle below counts this registration as its own.
  const done = beginInFlight(vm.id);
  try {
    let ended = true;
    await pve.waitForTask(node, upid, client, RESUME_FOLLOW_MS).catch((err) => {
      // Still running when the wait gives up, or the poll failed: the next pass
      // looks again (and resumes following if the task is still running).
      if (!(err instanceof pve.TaskFailedError)) ended = false;
    });
    if (!ended) return;
    const row = await prisma.virtualMachine.findUnique({ where: { id: vm.id } });
    if (row && row.opUpid === upid) await reconcileFollowedRow(row, client, new Date(), { resumed: true });
  } catch (err) {
    console.error(`[reconcile] resumed follower for "${vm.name}" could not settle it:`, err);
  } finally {
    done();
  }
}

/**
 * Settle a row held in `error` while its create task was being followed (see
 * settleCreateTask), when that follower is gone: a restart, its time limit, or a
 * poll error. The row kept its op fields for exactly this. Still running → the
 * follower is resumed. Failed → the archive goes, and the row is dropped when no
 * guest is left. Finished OK → for an upload restore the task's guest is the one at
 * the VMID (a restore never overwrites an existing guest), so it gets the late-task
 * step: no autostart or protection, then the check, which removes it when it fails
 * (the row is then dropped); otherwise the row stays held. A clone is tagged only
 * on its nonce. The op fields are cleared once settled, conditionally. Exported for
 * tests.
 */
export async function reconcileFollowedRow(
  row: VirtualMachine,
  client: AxiosInstance,
  now: Date = new Date(),
  opts: { resumed?: boolean } = {},
): Promise<ReconcileOutcome> {
  // A resumed follower already holds the row; a pass holds it while it settles it.
  // Either way the settle below counts exactly one registration as its own.
  if (opts.resumed) return reconcileFollowedRowHeld(row, client, now, true);
  if (busyElsewhere(row.id)) return 'in-flight';
  const done = beginInFlight(row.id);
  try {
    return await reconcileFollowedRowHeld(row, client, now, false);
  } finally {
    done();
  }
}

async function reconcileFollowedRowHeld(
  row: VirtualMachine,
  client: AxiosInstance,
  now: Date,
  resumed: boolean,
): Promise<ReconcileOutcome> {
  const own = HELD_BY_PASS;
  if (busyElsewhere(row.id, own)) return 'in-flight';
  if (!resumed && tooRecent(row.opStartedAt ?? row.updatedAt, now)) return 'recent';
  const { vm, synced } = await syncVmNodeChecked(row);
  if (!synced) return 'unreachable';
  const upid = vm.opUpid;
  const node = upidNode(upid);

  const { verdict: task, starttime } = await readTask(upid, client);
  if (task === 'unreachable') {
    await noticeLongWait(vm, `its Proxmox task ${upid} can't be read`, now);
    return 'unreachable';
  }
  if (task === 'running' && upid && node) {
    // Resume the follower lost with the restart. The row counts as in flight while
    // it waits; once the task ends the row is settled here, exactly as if it had
    // ended before the restart. If the wait gives up first, the next pass resumes
    // again; a task running for over a day is reported once.
    await noticeLongWait(vm, `its Proxmox task ${upid} is still running`, now);
    void resumeFollowing(vm, node, upid, client);
    return 'busy';
  }
  let cfg: Record<string, string> | null;
  try {
    cfg = await guestConfig(vm, client);
  } catch {
    return 'unreachable';
  }
  if (cfg?.['lock']) {
    await noticeLongWait(vm, `its guest is locked in Proxmox (${cfg['lock']})`, now);
    return 'busy';
  }

  try {
    return await settleFollowedRow(vm, row, cfg, task, starttime, client, own);
  } catch (err) {
    if (err instanceof RowChanged) return 'in-flight';
    throw err;
  }
}

async function settleFollowedRow(
  vm: VirtualMachine,
  row: VirtualMachine,
  cfg: Record<string, string> | null,
  task: TaskVerdict,
  starttime: number | undefined,
  client: AxiosInstance,
  own: number,
): Promise<ReconcileOutcome> {
  const archive = vm.opArchive;
  const cleanArchive = async () => {
    if (archive) await cleanupUploadedArchive(archive, vm.proxmoxNode, vm.id).catch(() => undefined);
  };
  const audit = (what: string) =>
    recordAudit({
      action: 'vm.reconcile',
      targetType: 'vm',
      targetId: vm.id,
      detail: `followed ${vm.opKind ?? 'create'} of "${vm.name}" was settled after its follower ended; ${what}`,
    });
  const tell = (message: string) => notify({ event: 'vm.error', title: vm.name, message }).catch(() => undefined);
  const keepHeld = async (what: string, message?: string) => {
    await settleRow(row, OP_SETTLED, own);
    await cleanArchive();
    if (message) await tell(message);
    await audit(what);
    return 'held' as const;
  };
  const drop = async (what: string) => {
    await dropRow(row, own);
    await cleanArchive();
    await tell(`Provisioning of "${vm.name}" failed: ${INTERRUPTED}`);
    await audit(what);
    return 'dropped' as const;
  };

  if (cfg === null) return drop('no guest is at its VMID, record removed');
  const untouchedNotice = (why: string) =>
    `The ${vm.opKind === 'restore-upload' ? 'restore' : 'create'} of "${vm.name}" ended after ProxMate stopped following ` +
    `it, and ${why}, so the machine is held and guest ${vm.proxmoxVmId} on ${vm.proxmoxNode} was left untouched: check ` +
    'it, adopt it if it is this machine\'s, or delete the machine.';
  if (task === 'unknown') {
    return keepHeld(
      'its task is no longer known to Proxmox; machine held, guest untouched',
      untouchedNotice('Proxmox no longer knows its task'),
    );
  }
  if (task !== 'ok') return keepHeld('its task did not finish OK; machine held, guest untouched');

  if (vm.opKind === 'restore-upload') {
    if (cfg['template'] === '1') {
      return keepHeld(
        'the guest at its VMID is a template; machine held, guest untouched',
        untouchedNotice(`the guest at VMID ${vm.proxmoxVmId} is a Proxmox template`),
      );
    }
    if ((await vmidShared(vm)) || (await vmidIsTemplate(vm))) {
      return keepHeld(
        'another record names its VMID; machine held, guest untouched',
        untouchedNotice(`another ProxMate record also names VMID ${vm.proxmoxVmId}`),
      );
    }
    // A finished restore task proves what was at the VMID then, not now: after an
    // outage the guest may have been deleted and the VMID reused. Only a task list
    // with nothing else at that VMID since the restore started, on every node,
    // shows the guest is still the restore's.
    if (!vm.opUpid || !(await untouchedSince(vm.proxmoxVmId, starttime, vm.opUpid, client))) {
      return keepHeld(
        'nothing proves the guest at its VMID is still the restore\'s; machine held, guest untouched',
        untouchedNotice(
          'ProxMate could not confirm from every node\'s task list that nothing else has used that VMID since ' +
            '(it may still have onboot set from the archive)',
        ),
      );
    }
    if (busyElsewhere(row.id, own)) throw new RowChanged();
    try {
      await stripRestoreFlags(vm.proxmoxNode, vm.proxmoxVmId, client, kindOf(vm)).catch(() => undefined);
      await checkRestoredOrRemove(vm.proxmoxNode, vm.proxmoxVmId, kindOf(vm), client);
    } catch (err) {
      if ((err as { guestRemoved?: boolean }).guestRemoved) {
        return drop('the restored guest failed the check and was removed, record removed');
      }
      return keepHeld(
        'the restored guest failed the check but could not be removed; machine held',
        `The restored guest ${vm.proxmoxVmId} on ${vm.proxmoxNode} of "${vm.name}" failed ProxMate's check and could ` +
          `not be removed (${pve.pveMessage(err)}). Delete it in Proxmox.`,
      );
    }
    return keepHeld(
      'the restored guest passed the check and was kept from starting on its own; machine held',
      `The restore of "${vm.name}" finished after ProxMate stopped following it. Guest ${vm.proxmoxVmId} on ` +
        `${vm.proxmoxNode} passed the check and won't start on its own. The machine is held and no longer being ` +
        'worked on: adopt it under Unconfirmed machines to finish setting it up, or delete it.',
    );
  }

  if (!tagsMarkRow(cfg['tags'], vm.id) && (await claimableClone(vm, cfg, task))) {
    if (busyElsewhere(row.id, own)) throw new RowChanged();
    await client.put(
      `/nodes/${vm.proxmoxNode}/${kindOf(vm)}/${vm.proxmoxVmId}/config`,
      new URLSearchParams({ tags: tagsWithMarker(cfg['tags'], vm.id) }),
    );
    return keepHeld('its clone had finished, so the guest was tagged as its own; machine held');
  }
  return keepHeld('machine held, guest untouched');
}

/**
 * One reconcile pass over every row an interrupted operation may have left
 * behind. Cheap when there is nothing to do (a few indexed queries). Each row is
 * settled on its own; one that errors is left for the next pass.
 */
export async function reconcileStuckOperations(now: Date = new Date()): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, completed: 0, held: 0, dropped: 0, failed: 0, deferred: 0 };
  const [vms, followed, states] = await Promise.all([
    prisma.virtualMachine.findMany({ where: { status: 'creating' } }),
    // Held while a create task was followed; still carrying that task's op fields.
    prisma.virtualMachine.findMany({
      where: {
        status: 'error',
        holdReason: PROVISION_FAILED_MESSAGE,
        opUpid: { not: null },
        opKind: { in: FOLLOW_KINDS },
      },
    }),
    prisma.mateState.findMany({ where: { status: { in: ['creating', 'restoring'] } } }),
  ]);
  if (vms.length === 0 && followed.length === 0 && states.length === 0) return summary;

  let client: AxiosInstance;
  try {
    client = await pve.getClient();
  } catch {
    summary.deferred = vms.length + followed.length + states.length; // Proxmox unreachable — next pass
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
  for (const vm of followed) {
    try {
      count(await reconcileFollowedRow(vm, client, now));
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
