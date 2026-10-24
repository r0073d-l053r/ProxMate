import crypto from 'node:crypto';
import type { User, VirtualMachine, Template } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { encrypt } from '../lib/crypto.js';
import { isAccessExpired } from './access.service.js';
import { getConfig } from './config.service.js';
import { notify } from './notify.service.js';
import { isMailConfigured, sendMail } from './mail.service.js';
import { vmMaintenanceEmail, vmRebuildFailedEmail } from '../lib/email-templates.js';
import * as pve from './proxmox.service.js';
import { getOfferedFeatureIds, getBaseFeatureIds } from './template.service.js';
import { isValidPublicKey } from './ssh-key.service.js';
import { diskSizeGb } from './disk.service.js';
import { guestConfigSizes, pciLines, foreignVolumeKeys, hostLevelKeys } from '../lib/guest-config.js';
import { recordAudit } from './audit.service.js';
import { beginInFlight, isInFlight, runInFlight } from '../lib/in-flight.js';
import { recordCreateFailure } from '../lib/create-failures.js';
import { autoSnapshotBefore, type AutoSnapshotResult } from './auto-snapshot.service.js';
import { tagsForAccess } from './project.service.js';
import { ALL_CAPS, CAPS_BY_ROLE, normalizeShareRole, type ShareRole, type VmCap } from './vm-share.service.js';

/** The Proxmox guest kind for a VM row (defaults to QEMU for legacy/unset rows). */
export const kindOf = (vm: { type?: string | null }): pve.GuestKind => (vm.type === 'lxc' ? 'lxc' : 'qemu');

/** Flag a VM as failed in the DB and fire a best-effort vm.error notification. */
export async function markVmError(
  vmId: string,
  name: string,
  err: unknown,
  opts: { keepOp?: boolean } = {},
): Promise<void> {
  // Held as well: a guest whose provisioning didn't finish never got its isolation
  // or sizing applied, so nothing may start it (see requireOurGuest). A row whose
  // create task is still being followed keeps its op fields, so the restart
  // reconciler can finish settling it if the follower is lost.
  await prisma.virtualMachine.update({
    where: { id: vmId },
    data: { status: 'error', holdReason: PROVISION_FAILED_MESSAGE, ...(opts.keepOp ? {} : OP_SETTLED) },
  });
  await notify({
    event: 'vm.error',
    title: name,
    message: `Provisioning of "${name}" failed: ${pve.pveMessage(err)}`,
  }).catch(() => undefined);
}

/** Clears the record of a `creating` row's operation once the row has settled. */
export const OP_SETTLED = { opKind: null, opStartedAt: null, opUpid: null, opSourceId: null, opArchive: null } as const;

/** The operations that leave a row in `creating` (stored on `opKind`). */
export type VmOpKind =
  | 'create'
  | 'create-lxc'
  | 'clone'
  | 'duplicate'
  | 'restore-upload'
  | 'rebuild-iso'
  | 'rebuild-template'
  | 'import';

/**
 * The description a clone made for a row is created with. A clone copies its
 * source's tags, so after a restart only this proves that the guest at the VMID is
 * the one this row's clone produced (see task-reconcile.service.ts).
 */
export function cloneNonce(vmId: string): string {
  return `proxmate-row:${vmId}`;
}

/**
 * Record the Proxmox task now driving a `creating` row, so a restart that loses
 * the wait can still read the task's outcome. Best-effort: without it the
 * reconciler falls back to what is at the VMID.
 */
export async function recordOpTask(vmId: string, upid: string): Promise<void> {
  await (async () => prisma.virtualMachine.update({ where: { id: vmId }, data: { opUpid: upid } }))().catch(
    () => undefined,
  );
}

// ─── Guest identity ───────────────────────────────────────────
//
// A row's `proxmoxVmId` comes from /cluster/nextid, and Proxmox hands a freed VMID
// to the next guest anyone creates. So "the guest at this VMID" is not proof that
// it is the guest ProxMate made for this row. Every guest ProxMate creates carries
// a Proxmox tag naming its row (`proxmate-<row id>`), and every path that changes a
// guest or hands over control of it goes through requireOurGuest first. Guests
// created before the marker existed are tagged once at startup by
// backfillGuestMarkers; at runtime an untagged guest is never treated as ours.

const MARKER_PREFIX = 'proxmate-';

/** The Proxmox tag that ties a guest to its VirtualMachine row. */
export function guestMarker(vmId: string): string {
  return `${MARKER_PREFIX}${vmId.toLowerCase()}`;
}

export function parsePveTags(raw: string | undefined): string[] {
  return (raw ?? '').split(/[;,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/**
 * The Proxmox tag on a template ProxMate built or registered. It shares the
 * `proxmate-` prefix, so to every machine row such a guest reads as another's.
 */
export function templateMarker(templateId: string): string {
  return `${MARKER_PREFIX}template-${templateId.toLowerCase()}`;
}

/** Whether a Proxmox tag list carries this template's marker. */
export function tagsMarkTemplate(raw: string | undefined, templateId: string): boolean {
  return parsePveTags(raw).includes(templateMarker(templateId));
}

/** Tag a registered template's Proxmox guest with its template marker (replacing any other ProxMate tag). */
export async function markTemplateGuest(
  template: { id: string; proxmoxNode: string; proxmoxVmId: number },
  client?: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<void> {
  const c = client ?? (await pve.getClient());
  const cfg = await pve.getVmConfig(template.proxmoxNode, template.proxmoxVmId, c);
  const tags = parsePveTags(cfg['tags']);
  if (tags.includes(templateMarker(template.id))) return;
  const keep = tags.filter((t) => !t.startsWith(MARKER_PREFIX));
  await c.put(
    `/nodes/${template.proxmoxNode}/qemu/${template.proxmoxVmId}/config`,
    new URLSearchParams({ tags: [...keep, templateMarker(template.id)].join(';') }),
  );
}

/**
 * Whether the guest at a template's VMID is still that template: `ours` when it
 * carries the template's marker, `absent` when there is no guest there, `other`
 * otherwise (untagged, or another template's or machine's). A VMID is reused once
 * its guest is gone, so only `ours` may ever be deleted as the template.
 */
export async function templateGuestIdentity(
  template: { id: string; proxmoxNode: string; proxmoxVmId: number },
  client?: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<'ours' | 'absent' | 'other'> {
  const c = client ?? (await pve.getClient());
  let cfg: Record<string, string>;
  try {
    cfg = await pve.getVmConfig(template.proxmoxNode, template.proxmoxVmId, c);
  } catch (err) {
    if (/does not exist|not found|no such/i.test(pve.pveMessage(err))) return 'absent';
    throw err;
  }
  return parsePveTags(cfg['tags']).includes(templateMarker(template.id)) ? 'ours' : 'other';
}

/** Whether a Proxmox tag list carries any ProxMate marker (a machine row's or a template's). */
export function hasProxmateTag(raw: string | undefined): boolean {
  return parsePveTags(raw).some((t) => t.startsWith(MARKER_PREFIX));
}

/** Whether a Proxmox tag list (config `tags` or a /cluster/resources entry's) carries this row's marker. */
export function tagsMarkRow(raw: string | undefined, vmId: string): boolean {
  return parsePveTags(raw).includes(guestMarker(vmId));
}

/** A guest's tag list with this row's marker set (and any other row's marker dropped). */
export function tagsWithMarker(raw: string | undefined, vmId: string): string {
  const keep = parsePveTags(raw).filter((t) => !t.startsWith(MARKER_PREFIX));
  return [...keep, guestMarker(vmId)].join(';');
}

/** Write this row's marker onto its guest, keeping the guest's other tags. */
export async function writeGuestMarker(
  vm: Pick<VirtualMachine, 'id' | 'proxmoxNode' | 'proxmoxVmId' | 'type'>,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  currentTags?: string,
): Promise<void> {
  await client.put(
    `/nodes/${vm.proxmoxNode}/${kindOf(vm)}/${vm.proxmoxVmId}/config`,
    new URLSearchParams({ tags: tagsWithMarker(currentTags, vm.id) }),
  );
}

/**
 * Set this row's marker on a guest ProxMate has just produced at the row's VMID —
 * a fresh clone, a restore, or a snapshot rollback — replacing whatever tags the
 * source config carried.
 */
export async function markClonedGuest(
  vm: Pick<VirtualMachine, 'id' | 'proxmoxNode' | 'proxmoxVmId' | 'type'>,
  client?: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<void> {
  const c = client ?? (await pve.getClient());
  const cfg = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, c, kindOf(vm));
  await writeGuestMarker(vm, c, cfg['tags']);
}

/**
 * The guest at a row's VMID, as ProxMate sees it:
 * - 'ours': it carries this row's marker;
 * - 'absent': there is no guest at that VMID;
 * - 'foreign': it carries another row's marker;
 * - 'unmarked': it carries no ProxMate marker, so nothing ties it to this row.
 * Throws when Proxmox can't be asked (so callers fail closed).
 */
export async function guestIdentity(
  vm: VirtualMachine,
  client?: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<'ours' | 'absent' | 'foreign' | 'unmarked'> {
  const c = client ?? (await pve.getClient());
  let cfg: Record<string, string>;
  try {
    cfg = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, c, kindOf(vm));
  } catch (err) {
    if (/does not exist|not found/i.test(pve.pveMessage(err))) return 'absent';
    throw err;
  }
  const tags = parsePveTags(cfg['tags']);
  if (tags.includes(guestMarker(vm.id))) return 'ours';
  return tags.some((t) => t.startsWith(MARKER_PREFIX)) ? 'foreign' : 'unmarked';
}

/** Thrown when a row's VMID does not (demonstrably) hold the guest ProxMate created for it. */
export class GuestIdentityError extends Error {
  constructor(public readonly identity: 'absent' | 'foreign' | 'unmarked' | 'ours' = 'foreign') {
    super(
      identity === 'ours'
        ? "This machine's guest is confirmed as its own — delete it normally instead of removing only the record."
        : identity === 'unmarked'
        ? "This VM predates ProxMate's ownership tags — ask an admin."
        : identity === 'absent'
          ? "There is no Proxmox guest at this machine's VMID any more. Delete this machine or ask an admin to check it."
          : "The Proxmox guest at this machine's VMID is not the one ProxMate created for it, so it was left untouched. " +
            'Delete this machine (only its record is removed) or ask an admin to check it.',
    );
    this.name = 'GuestIdentityError';
  }
}

/** Refuse unless the row's guest is demonstrably ours (or, with `allowAbsent`, gone). */
export async function assertGuestIsOurs(
  vm: VirtualMachine,
  opts: { allowAbsent?: boolean; client?: Awaited<ReturnType<typeof pve.getClient>> } = {},
): Promise<void> {
  const identity = await guestIdentity(vm, opts.client);
  if (identity === 'ours' || (identity === 'absent' && opts.allowAbsent)) return;
  throw new GuestIdentityError(identity);
}

/**
 * THE gate for every path that changes a guest or hands over control of it:
 * re-resolve the guest's node, then refuse unless it carries this row's marker.
 * Returns the synced row, which callers must use from then on.
 */
export async function requireOurGuest(
  vm: VirtualMachine,
  opts: {
    allowAbsent?: boolean;
    /** A repair or teardown path (stop, restore, rebuild, disk removal, device detach) — allowed on an `error` row. */
    allowError?: boolean;
    /**
     * Only the restart reconciler, settling a `creating` row whose operation is no
     * longer running anywhere (see task-reconcile.service.ts).
     */
    settlingInterrupted?: boolean;
    client?: Awaited<ReturnType<typeof pve.getClient>>;
  } = {},
): Promise<VirtualMachine> {
  // A row still being created (a create, import or rebuild in flight) belongs to
  // that create until it settles: nothing else may build into, change or start its
  // guest meanwhile. It can be deleted.
  if (vm.status === 'creating' && !opts.settlingInterrupted) throw new GuestErroredError(STILL_CREATING_MESSAGE);
  if (!opts.allowError) assertNotErrored(vm);
  const current = await syncVmNode(vm);
  await assertGuestIsOurs(current, opts);
  return current;
}

/** Why an action on a row in `creating` is refused. */
export const STILL_CREATING_MESSAGE =
  'This machine is still being created. It can be changed, or deleted, once it has finished or failed.';

/** holdReason of a row whose create, clone, upload restore or rebuild didn't finish. */
export const PROVISION_FAILED_MESSAGE =
  "This machine's provisioning didn't finish, so it can't be started. Delete it, restore a backup or rebuild it — or ask an admin to check it.";

/** Thrown for anything but repair or delete on a held row (or one in `error`). */
export class GuestErroredError extends Error {
  constructor(detail?: string | null) {
    super(
      detail ||
        "This machine is in an error state. It can only be deleted, restored from a backup, or rebuilt — or ask an admin to check it.",
    );
    this.name = 'GuestErroredError';
  }
}

/**
 * A row ProxMate left in `error` — a create, clone or restore that didn't finish,
 * or a restore that left it over quota — holds a guest that never got (or lost)
 * the isolation, sizing and device checks a guest needs before it may run. So
 * nothing may start it, open its console or install into it until a repair path
 * (restore, rebuild, admin adoption) has put it right. Callers pass the row as
 * loaded for this request.
 */
function assertNotErrored(vm: VirtualMachine): void {
  if (vm.holdReason || vm.status === 'error') throw new GuestErroredError(vm.holdReason);
}

/**
 * Whether a row's status must be left alone by status syncs and power actions:
 * a held row (or one in `error`) keeps its state until a repair path clears it,
 * so viewing or stopping it never makes it startable again.
 */
export function isHeld(vm: Pick<VirtualMachine, 'status' | 'holdReason'>): boolean {
  return !!vm.holdReason || vm.status === 'error';
}

/**
 * Read-only counterpart of requireOurGuest: the synced row when its guest is ours,
 * else null — for listings and stats, which show nothing rather than another
 * guest's data.
 */
export async function ourGuestOrNull(vm: VirtualMachine): Promise<VirtualMachine | null> {
  const current = await syncVmNode(vm);
  return (await guestIdentity(current)) === 'ours' ? current : null;
}

/**
 * One-time, idempotent startup pass that tags guests created before the marker
 * existed. A guest is tagged for a row only when nothing else could claim it:
 * exactly one row references its VMID, that row is not `error`/`creating` (a
 * failed create's VMID may since have gone to someone else), the guest carries no
 * ProxMate marker yet, and its Proxmox name equals the row's. Every row still
 * without a marked guest afterwards is logged for an admin to check — those rows
 * are refused by requireOurGuest until an admin sorts them out.
 */
export async function backfillGuestMarkers(): Promise<{
  tagged: number;
  unmatched: Array<{ id: string; name: string; proxmoxVmId: number }>;
  /** Proxmox calls that failed; a run is only complete when this is 0. */
  errors: number;
}> {
  const client = await pve.getClient();
  const [rows, res, templates] = await Promise.all([
    prisma.virtualMachine.findMany(),
    client.get<{ data: Array<{ type: string; vmid?: number; node?: string; name?: string; tags?: string; template?: number }> }>(
      '/cluster/resources?type=vm',
    ),
    prisma.template.findMany({ select: { id: true, proxmoxVmId: true, proxmoxNode: true } }),
  ]);
  const templateVmids = new Set(templates.map((t) => t.proxmoxVmId));
  const guests = new Map<number, { node?: string; name?: string; tags?: string; template?: number }>();
  for (const r of res.data.data) {
    if ((r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined) guests.set(r.vmid, r);
  }
  const rowsByVmid = new Map<number, VirtualMachine[]>();
  for (const row of rows) rowsByVmid.set(row.proxmoxVmId, [...(rowsByVmid.get(row.proxmoxVmId) ?? []), row]);

  let tagged = 0;
  let errors = 0;
  const unmatched: Array<{ id: string; name: string; proxmoxVmId: number }> = [];

  // Store templates get their own tag, so they read as "another's" to every row.
  for (const t of templates) {
    const guest = guests.get(t.proxmoxVmId);
    if (!guest?.node || parsePveTags(guest.tags).includes(templateMarker(t.id))) continue;
    try {
      await markTemplateGuest({ ...t, proxmoxNode: guest.node }, client);
    } catch (err) {
      errors += 1;
      console.warn(`[vm] could not tag template guest ${t.proxmoxVmId}: ${pve.pveMessage(err)}`);
    }
  }
  for (const row of rows) {
    const guest = guests.get(row.proxmoxVmId);
    if (guest && tagsMarkRow(guest.tags, row.id)) continue;
    const candidate =
      guest &&
      guest.node &&
      (guest.template ?? 0) !== 1 &&
      !templateVmids.has(row.proxmoxVmId) &&
      rowsByVmid.get(row.proxmoxVmId)!.length === 1 &&
      row.status !== 'error' &&
      row.status !== 'creating';
    if (candidate) {
      try {
        // Decide on the guest's own config (the resource listing may omit tags),
        // and write back its existing tags alongside the marker.
        const at = { ...row, proxmoxNode: guest.node! };
        const cfg = await pve.getVmConfig(at.proxmoxNode, at.proxmoxVmId, client, kindOf(at));
        const tags = parsePveTags(cfg['tags']);
        if (tags.includes(guestMarker(row.id))) continue;
        const name = kindOf(at) === 'lxc' ? cfg['hostname'] : cfg['name'];
        if (cfg['template'] !== '1' && !tags.some((t) => t.startsWith(MARKER_PREFIX)) && name === row.name) {
          await writeGuestMarker(at, client, cfg['tags']);
          tagged += 1;
          continue;
        }
      } catch (err) {
        errors += 1;
        console.warn(`[vm] could not tag guest ${row.proxmoxVmId} for "${row.name}": ${pve.pveMessage(err)}`);
      }
    }
    unmatched.push({ id: row.id, name: row.name, proxmoxVmId: row.proxmoxVmId });
  }
  if (unmatched.length > 0) {
    console.warn(
      `[vm] ${unmatched.length} machine(s) have no Proxmox guest carrying their ProxMate tag; actions on them are ` +
        'refused until an admin checks them: ' +
        unmatched.map((u) => `"${u.name}" (row ${u.id}, vmid ${u.proxmoxVmId})`).join(', '),
    );
  }
  return { tagged, unmatched, errors };
}

let markerBackfillComplete = false;

/**
 * The scheduled form of backfillGuestMarkers: runs (at boot and then on the
 * scheduler's tick) until one pass completes without a Proxmox error, then stops —
 * a cluster that was unreachable or a guest that couldn't be read at boot must not
 * leave its rows permanently refused. Idempotent either way.
 */
export async function runGuestMarkerBackfill(): Promise<{ ran: boolean; tagged?: number; unmatched?: number; errors?: number }> {
  if (markerBackfillComplete) return { ran: false };
  const r = await backfillGuestMarkers();
  if (r.errors === 0) {
    markerBackfillComplete = true;
    // The pass is final, so these rows stay refused until an admin settles each
    // one. Said once per completed pass (passes stop after that), not per tick.
    if (r.unmatched.length > 0) {
      await notify({
        event: 'vm.error',
        title: `${r.unmatched.length} machine(s) could not be matched to their Proxmox guest`,
        message:
          'These machines are refused (start, console, delete, backups) until an admin adopts the guest or removes the row. ' +
          'Review them in Settings → Maintenance → Unconfirmed machines.',
      }).catch(() => undefined);
    }
  }
  return { ran: true, tagged: r.tagged, unmatched: r.unmatched.length, errors: r.errors };
}

/** Test hook: forget that a backfill pass has completed. */
export function resetGuestMarkerBackfill(): void {
  markerBackfillComplete = false;
}

/**
 * Rows whose VMID does not hold a guest carrying their ProxMate tag — the machines
 * every action refuses until an admin adopts the guest or removes the row. Read
 * from one /cluster/resources listing (no per-guest calls).
 */
export async function listUnmatchedVms(): Promise<
  Array<{
    id: string;
    name: string;
    userId: string;
    status: string;
    proxmoxVmId: number;
    proxmoxNode: string;
    guest: { present: boolean; name: string | null; taggedForAnotherRow: boolean; isTemplate: boolean };
    sharedVmid: boolean;
    /** The VMID belongs to a Template Store entry. */
    templateRow: boolean;
  }>
> {
  const client = await pve.getClient();
  const [rows, res, templates] = await Promise.all([
    prisma.virtualMachine.findMany({ orderBy: { name: 'asc' } }),
    client.get<{ data: Array<{ type: string; vmid?: number; name?: string; tags?: string; template?: number }> }>(
      '/cluster/resources?type=vm',
    ),
    prisma.template.findMany({ select: { proxmoxVmId: true } }),
  ]);
  const templateVmids = new Set(templates.map((t) => t.proxmoxVmId));
  const guests = new Map<number, { name?: string; tags?: string; template?: number }>();
  for (const r of res.data.data) {
    if ((r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined) guests.set(r.vmid, r);
  }
  const count = new Map<number, number>();
  for (const row of rows) count.set(row.proxmoxVmId, (count.get(row.proxmoxVmId) ?? 0) + 1);
  return rows
    .filter((row) => !tagsMarkRow(guests.get(row.proxmoxVmId)?.tags, row.id))
    .map((row) => {
      const g = guests.get(row.proxmoxVmId);
      return {
        id: row.id,
        name: row.name,
        userId: row.userId,
        status: row.status,
        proxmoxVmId: row.proxmoxVmId,
        proxmoxNode: row.proxmoxNode,
        guest: {
          present: Boolean(g),
          name: g?.name ?? null,
          taggedForAnotherRow: parsePveTags(g?.tags).some((t) => t.startsWith(MARKER_PREFIX)),
          isTemplate: (g?.template ?? 0) === 1,
        },
        sharedVmid: (count.get(row.proxmoxVmId) ?? 0) > 1,
        templateRow: templateVmids.has(row.proxmoxVmId),
      };
    });
}

/** Thrown when an admin adoption can't be done safely. */
export class AdoptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdoptError';
  }
}

/**
 * Admin: declare the guest at a row's VMID to be that row's by writing its tag.
 * Refused when the guest already carries another row's tag, when another row also
 * references the VMID (the choice would be a guess), or when there is no guest.
 */
export async function adoptGuest(vm: VirtualMachine): Promise<VirtualMachine> {
  // Refused while a create, restore, follower or the restart reconciler is working
  // on the row; otherwise the adopt itself holds the row in flight from start to
  // finish, so none of those can start on it (or settle it) half-way through.
  if (isInFlight(vm.id)) {
    throw new AdoptError('This machine is still being worked on (a create or restore is finishing). Try again once it has settled.');
  }
  const done = beginInFlight(vm.id);
  try {
    return await adoptGuestHeld(vm);
  } finally {
    done();
  }
}

async function adoptGuestHeld(vm: VirtualMachine): Promise<VirtualMachine> {
  const others = await prisma.virtualMachine.count({ where: { proxmoxVmId: vm.proxmoxVmId, id: { not: vm.id } } });
  if (others > 0) throw new AdoptError('Another machine also references this VMID — remove the wrong row first.');
  // A template is shared by everyone who deploys from it; it is never one tenant's machine.
  if ((await prisma.template.count({ where: { proxmoxVmId: vm.proxmoxVmId } })) > 0) {
    throw new AdoptError('This VMID belongs to a Template Store entry, not a machine.');
  }
  const { vm: current, synced } = await syncVmNodeChecked(vm);
  const client = await pve.getClient();
  const identity = await guestIdentity(current, client);
  if (identity === 'ours') {
    const fromUpload = isUploadRestoreRow(current);
    if (current.holdReason !== QUOTA_HOLD_MESSAGE && isHeld(current)) {
      // Never lift a hold while the guest still references a volume that isn't its
      // own: that is what a foreign-volume hold is about, and a guest whose
      // provisioning didn't finish was never checked.
      const cfg = await pve.getVmConfig(current.proxmoxNode, current.proxmoxVmId, client, kindOf(current));
      const foreign = foreignVolumeKeys(cfg, current.proxmoxVmId);
      if (foreign.length > 0) {
        throw new AdoptError(
          `The guest still references disks that aren't its own (${foreign.join(', ')}). Detach them in Proxmox first.`,
        );
      }
      await assertAdoptableConfig(current, client, fromUpload ? 'upload' : 'tenant');
    }
    return clearAdoptedHold(current, { fromRestore: fromUpload });
  }
  if (identity === 'absent') {
    throw new AdoptError(
      synced ? 'There is no Proxmox guest at this VMID to adopt.' : "Couldn't reach the cluster to find this guest — try again.",
    );
  }
  if (identity === 'foreign') throw new AdoptError("The guest at this VMID carries another machine's ProxMate tag.");
  const cfg = await pve.getVmConfig(current.proxmoxNode, current.proxmoxVmId, client, kindOf(current));
  if (cfg['template'] === '1') throw new AdoptError('The guest at this VMID is a Proxmox template, not a machine.');
  const foreign = foreignVolumeKeys(cfg, current.proxmoxVmId);
  if (foreign.length > 0) {
    throw new AdoptError(`The guest references disks that aren't its own (${foreign.join(', ')}). Detach them in Proxmox first.`);
  }
  // Untagged: nothing says where its config came from, so the strictest list applies.
  await assertAdoptableConfig(current, client, 'upload');
  await markClonedGuest(current, client);
  // The guest has just been checked (own volumes only) and tagged, so a row held or
  // left in `error` (a 1.0.x create that failed, a guest that only lacked its tag)
  // is settled here too — adopting it once is enough to make it startable.
  return clearAdoptedHold(current, { fromRestore: true });
}

/** The `os` label of a machine restored from an uploaded backup. */
export const UPLOAD_RESTORE_OS = 'Restored backup';

/** Whether a row was created by restoring an uploaded backup (its config came from a tenant's archive). */
export function isUploadRestoreRow(vm: Pick<VirtualMachine, 'os' | 'description'>): boolean {
  return vm.os === UPLOAD_RESTORE_OS || !!vm.description?.startsWith('Restored from uploaded backup');
}

/**
 * Before an adopt tags a guest or lifts a hold, check its config, pending changes
 * and snapshots. `upload`: a restore of an uploaded backup, or a guest with no tag
 * (nothing says where its config came from) — the upload-archive allowlist, as
 * after a restore. `tenant`: any other machine of ours — the rollback policy, i.e.
 * no host-level key (hostLevelKeys) and no volume that isn't its own, so a machine
 * made from a template keeps devices such as rng0, a spice usbN, audio0 or
 * watchdog. PCI devices approved for this machine are allowed either way. Refused
 * with the keys named.
 */
async function assertAdoptableConfig(
  current: VirtualMachine,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  policy: 'upload' | 'tenant',
): Promise<void> {
  const approved = new Set(await approvedPciLines(current, client));
  const isApprovedPci = (key: string, value: string) => /^hostpci\d+$/.test(key) && approved.has(value);
  const refuse = (what: string) =>
    new AdoptError(`The guest carries settings a tenant's machine may not have (${what}). Remove them in Proxmox first, then adopt again.`);
  if (policy === 'upload') {
    // Loaded lazily: restore-upload.service imports this module.
    const { assertRestoredGuestConfig, RestoredConfigError } = await import('./restore-upload.service.js');
    try {
      await assertRestoredGuestConfig(current.proxmoxNode, current.proxmoxVmId, kindOf(current), client, {
        allowSnapshots: true,
        allowKey: isApprovedPci,
      });
    } catch (err) {
      if (err instanceof RestoredConfigError) throw refuse(err.problem);
      throw err;
    }
    return;
  }
  const kind = kindOf(current);
  const base = `/nodes/${current.proxmoxNode}/${kind}/${current.proxmoxVmId}`;
  const asText = (cfg: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(cfg ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>;
  const bad = (cfg: Record<string, string>) => [
    ...hostLevelKeys(cfg, kind).filter((k) => !isApprovedPci(k, cfg[k] ?? '')),
    ...foreignVolumeKeys(cfg, current.proxmoxVmId),
  ];
  const [cfgRes, pendingRes, snapRes] = await Promise.all([
    client.get<{ data: Record<string, unknown> }>(`${base}/config`),
    client.get<{ data: Array<{ key: string; pending?: unknown; delete?: number }> }>(`${base}/pending`),
    client.get<{ data: Array<{ name: string }> }>(`${base}/snapshot`),
  ]);
  const problems = bad(asText(cfgRes.data.data)).map((k) => `"${k}"`);
  const pending = (pendingRes.data.data ?? []).filter((e) => e.pending !== undefined || e.delete).map((e) => `"${e.key}"`);
  if (pending.length > 0) problems.push(`pending changes to ${pending.join(', ')}`);
  for (const { name } of (snapRes.data.data ?? []).filter((x) => x.name !== 'current')) {
    const snap = await client.get<{ data: Record<string, unknown> }>(`${base}/snapshot/${encodeURIComponent(name)}/config`);
    for (const k of bad(asText(snap.data.data))) problems.push(`"${k}" in snapshot "${name}"`);
  }
  if (problems.length > 0) throw refuse(problems.join(', '));
}

/**
 * The hold handling of an admin's adopt, once the guest is confirmed (or made)
 * the row's own and holds only its own volumes. An over-quota hold lifts only once
 * the row fits again (e.g. after the admin raised the owner's quota); any other
 * hold is the admin's call — they have checked the guest — and is cleared once
 * the guest has been made safe to run.
 */
async function clearAdoptedHold(
  current: VirtualMachine,
  opts: { fromRestore?: boolean } = {},
): Promise<VirtualMachine> {
  if (current.holdReason === QUOTA_HOLD_MESSAGE) {
    if (await withQuotaLock(current.userId, () => liftQuotaHoldIfFits(current.id))) {
      return (await prisma.virtualMachine.findUnique({ where: { id: current.id } })) ?? current;
    }
    return current;
  }
  if (isHeld(current)) {
    // The guest may never have been made safe (a 1.0.x create that failed part-way,
    // a restore that stopped early): before it can run, put it on the network
    // placement and isolation it should have now and re-read its sizes into the row
    // under the owner's quota, exactly as a restore does. Any failure keeps the hold.
    const client = await pve.getClient();
    try {
      if (opts.fromRestore) {
        // A guest whose config came from an uploaded archive (or that has no tag to
        // say otherwise): drop autostart/protection and the archive's guest firewall
        // before ProxMate's isolation is written. Loaded lazily (import cycle).
        const { stripRestoreFlags } = await import('./restore-upload.service.js');
        await stripRestoreFlags(current.proxmoxNode, current.proxmoxVmId, client, kindOf(current));
        await pve.resetRestoredFirewall(current.proxmoxNode, current.proxmoxVmId, client, kindOf(current));
      }
      // Loaded lazily: matestate.service imports this module.
      const { reapplyIsolation } = await import('./matestate.service.js');
      await reapplyIsolation(current, client);
      // A held restore may have had its NICs taken down (neutraliseRestoredGuest);
      // the checks above passed, so they come back up.
      await pve.clearLinkDown(current.proxmoxNode, current.proxmoxVmId, client, kindOf(current));
      await syncRestoredGuest(current, { approvedPci: await approvedPciLines(current, client), client });
    } catch (err) {
      if (err instanceof QuotaError) {
        // syncRestoredGuest has put the row on the over-quota hold.
        throw new AdoptError(
          "The guest is adopted, but its disks exceed the owner's quota, so it stays held. Raise the quota, then adopt again.",
        );
      }
      throw new AdoptError(`The guest couldn't be made safe to run, so it stays held: ${pve.pveMessage(err)}`);
    }
    // Settled by the admin: whatever task the row still named is done with.
    return prisma.virtualMachine.update({
      where: { id: current.id },
      data: { status: 'stopped', holdReason: null, ...OP_SETTLED },
    });
  }
  return current;
}

/** Delete a row together with the IDE credential rows keyed by its id (no relation, so no cascade). */
export async function deleteVmRow(vmId: string): Promise<void> {
  await prisma.$transaction([
    prisma.virtualMachine.delete({ where: { id: vmId } }),
    prisma.ideGuestSecret.deleteMany({ where: { vmId } }),
    prisma.ideGatewayToken.deleteMany({ where: { vmId } }),
  ]);
}

/**
 * Settle a failed create. The row already holds a VMID; if no guest of ours ended
 * up there, Proxmox will give that VMID to the next guest anyone creates, and the
 * row would then point at someone else's machine. So the row is dropped unless the
 * guest exists and is ours (`guestCreated`: our create/clone task finished), in
 * which case it stays in `error` for the owner to see and delete. When Proxmox
 * can't be asked, the row is kept — every later action re-checks the guest anyway.
 *
 * A clone or restore only gets the row's tag after its task finishes, so a task
 * that outlived our wait leaves a guest carrying the source's tags (a template's
 * or source machine's ProxMate tag, or none). `task` lets that be settled from the
 * task itself: finished after all → the guest is ours and is tagged now; still
 * running → the row is kept and the guest is tagged when the task completes.
 * Without a verdict from the task, a guest that carries no OTHER machine's tag
 * (`cloneSourceId` names the duplicate's source, whose tag a copy inherits) keeps
 * the row in `error` rather than leaving a late clone unowned.
 */
export async function settleFailedCreate(
  vm: VirtualMachine,
  err: unknown,
  guestCreated: boolean,
  opts: { task?: CreateTask; cloneSourceId?: string } = {},
): Promise<{ following: boolean }> {
  let keep = guestCreated;
  let following = false;
  if (!keep && opts.task) {
    const verdict = await settleCreateTask(vm, opts.task);
    keep = verdict !== null;
    following = verdict === 'following';
  }
  if (!keep) {
    keep = await guestLeftByCreate(vm, opts.cloneSourceId).catch(() => true);
  }
  if (keep) {
    // A hold already on the row (foreign volumes, over quota) says more than the
    // generic one, so it is kept.
    let existing: { holdReason: string | null } | null = null;
    try {
      existing = await prisma.virtualMachine.findUnique({ where: { id: vm.id }, select: { holdReason: true } });
    } catch {
      /* unreadable — set the generic hold */
    }
    if (!(err instanceof ForeignVolumeError) && !existing?.holdReason) {
      await markVmError(vm.id, vm.name, err, { keepOp: following }).catch(() => undefined);
    }
    return { following };
  }
  await deleteVmRow(vm.id).catch(() => undefined);
  // The create's request has already answered, so the owner reads the reason from
  // the VM page's next fetch of the (now missing) row.
  recordCreateFailure(vm.id, vm.userId, pve.pveMessage(err));
  await notify({
    event: 'vm.error',
    title: vm.name,
    message: `Provisioning of "${vm.name}" failed: ${pve.pveMessage(err)}`,
  }).catch(() => undefined);
  return { following };
}

/** How long a create/clone task that outlived its wait is still followed. */
const LATE_TASK_FOLLOW_MS = 6 * 60 * 60 * 1000;

export type CreateTask = {
  node: string;
  upid: string;
  /**
   * Runs once the task has finished OK, whether or not the row is still there: a
   * finished create of ours at its VMID is the only thing that can have made the
   * guest there, so its checks (and removal) never depend on the row. Throwing
   * keeps the guest from being tagged; with `guestRemoved` set on the error, the
   * guest is gone and the row is dropped.
   */
  verify?: () => Promise<void>;
  /**
   * Make the finished guest safe before it is tagged as the row's (an upload
   * restore: rebuild its NICs, check its volumes, apply isolation, re-sync its
   * sizes). If it throws, the guest is never tagged.
   */
  beforeTag?: () => Promise<void>;
  /** Runs once the task has ended either way (e.g. remove an uploaded archive). */
  afterTask?: () => Promise<void>;
};

/**
 * Whether the create task behind a failed create produced (or is still producing)
 * this row's guest: 'done' (finished OK — tagged now), 'following' (still running —
 * followed in the background, tagged when it completes), or null (failed, or no
 * verdict). The tag only lets the owner delete the guest with its row: the row
 * stays in `error`, so nothing can start the guest. `afterTask` runs once the task
 * has ended either way (e.g. to remove an uploaded archive the task was reading).
 */
async function settleCreateTask(vm: VirtualMachine, task: CreateTask): Promise<'done' | 'following' | null> {
  let client: Awaited<ReturnType<typeof pve.getClient>>;
  let st: { status: string; exitstatus?: string };
  try {
    client = await pve.getClient();
    st = await pve.getTaskStatus(task.node, task.upid, client);
  } catch {
    return null; // no verdict from the task — fall back to what is at the VMID
  }
  if (st.status === 'stopped') {
    if (st.exitstatus && st.exitstatus !== 'OK' && !st.exitstatus.startsWith('WARNINGS')) return null;
    try {
      await task.verify?.();
    } catch (e) {
      // Removed: settle on what is at the VMID (nothing), which drops the row.
      if ((e as { guestRemoved?: boolean }).guestRemoved) return null;
      console.warn(`[vm] guest of failed create "${vm.name}" left untagged: ${pve.pveMessage(e)}`);
      return 'done';
    }
    try {
      await task.beforeTag?.();
      await markClonedGuest(vm, client);
    } catch (e) {
      console.warn(`[vm] guest of failed create "${vm.name}" left untagged: ${pve.pveMessage(e)}`);
    }
    return 'done';
  }
  // The row is held meanwhile with its op fields (opKind, opUpid, …) kept. If this
  // follower is lost (a restart, its time limit, a poll error), the restart
  // reconciler picks the row up from those fields and settles it from the task:
  // see task-reconcile.service.ts. While it runs, the row counts as in flight.
  followLateCreateTask(vm, task, client);
  return 'following';
}

/**
 * Follow a create task that outlived its wait, then settle the row from it: the
 * task's `verify` (and, if the row still points here, `beforeTag` + tag) on
 * success, and `afterTask` either way. Once settled, the row's op fields are
 * cleared — only while they still name this task. A follower that ends any other
 * way (a restart, its time limit, a poll error) leaves them for the restart
 * reconciler, which resumes or settles the row (task-reconcile.service.ts).
 */
function followLateCreateTask(
  vm: VirtualMachine,
  task: CreateTask,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  timeoutMs: number = LATE_TASK_FOLLOW_MS,
): Promise<void> {
  const done = beginInFlight(vm.id);
  let settled = false;
  return pve
    .waitForTask(task.node, task.upid, client, timeoutMs)
    .then(async () => {
      settled = true;
      try {
        await task.verify?.();
      } catch (e) {
        if ((e as { guestRemoved?: boolean }).guestRemoved) {
          // The guest is gone, as on the on-time path: drop the row if it still points here.
          const row = await prisma.virtualMachine.findUnique({ where: { id: vm.id } }).catch(() => null);
          if (row && row.proxmoxVmId === vm.proxmoxVmId) await deleteVmRow(vm.id).catch(() => undefined);
        }
        throw e;
      }
      // Only while the row still exists and still points at this VMID: once it has
      // been deleted, the VMID is nobody's and the guest must not be claimed.
      const row = await prisma.virtualMachine.findUnique({ where: { id: vm.id } });
      if (!row || row.proxmoxVmId !== vm.proxmoxVmId || row.proxmoxNode !== task.node) return;
      await task.beforeTag?.();
      await markClonedGuest(row, client);
    })
    .catch((e) => {
      // A task Proxmox reports as failed is settled too; a timeout or a poll error
      // is not — the op fields stay, and the restart reconciler takes it from there.
      if (e instanceof pve.TaskFailedError) settled = true;
      console.warn(`[vm] late create task for "${vm.name}" did not complete: ${pve.pveMessage(e)}`);
    })
    .finally(async () => {
      if (settled) {
        await task.afterTask?.().catch(() => undefined);
        await (async () =>
          prisma.virtualMachine.updateMany({ where: { id: vm.id, opUpid: task.upid }, data: OP_SETTLED }))().catch(
          () => undefined,
        );
      }
      done();
    });
}

/**
 * Whether the guest at a failed create's VMID may be what that create left behind:
 * it exists and carries no ProxMate tag of another machine (this row's, a
 * template's, the clone source's, or none at all).
 */
async function guestLeftByCreate(vm: VirtualMachine, cloneSourceId?: string): Promise<boolean> {
  let cfg: Record<string, string>;
  try {
    cfg = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, await pve.getClient(), kindOf(vm));
  } catch (err) {
    if (/does not exist|not found/i.test(pve.pveMessage(err))) return false;
    throw err;
  }
  const allowed = new Set([guestMarker(vm.id), ...(cloneSourceId ? [guestMarker(cloneSourceId)] : [])]);
  return !parsePveTags(cfg['tags']).some(
    (t) => t.startsWith(MARKER_PREFIX) && !t.startsWith(`${MARKER_PREFIX}template-`) && !allowed.has(t),
  );
}

/** Thrown when a VM request would push a user over one of their quota caps. */
export class QuotaError extends Error {
  constructor(
    public readonly details: Record<string, { used: number; requested: number; max: number }>,
  ) {
    super('Quota exceeded');
    this.name = 'QuotaError';
  }
}

/**
 * Smallest guest RAM (MB) a create or resize may ask for. Proxmox rejects tiny
 * values outright, and a request it is certain to reject is refused at the schema
 * instead of reserving a row and a VMID first.
 */
export const MIN_RAM_MB = 64;

export interface CreateVmInput {
  name: string;
  cpu: number;
  ram: number; // MB
  storage: number; // GB
  os: string; // ISO filename
  node?: string;
  /** Admin-only: this VM is a grant that doesn't count toward the owner's quota. */
  quotaExempt?: boolean;
  /** Admin-only: the owning tenant may operate but not RESIZE this VM. */
  adminManaged?: boolean;
}

// ─── Per-owner quota lock ─────────────────────────────────────
//
// A quota check only means something if no other request for the same owner can
// add usage between the check and the write that records it. Creates make several
// Proxmox round-trips before their row exists, so overlapping requests would each
// see the same old usage. Quota-affecting work therefore runs one at a time per
// owner. An in-process lock is enough: the API is a single Node process (index.ts
// starts one http server; there is no cluster or worker pool).

const quotaLocks = new Map<string, Promise<void>>();

/** Wait for the owner's quota lock; resolves to a release function (idempotent). */
export async function acquireQuotaLock(ownerId: string): Promise<() => void> {
  const prev = quotaLocks.get(ownerId) ?? Promise.resolve();
  let open!: () => void;
  const mine = new Promise<void>((r) => (open = r));
  const tail = prev.then(() => mine);
  quotaLocks.set(ownerId, tail);
  await prev;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    open();
    if (quotaLocks.get(ownerId) === tail) quotaLocks.delete(ownerId);
  };
}

/** Run `fn` holding the owner's quota lock. */
export async function withQuotaLock<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireQuotaLock(ownerId);
  try {
    return await fn();
  } finally {
    release();
  }
}

// ─── Background provisioning ──────────────────────────────────
//
// A create answers as soon as its `creating` row exists; the Proxmox half (create
// or clone task, configuration, start) carries on without the request, which a
// reverse proxy or tunnel would otherwise cut off long before a clone finishes.
// The page then follows the row to `running` (or `error`). The row stays
// registered in flight (lib/in-flight runInFlight) until that run settles, so the
// restart reconciler leaves it alone while this process is still on it.

/** A create whose row exists: `vm` is the `creating` row, `finished` its outcome. */
export interface StartedCreate {
  vm: VirtualMachine;
  /**
   * Resolves to the provisioned guest's row, or rejects once the failure has been
   * settled (settleFailedCreate) — the row is then held in `error` or dropped.
   */
  finished: Promise<VirtualMachine>;
}

// ─── VMID reservation ─────────────────────────────────────────
//
// /cluster/nextid answers with the lowest VMID no guest uses yet. A create asks for
// one just before its create or clone task makes the guest, so that is enough for a
// single create. A path that picks a VMID well before its guest exists (an upload
// restore) holds it here until the guest does, and every create path skips it.

const pendingVmids = new Set<number>();

/** The next VMID free on Proxmox and not held by a reservation. */
export async function nextVmId(client: Awaited<ReturnType<typeof pve.getClient>>): Promise<number> {
  // A row still creating, or held in error, still names its VMID even when no guest
  // is there now; handing it out again would put a second guest behind that row.
  const named = await (async () =>
    prisma.virtualMachine.findMany({ where: { status: { in: ['creating', 'error'] } }, select: { proxmoxVmId: true } }))().catch(
    () => [] as Array<{ proxmoxVmId: number }>,
  );
  const skip = new Set((named ?? []).map((r) => r.proxmoxVmId));
  const first = await pve.getNextVmId(client);
  if (!pendingVmids.has(first) && !skip.has(first)) return first;
  return (await freeVmIdsFrom(first + 1, 1, client, skip, false))[0]!;
}

/**
 * `count` free VMIDs from `start` up, skipping held ones and `skip`, each confirmed
 * with Proxmox. With `hold`, each is held the moment it is confirmed (re-checked
 * after the Proxmox round-trip), so two reservations running side by side can't
 * both take it.
 */
async function freeVmIdsFrom(
  start: number,
  count: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  skip: Set<number>,
  hold: boolean,
): Promise<number[]> {
  const out: number[] = [];
  try {
    // Bounded so a cluster that refuses every candidate fails instead of looping.
    for (let id = start, tries = 0; out.length < count; id += 1, tries += 1) {
      if (tries > count + 500) throw new Error('Could not find enough free VMIDs on the cluster.');
      if (pendingVmids.has(id) || skip.has(id)) continue;
      if (!(await pve.isVmIdFree(id, client)) || pendingVmids.has(id)) continue;
      if (hold) pendingVmids.add(id);
      out.push(id);
    }
  } catch (err) {
    if (hold) for (const id of out) pendingVmids.delete(id);
    throw err;
  }
  return out;
}

/**
 * Reserve `count` VMIDs for rows written before their guests exist. Skips VMIDs
 * any machine row or Template Store entry references (a row whose guest is gone
 * still names its VMID). Release each with releaseVmId once its guest exists or
 * its create has been settled.
 */
export async function reserveVmIds(
  count: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<number[]> {
  const [rows, templates] = await Promise.all([
    prisma.virtualMachine.findMany({ select: { proxmoxVmId: true } }),
    prisma.template.findMany({ select: { proxmoxVmId: true } }),
  ]);
  const skip = new Set([...rows, ...templates].map((r) => r.proxmoxVmId));
  const first = await pve.getNextVmId(client);
  return freeVmIdsFrom(first, count, client, skip, true);
}

/** Give back a VMID reserved by reserveVmIds. */
export function releaseVmId(vmid: number): void {
  pendingVmids.delete(vmid);
}

/** Check the requested resources against the user's remaining quota. */
export async function assertWithinQuota(user: User, input: CreateVmInput): Promise<void> {
  // Admins (cluster owners) are not quota-limited; neither is an admin-granted
  // exempt VM (the flag is settable only through admin-gated routes).
  if (user.role === 'admin' || input.quotaExempt) return;

  // Exempt VMs never count toward usage — they're admin grants on top of quota.
  const existing = await prisma.virtualMachine.findMany({ where: { userId: user.id, quotaExempt: false } });
  const usedCpu = existing.reduce((s, v) => s + v.cpu, 0);
  const usedRam = existing.reduce((s, v) => s + v.ram, 0);
  const usedStorage = existing.reduce((s, v) => s + v.storage, 0);

  const violations: Record<string, { used: number; requested: number; max: number }> = {};
  if (usedCpu + input.cpu > user.maxCpu)
    violations['cpu'] = { used: usedCpu, requested: input.cpu, max: user.maxCpu };
  if (usedRam + input.ram > user.maxRam)
    violations['ram'] = { used: usedRam, requested: input.ram, max: user.maxRam };
  if (usedStorage + input.storage > user.maxStorage)
    violations['storage'] = { used: usedStorage, requested: input.storage, max: user.maxStorage };

  if (Object.keys(violations).length > 0) throw new QuotaError(violations);
}

/** A create-option violation the routes surface directly (status included). */
export class CreateOptionError extends Error {
  constructor(
    message: string,
    public status = 403,
  ) {
    super(message);
    this.name = 'CreateOptionError';
  }
}

/**
 * Resolve who a new guest belongs to and police the admin-only create options.
 * Tenants create for themselves with auto-placement; only admins may pin a node,
 * deploy INTO another user's account (`forUserId`), or grant quota exemption.
 * Returns the full User row the guest will belong to (quota is checked against
 * THEM, not the acting admin).
 */
export async function resolveCreateTarget(
  reqUser: { id: string; role: string },
  opts: { forUserId?: string; quotaExempt?: boolean; node?: string },
): Promise<User> {
  const usesAdminOption = opts.forUserId !== undefined || opts.quotaExempt !== undefined || opts.node !== undefined;
  if (usesAdminOption && reqUser.role !== 'admin') {
    throw new CreateOptionError('Choosing a node, deploying for another user, or quota exemption is admin-only.');
  }
  const owner = await prisma.user.findUnique({ where: { id: opts.forUserId ?? reqUser.id } });
  if (!owner) {
    throw new CreateOptionError(opts.forUserId ? 'No such user to deploy for.' : 'User not found', 404);
  }
  return owner;
}

/**
 * Orchestrate VM creation: quota check → reserve VMID → DB record →
 * create on Proxmox → start → reflect final status.
 */
export async function createVm(user: User, input: CreateVmInput): Promise<VirtualMachine> {
  return (await startCreateVm(user, input)).finished;
}

/**
 * createVm up to the `creating` row; the Proxmox half runs in the background (see
 * runInFlight). Errors before the row exists (quota, placement, VMID)
 * are thrown from here.
 */
export async function startCreateVm(user: User, input: CreateVmInput): Promise<StartedCreate> {
  // Quota check -> row insert runs under the owner's lock (see acquireQuotaLock);
  // the lock is released as soon as the row exists, before the slow Proxmox work.
  const release = await acquireQuotaLock(user.id);
  try {
    return await createVmLocked(user, input, release);
  } finally {
    release();
  }
}

async function createVmLocked(user: User, input: CreateVmInput, release: () => void): Promise<StartedCreate> {
  await assertWithinQuota(user, input);

  const client = await pve.getClient();
  const [storage, bridge, isoStorage, isolationCfg] = await Promise.all([
    getConfig('default_storage'),
    getConfig('default_bridge'),
    getConfig('iso_storage'),
    getConfig('isolation_enabled'),
  ]);
  if (!storage || !bridge || !isoStorage) {
    throw new Error('Server defaults are not configured — finish setup first');
  }
  const isolate = isolationCfg !== 'false'; // tenant isolation is on by default

  // Only nodes that physically hold the install ISO can build this VM. With
  // node-local ISO storage (e.g. `local`), an ISO uploaded to one node isn't
  // visible on the others — the #1 cause of a placement that looks fine but
  // fails asynchronously in Proxmox. Constrain auto-scheduling to those nodes.
  const isoNodes = await pve.getIsoNodes(isoStorage, input.os, client);
  if (isoNodes.length === 0) {
    throw new Error(
      `Install ISO "${input.os}" isn't available on any node's "${isoStorage}" storage. ` +
        `Upload it there (or use a shared ISO storage) and try again.`,
    );
  }

  let node: string;
  if (input.node) {
    // An explicitly pinned node (admin/API) must still actually have the ISO.
    if (!isoNodes.includes(input.node)) {
      throw new Error(
        `Node "${input.node}" doesn't have ISO "${input.os}" on "${isoStorage}" ` +
          `(available on: ${isoNodes.join(', ')}).`,
      );
    }
    node = input.node;
  } else {
    node = await pve.pickBestNode(
      { cpu: input.cpu, ramMb: input.ram, storageGb: input.storage },
      storage,
      client,
      isoNodes,
      // ISO installs are x86 today, so keep custom VMs on amd64 nodes (an ARM
      // node would only TCG-emulate them). An arch picker for ARM ISOs is Phase 2.
      'amd64',
    );
  }
  const vmid = await nextVmId(client);

  const vm = await prisma.virtualMachine.create({
    data: {
      userId: user.id,
      proxmoxVmId: vmid,
      proxmoxNode: node,
      name: input.name,
      cpu: input.cpu,
      ram: input.ram,
      storage: input.storage,
      os: input.os,
      status: 'creating',
      opKind: 'create' satisfies VmOpKind,
      opStartedAt: new Date(),
      quotaExempt: input.quotaExempt ?? false,
      adminManaged: input.adminManaged ?? false,
    },
  });
  release(); // usage now includes this row

  const finished = runInFlight(vm.id, async () => {
    let created = false;
    try {
      // Wait for the create task so a real Proxmox failure (e.g. unusable storage)
      // surfaces as an error here instead of a false "created" with a broken VM.
      const createUpid = await pve.createVm(
        {
          node,
          vmid,
          name: input.name,
          cores: input.cpu,
          memory: input.ram,
          diskGb: input.storage,
          storage,
          bridge,
          isoStorage,
          iso: input.os,
          tags: guestMarker(vm.id),
          pool: await pve.getGuestPool(),
        },
        client,
      );
      await recordOpTask(vm.id, createUpid);
      await pve.waitForTask(node, createUpid, client);
      created = true;

      // Lock the VM's firewall down for tenant isolation before it ever boots.
      if (isolate) {
        await pve.configureVmIsolation(node, vmid, await pve.readIsolationOptions(), client);
      }

      await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped', ...OP_SETTLED } });

      // Wait for the start task too, so "running" means it actually started.
      const startUpid = await pve.startVm(node, vmid, client);
      await pve.waitForTask(node, startUpid, client);
      return prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
    } catch (err) {
      await settleFailedCreate(vm, err, created);
      throw err;
    }
  });
  return { vm, finished };
}

export interface CreateContainerInput {
  name: string;
  cpu: number;
  ram: number; // MB
  storage: number; // GB (rootfs)
  template: string; // full LXC template volid, e.g. "local:vztmpl/debian-12-…tar.zst"
  password?: string;
  sshKey?: string;
  node?: string;
  /** Admin-only: this container is a grant that doesn't count toward the owner's quota. */
  quotaExempt?: boolean;
  /** Admin-only: the owning tenant may operate but not RESIZE this container. */
  adminManaged?: boolean;
}

/** Guess a container's CPU architecture from its OS-template filename. */
function archFromTemplate(volid: string): pve.Arch | undefined {
  const s = volid.toLowerCase();
  if (/arm64|aarch64/.test(s)) return 'arm64';
  if (/amd64|x86[_-]?64/.test(s)) return 'amd64';
  return undefined; // unknown → don't constrain placement by arch
}

/**
 * Orchestrate LXC container creation — mirrors createVm: quota check → pick a node
 * that physically holds the OS template → reserve VMID → DB record (type:'lxc') →
 * create on Proxmox → lock the firewall down for tenant isolation → start.
 */
export async function createContainer(user: User, input: CreateContainerInput): Promise<VirtualMachine> {
  return (await startCreateContainer(user, input)).finished;
}

/** createContainer up to the `creating` row; the Proxmox half runs in the background. */
export async function startCreateContainer(user: User, input: CreateContainerInput): Promise<StartedCreate> {
  // Quota check -> row insert runs under the owner's lock (see acquireQuotaLock);
  // the lock is released as soon as the row exists, before the slow Proxmox work.
  const release = await acquireQuotaLock(user.id);
  try {
    return await createContainerLocked(user, input, release);
  } finally {
    release();
  }
}

async function createContainerLocked(
  user: User,
  input: CreateContainerInput,
  release: () => void,
): Promise<StartedCreate> {
  await assertWithinQuota(user, {
    name: input.name,
    cpu: input.cpu,
    ram: input.ram,
    storage: input.storage,
    os: input.template,
    quotaExempt: input.quotaExempt,
    adminManaged: input.adminManaged,
  });

  const client = await pve.getClient();
  const [storage, bridge, isolationCfg] = await Promise.all([
    getConfig('default_storage'),
    getConfig('default_bridge'),
    getConfig('isolation_enabled'),
  ]);
  if (!storage || !bridge) {
    throw new Error('Server defaults are not configured — finish setup first');
  }
  const isolate = isolationCfg !== 'false'; // tenant isolation is on by default

  // Only nodes that physically hold the OS template can build this container
  // (node-local template storage like `local` isn't shared) — same constraint as
  // ISO placement for QEMU.
  const templateName = input.template.split('/').pop() ?? input.template;
  const tmplNodes = await pve.getTemplateNodes(input.template, client);
  if (tmplNodes.length === 0) {
    throw new Error(
      `LXC template "${templateName}" isn't available on any node. ` +
        `Add it in Proxmox (pveam / Datacenter → CT Templates) and try again.`,
    );
  }

  let node: string;
  if (input.node) {
    if (!tmplNodes.includes(input.node)) {
      throw new Error(
        `Node "${input.node}" doesn't have template "${templateName}" (available on: ${tmplNodes.join(', ')}).`,
      );
    }
    node = input.node;
  } else {
    node = await pve.pickBestNode(
      { cpu: input.cpu, ramMb: input.ram, storageGb: input.storage },
      storage,
      client,
      tmplNodes,
      archFromTemplate(input.template),
    );
  }
  const vmid = await nextVmId(client);

  const vm = await prisma.virtualMachine.create({
    data: {
      userId: user.id,
      proxmoxVmId: vmid,
      proxmoxNode: node,
      type: 'lxc',
      name: input.name,
      cpu: input.cpu,
      ram: input.ram,
      storage: input.storage,
      os: templateName,
      status: 'creating',
      opKind: 'create-lxc' satisfies VmOpKind,
      opStartedAt: new Date(),
      quotaExempt: input.quotaExempt ?? false,
      adminManaged: input.adminManaged ?? false,
    },
  });
  release(); // usage now includes this row

  const finished = runInFlight(vm.id, async () => {
    let created = false;
    try {
      const createUpid = await pve.createLxc(
        {
          node,
          vmid,
          hostname: input.name,
          cores: input.cpu,
          memory: input.ram,
          diskGb: input.storage,
          storage,
          bridge,
          ostemplate: input.template,
          password: input.password,
          sshPublicKeys: input.sshKey,
          tags: guestMarker(vm.id),
          pool: await pve.getGuestPool(),
        },
        client,
      );
      await recordOpTask(vm.id, createUpid);
      await pve.waitForTask(node, createUpid, client);
      created = true;

      // Lock the container's firewall down for tenant isolation before it boots.
      if (isolate) {
        await pve.configureVmIsolation(node, vmid, await pve.readIsolationOptions(), client, 'lxc');
      }

      await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped', ...OP_SETTLED } });

      const startUpid = await pve.startVm(node, vmid, client, 'lxc');
      await pve.waitForTask(node, startUpid, client);
      return prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
    } catch (err) {
      await settleFailedCreate(vm, err, created);
      throw err;
    }
  });
  return { vm, finished };
}

export interface DeployTemplateInput {
  name: string;
  cpu: number;
  ram: number; // MB
  storage: number; // GB (clamped up to the template's base disk)
  // Cloud-init templates only: injected on first boot so the box is reachable.
  sshKey?: string;
  username?: string;
  password?: string;
  installDocker?: boolean; // attach the cloud-init "extras" vendor snippet
  installTailscale?: boolean;
  installGuestAgent?: boolean; // installs qemu-guest-agent so the VM reports its IP
  installSuperfile?: boolean; // installs superfile (spf), a headless terminal file manager
  /** Selected cloud-init extra ids (data-driven; supersedes the install* booleans). */
  features?: string[];
  /** Admin-only: this VM is a grant that doesn't count toward the owner's quota. */
  quotaExempt?: boolean;
  /** Admin-only: the owning tenant may operate but not RESIZE this VM. */
  adminManaged?: boolean;
}

/** Cloud-init knobs shared by template deploys and rebuilds. */
type CloudInitInput = Pick<
  DeployTemplateInput,
  | 'sshKey'
  | 'username'
  | 'password'
  | 'installDocker'
  | 'installTailscale'
  | 'installGuestAgent'
  | 'installSuperfile'
  | 'features'
>;

/**
 * Resolve a cloud-init vendor snippet covering exactly `ids`, or null when this node
 * cannot be given one. **Never throws** — the caller decides whether a given set of
 * ids is worth failing a deploy over.
 *
 * Preferred: write the exact combo on-demand to the shared, container-mounted snippet
 * storage (no manual placement, no 2ⁿ pre-placed files). When that isn't configured,
 * fall back to the historical model where the matching snippet must already be on
 * this node — admins place those by hand, since the Proxmox API cannot write snippets.
 */
async function snippetFor(
  ids: string[],
  node: string,
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<string | null> {
  if (ids.length === 0) return null;
  const onDemand = await pve.ensureCloudInitSnippet(ids);
  if (onDemand) return onDemand;
  const snippetStorage = (await getConfig('iso_storage')) ?? 'local';
  const file = pve.cloudInitSnippetFile(ids);
  const ready = await pve.nodesWithSnippet(snippetStorage, file, client);
  return ready.includes(node) ? `${snippetStorage}:snippets/${file}` : null;
}

/**
 * The optional cloud-init extras a deploy asked for that the admin actually OFFERS:
 * the `features` id array (data-driven) plus the legacy install* booleans
 * (back-compat). Never arbitrary tenant input, never a de-offered feature.
 */
async function selectedFeatureIds(cloud: CloudInitInput): Promise<Set<string>> {
  const offered = new Set(await getOfferedFeatureIds());
  const selected = new Set<string>();
  for (const id of cloud.features ?? []) if (offered.has(id)) selected.add(id);
  if (cloud.installDocker && offered.has('docker')) selected.add('docker');
  if (cloud.installTailscale && offered.has('tailscale')) selected.add('tailscale');
  if (cloud.installGuestAgent && offered.has('guest-agent')) selected.add('guest-agent');
  if (cloud.installSuperfile && offered.has('superfile')) selected.add('superfile');
  return selected;
}

/**
 * Configure a freshly-cloned VM in place: autoscale cores/memory, grow the primary
 * disk if needed, inject cloud-init (login user + SSH key + DHCP, optional first-boot
 * extras), and apply tenant firewall isolation. Shared by deployFromTemplate and
 * rebuildVm so the cloud-image setup stays identical on both paths.
 */
async function configureClonedVm(
  cfg: {
    node: string;
    vmid: number;
    template: Template;
    cpu: number;
    ram: number;
    diskGb: number;
    isolate: boolean;
    cloud: CloudInitInput;
  },
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<void> {
  const { node, vmid, template, cpu, ram, diskGb, isolate, cloud } = cfg;

  // Autoscale: set cores/memory, then grow the primary disk if needed.
  await pve.setVmResources(node, vmid, cpu, ram, client);
  const vmCfg = await pve.getVmConfig(node, vmid, client);
  const disk = pve.findPrimaryDisk(vmCfg);
  if (disk && diskGb > (template.diskGb || 0)) {
    await pve.resizeDisk(node, vmid, disk, diskGb, client);
  }

  // Cloud-init: inject the login user + SSH key + DHCP so the box is immediately
  // reachable on first boot (no installer). Hostname = VM name.
  if (template.cloudInit) {
    let vendorSnippet: string | undefined;
    // Selected optional extras: prefer the `features` id array (data-driven), still
    // honor the legacy install* booleans (back-compat). Only ids the admin actually
    // OFFERS are accepted — never arbitrary tenant input, never a de-offered feature.
    const selected = await selectedFeatureIds(cloud);

    // The admin-configured always-on base rides on EVERY cloud-init VM — but only
    // when on-demand snippet writing is set up, since that's what makes a mandatory
    // base practical without exponential manual placement.
    const baseIds = pve.snippetWriteConfig() ? await getBaseFeatureIds() : [];
    // What was actually ASKED for: the admin's base plus the tenant's selections.
    // A missing snippet for any of these is a hard error — the tenant would silently
    // get a box without the software they chose.
    const chosen = [...new Set([...baseIds, ...selected])];

    // A requested password is applied post-boot through the guest agent (the whole
    // point of not putting it on the seed), so the agent stops being optional the
    // moment one is asked for. Added regardless of the admin's "offered" list,
    // because it is a functional requirement rather than a tenant preference.
    //
    // Belt, not braces — and the belt must never break the trousers. Installing the
    // agent here needs working apt on first boot, which an isolated or air-gapped
    // deployment deliberately does not have; those must bake the agent INTO the
    // template, and a template that already ships it needs nothing from us. So when
    // no snippet can be produced for the belt, drop it and carry on rather than
    // failing a deploy that would have worked. If the agent genuinely turns out to
    // be absent, `deploy.agent_missing` tells an admin once the window closes.
    const agentBelt = Boolean(cloud.password) && !chosen.includes('guest-agent');

    vendorSnippet = (await snippetFor(agentBelt ? [...chosen, 'guest-agent'] : chosen, node, client)) ?? undefined;
    const beltFastened = agentBelt && vendorSnippet !== undefined;
    if (!vendorSnippet && chosen.length > 0) {
      // Retry without the belt before giving up, so a missing guest-agent snippet
      // can't mask — or be mistaken for — a missing snippet for a chosen feature.
      vendorSnippet = agentBelt ? ((await snippetFor(chosen, node, client)) ?? undefined) : undefined;
      if (!vendorSnippet) {
        throw new Error(
          `The selected setup (${chosen.join(' + ')}) isn't installed on node "${node}" — ` +
            `an admin needs to add its snippet (Template Store → Cloud-init extras).`,
        );
      }
    }
    if (agentBelt && !beltFastened) {
      console.warn(
        `[vm] no cloud-init snippet available to install qemu-guest-agent on node "${node}" — ` +
          'proceeding without it. The login password can only be set in-guest through the agent, ' +
          'so the template must ship qemu-guest-agent pre-installed.',
      );
    }
    // NOTE the absent `cipassword`. Handing the password to cloud-init writes its
    // crypt hash to two places the tenant can read for the life of the guest: the
    // cloud-init seed drive (/dev/sr0, the 2026-07-18 pentest finding) AND the
    // guest's own /var/lib/cloud/instances/<id>/user-data.txt cache — both verified
    // live on 2026-08-11. Ejecting the seed does not fix it, because the on-disk
    // cache survives. So the password is never given to cloud-init at all; it is
    // applied post-boot through the guest agent, which writes only to /etc/shadow.
    // See applyPendingCiPassword in deploy-lock.service.ts.
    await pve.setCloudInitConfig(
      node,
      vmid,
      {
        ciuser: cloud.username || 'debian',
        sshKeys: cloud.sshKey,
        ipConfig: 'ip=dhcp',
        vendorSnippet,
      },
      client,
    );

    // Cloud-image templates default to a serial display (`vga=serial0`), which makes
    // ProxMate's noVNC console show the "starting serial terminal" placeholder. Force
    // a normal VGA console; the serial port stays available for boot logs.
    await client.put(`/nodes/${node}/qemu/${vmid}/config`, new URLSearchParams({ vga: 'std' }));
  }

  // Network placement: the clone inherited the template's bridge, so the admin's
  // default is applied here or not at all. Before isolation, because placement is
  // what the firewall and VLAN rules are then written on top of.
  await pve.applyDefaultBridge(node, vmid, client);

  // Tenant isolation (cloned NICs may lack the per-NIC firewall flag).
  if (isolate) {
    await pve.ensureNicFirewall(node, vmid, client);
    await pve.configureVmIsolation(node, vmid, await pve.readIsolationOptions(), client);
  }
}

/**
 * Decide how to clone a template so the admin's "Default storage" is actually
 * honoured, rather than accepted, saved and ignored.
 *
 * Proxmox can only place a FULL clone. A linked clone shares the template's base
 * image, so it is pinned to the template's storage and, through it, to the
 * template's node — `storage=` on that request is not supported. Three cases:
 *
 * - **Cloud-image template** — already full-cloned (lvmthin can't linked-clone an
 *   imported disk), so the pool just needs passing through.
 * - **Regular template already on the configured pool** — the link is free and the
 *   setting is honoured anyway. Stay linked.
 * - **Regular template somewhere else** — the link is what gives way. Keeping it
 *   would mean ignoring the setting *and* re-pinning the guest to node-local
 *   storage, which is the migratability regression the 2026-08-01 fix removed.
 *   Full-cloning costs disk and deploy time; failing the deploy outright would
 *   break installs that work today, so it is not the trade made here.
 */
async function planTemplateClone(
  node: string,
  template: Template,
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<{ full: boolean; storage?: string }> {
  const configured = (await getConfig('default_storage')) ?? undefined;
  // The clone runs on the node holding the template, so a pool that node can't see
  // would fail the request. Don't trade a silently-ignored setting for a hard error.
  const storage = configured && (await pve.storageAvailableOn(node, configured, client))
    ? configured
    : undefined;
  if (configured && !storage) {
    console.warn(
      `[vm] default storage "${configured}" is not available on node "${node}" — ` +
        `cloning template ${template.proxmoxVmId} onto the template's own storage instead`,
    );
  }

  if (template.cloudInit) return { full: true, ...(storage ? { storage } : {}) };
  if (!storage) return { full: false };

  const cfg = await pve.getVmConfig(node, template.proxmoxVmId, client).catch(() => null);
  const on = cfg ? pve.diskStorageOf(cfg) : null;
  // Couldn't read where the template lives — keep the historical behaviour rather
  // than promoting a working linked clone to a full one on a guess.
  if (!on || on === storage) return { full: false };
  console.warn(
    `[vm] template ${template.proxmoxVmId} lives on "${on}" but the default storage is ` +
      `"${storage}" — full-cloning so the guest lands on the configured pool ` +
      '(a linked clone cannot be placed off its base image)',
  );
  return { full: true, storage };
}

/**
 * Nodes that can serve the cloud-init vendor snippet, or undefined when there is no
 * restriction to apply. A deploy writes `cicustom` pointing at the snippet storage,
 * and Proxmox only resolves that volid on nodes where the storage is available: a
 * guest placed anywhere else clones and configures fine, then fails to start with
 * `storage '<id>' is not available on node '<node>'` and is left held as a failed
 * provision. Placement therefore has to respect the snippet storage the same way it
 * respects the disk pool.
 */
async function snippetCapableNodes(
  template: Template,
  cloud: CloudInitInput,
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<string[] | undefined> {
  if (!template.cloudInit) return undefined; // only cloud-init deploys get a vendor snippet
  const onDemand = pve.snippetWriteConfig();
  if (onDemand) return (await pve.storageNodes(onDemand.storage, client)) ?? undefined;
  // Hand-placed snippets: a deploy that asked for extras needs the node that already
  // holds that exact file (see snippetFor); one that asked for none needs no snippet.
  const ids = [...(await selectedFeatureIds(cloud))];
  if (ids.length === 0) return undefined;
  const storage = (await getConfig('iso_storage')) ?? 'local';
  return pve.nodesWithSnippet(storage, pve.cloudInitSnippetFile(ids), client);
}

/**
 * The node a template deploy lands on.
 *
 * A linked clone shares the template's base image, so it stays on the template's
 * node. A full clone can be placed anywhere Proxmox can reach both ends, which it
 * allows only when every disk of the template AND the destination pool are shared
 * storage — then the guest goes where the scheduler would put a new VM, instead of
 * every deploy piling onto the node that happens to hold the template. Anything this
 * can't confirm (a node-local disk, an unreadable config, no node that fits) keeps
 * the template's node, which is what a deploy did before.
 */
type TemplateFacts = [Record<string, string>, Awaited<ReturnType<typeof pve.getNodeImagesStorages>>];

/** What placement needs to know about a template: its config and its node's storages. */
function templateFacts(template: Template, client: Awaited<ReturnType<typeof pve.getClient>>): Promise<TemplateFacts> {
  return Promise.all([
    pve.getVmConfig(template.proxmoxNode, template.proxmoxVmId, client),
    pve.getNodeImagesStorages(template.proxmoxNode, client),
  ]);
}

async function pickTemplateDeployNode(
  template: Template,
  plan: { full: boolean; storage?: string },
  want: { cpu: number; ramMb: number; storageGb: number },
  cloud: CloudInitInput,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  pending?: Map<string, { cpu: number; ramMb: number; storageGb: number }>,
  /** The template's config and its node's storages, when the caller already has them. */
  facts?: () => Promise<TemplateFacts>,
): Promise<string> {
  const home = template.proxmoxNode;
  if (!plan.full) return home;
  try {
    const [cfg, storages] = await (facts ? facts() : templateFacts(template, client));
    const shared = new Set(storages.filter((s) => s.shared).map((s) => s.storage));
    const sources = pve.volumeStoragesOf(cfg);
    const dest = plan.storage ?? pve.diskStorageOf(cfg);
    if (!dest || !shared.has(dest) || sources.length === 0 || !sources.every((s) => shared.has(s))) {
      return home;
    }
    const arch = template.arch === 'amd64' || template.arch === 'arm64' ? template.arch : undefined;
    return await pve.pickBestNode(want, dest, client, await snippetCapableNodes(template, cloud, client), arch, pending);
  } catch (err) {
    console.warn(
      `[vm] could not place a deploy of template ${template.proxmoxVmId} across the cluster ` +
        `(${pve.pveMessage(err)}) — cloning on its own node "${home}"`,
    );
    return home;
  }
}

/**
 * Deploy a new VM from a published template: quota check → clone the template
 * (onto the best node when its storage allows) → autoscale (cores/memory + grow
 * disk) → isolate → start. Resolves once the guest is running.
 */
export async function deployFromTemplate(
  user: User,
  template: Template,
  input: DeployTemplateInput,
): Promise<VirtualMachine> {
  return (await startDeployFromTemplate(user, template, input)).finished;
}

/**
 * deployFromTemplate up to the `creating` row; the clone and everything after it
 * run in the background (see StartedCreate). Errors before the row exists
 * (quota, placement, VMID) are thrown from here.
 */
export async function startDeployFromTemplate(
  user: User,
  template: Template,
  input: DeployTemplateInput,
): Promise<StartedCreate> {
  // Quota check -> row insert runs under the owner's lock (see acquireQuotaLock);
  // the lock is released as soon as the row exists, before the slow Proxmox work.
  const release = await acquireQuotaLock(user.id);
  try {
    return await deployFromTemplateLocked(user, template, input, release);
  } finally {
    release();
  }
}

async function deployFromTemplateLocked(
  user: User,
  template: Template,
  input: DeployTemplateInput,
  release: () => void,
): Promise<StartedCreate> {
  // Can't deploy a disk smaller than the template's base image.
  const diskGb = templateDiskGb(template, input);
  await assertWithinQuota(user, {
    name: input.name,
    cpu: input.cpu,
    ram: input.ram,
    storage: diskGb,
    os: template.name,
    quotaExempt: input.quotaExempt,
    adminManaged: input.adminManaged,
  });

  const client = await pve.getClient();
  const home = template.proxmoxNode; // where the template lives and the clone task runs
  // Full-vs-linked and the target pool are decided together — see planTemplateClone —
  // and the plan decides whether the guest may land on another node.
  const plan = await planTemplateClone(home, template, client);
  const node = await pickTemplateDeployNode(
    template,
    plan,
    { cpu: input.cpu, ramMb: input.ram, storageGb: diskGb },
    input,
    client,
  );
  const vmid = await nextVmId(client);

  const vm = await prisma.virtualMachine.create({
    data: templateDeployRow(user, template, input, { vmid, node, diskGb }),
  });
  release(); // usage now includes this row
  return { vm, finished: runInFlight(vm.id, () => provisionTemplateDeploy(vm, template, input, plan, client)) };
}

/** A template deploy's disk size: what was asked for, never below the template's base image. */
function templateDiskGb(template: Template, input: { storage: number }): number {
  return Math.max(input.storage, template.diskGb || input.storage);
}

/** The `creating` row a template deploy writes before its clone starts. */
function templateDeployRow(
  owner: User,
  template: Template,
  input: DeployTemplateInput,
  at: { vmid: number; node: string; diskGb: number },
) {
  return {
    userId: owner.id,
    proxmoxVmId: at.vmid,
    proxmoxNode: at.node,
    name: input.name,
    description: `From template: ${template.name}`,
    cpu: input.cpu,
    ram: input.ram,
    storage: at.diskGb,
    os: template.os ?? template.name,
    status: 'creating',
    opKind: 'clone' satisfies VmOpKind,
    opStartedAt: new Date(),
    opSourceId: template.id,
    quotaExempt: input.quotaExempt ?? false,
    adminManaged: input.adminManaged ?? false,
  };
}

/**
 * The Proxmox half of a template deploy, for a row that already exists (written
 * under the owner's quota lock): clone onto the row's node and VMID → tag →
 * autoscale + cloud-init + isolation → start. A failure is settled like any
 * failed create (settleFailedCreate) and rethrown. The caller runs it through
 * runInFlight, which keeps the row registered in flight (lib/in-flight) for the whole run.
 */
async function provisionTemplateDeploy(
  vm: VirtualMachine,
  template: Template,
  input: DeployTemplateInput,
  plan: { full: boolean; storage?: string },
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<VirtualMachine> {
  const home = template.proxmoxNode;
  const node = vm.proxmoxNode;
  const vmid = vm.proxmoxVmId;
  const diskGb = vm.storage;

  let created = false;
  let cloneTask: { node: string; upid: string } | undefined;
  try {
    const isolate = (await getConfig('isolation_enabled')) !== 'false';
    const upid = await pve.cloneVm(
      {
        node: home,
        templateVmid: template.proxmoxVmId,
        newVmid: vmid,
        name: input.name,
        full: plan.full,
        storage: plan.storage,
        target: node,
        pool: await pve.getGuestPool(),
        description: cloneNonce(vm.id),
      },
      client,
    );
    // The clone task runs on the template's node even when the guest lands elsewhere.
    cloneTask = { node: home, upid };
    await recordOpTask(vm.id, upid);
    await pve.waitForTask(home, upid, client, 600_000);
    created = true;
    await markClonedGuest(vm, client);

    // Autoscale (cores/memory/disk) + cloud-init + tenant isolation on the clone.
    await configureClonedVm(
      { node, vmid, template, cpu: input.cpu, ram: input.ram, diskGb, isolate, cloud: input },
      client,
    );

    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped', ...OP_SETTLED } });
    // Wait for the start task so "running" reflects reality (matches createVm).
    const startUpid = await pve.startVm(node, vmid, client);
    await pve.waitForTask(node, startUpid, client);
    return prisma.virtualMachine.update({
      where: { id: vm.id },
      data: {
        status: 'running',
        // Cloud-init keeps provisioning inside the guest after boot — lock the VM
        // (no stop/restart/delete) until a `cloud-init status` probe says it's done.
        ...(template.cloudInit ? { deployState: 'deploying', deployStateAt: new Date() } : {}),
        // Held encrypted only until the guest agent can set it in-guest, then nulled.
        // Deliberately NOT given to cloud-init — see configureClonedVm.
        ...(template.cloudInit && input.password ? { pendingCiPassword: encrypt(input.password) } : {}),
      },
    });
  } catch (err) {
    await settleFailedCreate(vm, err, created, { task: cloneTask });
    throw err;
  }
}

/**
 * Self-service clone of a VM the caller can operate. Full-clones the source
 * (storage-agnostic) to a new VMID on the same node, quota-checks the duplicate
 * against the owner's caps, re-applies the tenant-isolation firewall before boot
 * (the clone gets a fresh MAC, so rules must be rebuilt), and starts it. The
 * source must be stopped — a clean full clone doesn't need a snapshot and can't
 * copy a live disk out from under a running guest. QEMU-only (uses the qemu
 * clone endpoint); the new VM is owned by the same user as the source.
 */
export async function duplicateVm(source: VirtualMachine, newName: string): Promise<VirtualMachine> {
  // Quota check -> row insert runs under the owner's lock (see acquireQuotaLock);
  // the lock is released as soon as the row exists, before the slow Proxmox work.
  const release = await acquireQuotaLock(source.userId);
  try {
    return await duplicateVmLocked(source, newName, release);
  } finally {
    release();
  }
}

async function duplicateVmLocked(
  source: VirtualMachine,
  newName: string,
  release: () => void,
): Promise<VirtualMachine> {
  // The copy inherits the source's owner and is started — same owner gate.
  await assertOwnerAccessActive(source);
  if (kindOf(source) === 'lxc') throw new Error('Containers (LXC) can\'t be duplicated');

  const client = await pve.getClient();
  // The copy is made from the guest at the source's VMID — only ever the source's own.
  const current = await requireOurGuest(source, { client });

  const status = await pve.getVmStatus(current.proxmoxNode, current.proxmoxVmId, client).catch(() => null);
  if (status?.status === 'running') {
    throw new Error('Stop the machine first — a duplicate is made from a stopped VM');
  }

  // A full clone copies every `hostpciN` line, so a copy would get passthrough that
  // was approved for the source only — and, unflagged, would be treated as freely
  // movable by the balancer and drains. Checked on the live config too, since the
  // flag is only ProxMate's record of what is attached.
  const sourceCfg = await pve.getVmConfig(current.proxmoxNode, current.proxmoxVmId, client);
  if (current.hasPassthrough || Object.keys(sourceCfg).some((k) => /^hostpci\d+$/.test(k))) {
    throw new Error('A VM with PCI/GPU passthrough can’t be duplicated. Detach the device first.');
  }

  // Quota is charged to the source's owner (the duplicate belongs to them too).
  const owner = await prisma.user.findUnique({ where: { id: current.userId } });
  if (!owner) throw new Error('VM owner not found');
  await assertWithinQuota(owner, {
    name: newName, cpu: current.cpu, ram: current.ram, storage: current.storage, os: current.os,
  });

  const node = current.proxmoxNode;
  const vmid = await nextVmId(client);
  const isolate = (await getConfig('isolation_enabled')) !== 'false';

  const vm = await prisma.virtualMachine.create({
    data: {
      userId: current.userId,
      proxmoxVmId: vmid,
      proxmoxNode: node,
      name: newName,
      description: `Copy of ${current.name}`,
      type: 'qemu',
      cpu: current.cpu,
      ram: current.ram,
      storage: current.storage,
      os: current.os,
      tags: current.tags,
      status: 'creating',
      opKind: 'duplicate' satisfies VmOpKind,
      opStartedAt: new Date(),
      // A copy carries the source's tag until it is tagged as its own.
      opSourceId: current.id,
    },
  });
  release(); // usage now includes this row
  const done = beginInFlight(vm.id);

  let created = false;
  let cloneTask: { node: string; upid: string } | undefined;
  try {
    // Full clone (not linked): storage-agnostic and self-contained, so the copy
    // survives the original being deleted — and, being full, it can be placed on
    // the admin's default pool instead of inheriting wherever the source sits.
    const configured = (await getConfig('default_storage')) ?? undefined;
    const storage = configured && (await pve.storageAvailableOn(node, configured, client))
      ? configured
      : undefined;
    const upid = await pve.cloneVm(
      {
        node,
        templateVmid: current.proxmoxVmId,
        newVmid: vmid,
        name: newName,
        full: true,
        storage,
        pool: await pve.getGuestPool(),
        description: cloneNonce(vm.id),
      },
      client,
    );
    cloneTask = { node, upid };
    await recordOpTask(vm.id, upid);
    await pve.waitForTask(node, upid, client, 600_000);
    created = true;
    await markClonedGuest(vm, client); // the copy inherited the source's marker

    // Same as every other clone path: the copy inherited the source's bridge, so the
    // admin's default is applied here (see pve.applyDefaultBridge for why it wins).
    await pve.applyDefaultBridge(node, vmid, client);
    // The copy inherited the source's NIC lines: firewall flag on, no trunks.
    await pve.ensureNicFirewall(node, vmid, client);

    if (isolate) {
      await pve.configureVmIsolation(node, vmid, await pve.readIsolationOptions(), client);
    }

    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped', ...OP_SETTLED } });
    const startUpid = await pve.startVm(node, vmid, client);
    await pve.waitForTask(node, startUpid, client);
    return prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
  } catch (err) {
    await settleFailedCreate(vm, err, created, { task: cloneTask, cloneSourceId: current.id });
    throw err;
  } finally {
    done();
  }
}

/** Owner-or-admin only (owner-exclusive actions: delete, share management, convert). */
export async function getOwnedVm(
  vmId: string,
  user: { id: string; role: string },
): Promise<VirtualMachine | null> {
  const vm = await prisma.virtualMachine.findUnique({ where: { id: vmId } });
  if (!vm) return null;
  if (user.role !== 'admin' && vm.userId !== user.id) return null;
  return vm;
}

/**
 * The caller's relationship to a VM. Owners/admins hold every capability plus
 * the owner-exclusive surface (delete, migrate, shares, passthrough, rebuild);
 * shares hold the capability set of their preset (see CAPS_BY_ROLE).
 */
export type VmAccess = 'owner' | 'admin' | ShareRole;

export interface ResolvedVmAccess {
  vm: VirtualMachine;
  access: VmAccess;
  caps: ReadonlySet<VmCap>;
}

/** Resolve the caller's access + capabilities for a VM, or null if invisible. */
export async function resolveVmAccess(
  vmId: string,
  user: { id: string; role: string },
): Promise<ResolvedVmAccess | null> {
  const vm = await prisma.virtualMachine.findUnique({ where: { id: vmId } });
  if (!vm) return null;
  if (vm.userId === user.id) return { vm, access: 'owner', caps: ALL_CAPS };
  if (user.role === 'admin') return { vm, access: 'admin', caps: ALL_CAPS };
  const share = await prisma.vmShare.findUnique({ where: { vmId_userId: { vmId, userId: user.id } } });
  if (!share) return null;
  const role = normalizeShareRole(share.role);
  return { vm, access: role, caps: CAPS_BY_ROLE[role] };
}

/**
 * THE per-VM route gate: the VM if the caller holds `cap` on it, else null
 * (indistinguishable from "no such VM" — no existence oracle). Owner-exclusive
 * actions (delete/migrate/shares/passthrough/rebuild/convert) use getOwnedVm,
 * never a capability.
 */
export async function getVmWithCap(
  vmId: string,
  user: { id: string; role: string },
  cap: VmCap,
): Promise<VirtualMachine | null> {
  const r = await resolveVmAccess(vmId, user);
  return r && r.caps.has(cap) ? r.vm : null;
}

/** A VM the caller may VIEW (any access level), else null. */
export async function getViewableVm(vmId: string, user: { id: string; role: string }): Promise<VirtualMachine | null> {
  return getVmWithCap(vmId, user, 'view');
}

/** List VMs the user owns OR has been shared (all VMs for admins). */
export async function listVms(user: { id: string; role: string }): Promise<VirtualMachine[]> {
  if (user.role === 'admin') return prisma.virtualMachine.findMany({ orderBy: { createdAt: 'desc' } });
  const shares = await prisma.vmShare.findMany({ where: { userId: user.id }, select: { vmId: true } });
  return prisma.virtualMachine.findMany({
    where: { OR: [{ userId: user.id }, { id: { in: shares.map((s) => s.vmId) } }] },
    orderBy: { createdAt: 'desc' },
  });
}

/** Tag each VM with the caller's access level + capabilities (list/detail responses). */
export async function annotateAccess<T extends { id: string; userId: string }>(
  vms: T[],
  user: { id: string; role: string },
): Promise<(T & { access: VmAccess; caps: VmCap[] })[]> {
  const sharedRoles = new Map<string, string>();
  if (user.role !== 'admin' && vms.some((v) => v.userId !== user.id)) {
    const shares = await prisma.vmShare.findMany({
      where: { userId: user.id, vmId: { in: vms.map((v) => v.id) } },
    });
    for (const s of shares) sharedRoles.set(s.vmId, s.role);
  }
  return vms.map((v) => {
    const access: VmAccess =
      v.userId === user.id ? 'owner'
        : user.role === 'admin' ? 'admin'
          : normalizeShareRole(sharedRoles.get(v.id) ?? '');
    const caps = access === 'owner' || access === 'admin' ? ALL_CAPS : CAPS_BY_ROLE[access];
    const tags = 'tags' in v ? { tags: tagsForAccess((v as { tags: string | null }).tags, access) } : {};
    return { ...v, ...tags, access, caps: [...caps] };
  });
}

/**
 * Migrate a VM to another cluster node (admin op). Live-migrates when it's running,
 * offline otherwise. Honors the arch-aware guardrail (never cross architectures;
 * fail-open on unknown). Waits for the task, then records the new node.
 */
/**
 * Move a VM to another node (live if running, offline if stopped). When
 * `notifyOwner` is set — i.e. an admin kicked this off by hand or via a
 * maintenance drain — the VM's owner gets a branded heads-up email as the move
 * begins (skipped if the owner is the admin who triggered it). The auto-balancer
 * leaves it unset, so routine rebalancing never emails tenants.
 */
export async function migrateVmToNode(
  vm: VirtualMachine,
  targetNode: string,
  opts: {
    notifyOwner?: boolean;
    actorId?: string;
    /** Force an offline migration (caller has already stopped the guest). */
    offline?: boolean;
    /** Relocate all local disks onto this storage on the target. Live moves
     *  mirror across storage types; offline needs format-compatible types. */
    targetstorage?: string;
    /** Max time to wait for the migrate task (default 30 min). Disk relocation
     *  of a large guest can take hours — callers doing storage moves raise it. */
    timeoutMs?: number;
  } = {},
): Promise<VirtualMachine> {
  // Containers can't be live-migrated in ProxMate's API-only model (LXC has no
  // live migration; a restart-migration would mean downtime), so they're excluded
  // from manual moves, the balancer, and drains. Keep them pinned.
  if (kindOf(vm) === 'lxc') throw new Error('Live migration isn’t supported for containers (LXC).');
  // A guest with PCI/GPU passthrough is pinned to its host — can't be migrated.
  // (The passthrough-approval flow migrates BEFORE it attaches, so this guard
  // never applies there; it protects generic admin/balancer moves.)
  if (vm.hasPassthrough) throw new Error('A VM with PCI/GPU passthrough can’t be migrated. Detach the device first.');
  const client = await pve.getClient();
  // Judged against where the guest actually is: the stored node is stale after a
  // move made outside ProxMate (Proxmox HA, the PVE UI).
  vm = await requireOurGuest(vm, { client });
  if (targetNode === vm.proxmoxNode) throw new Error('The VM is already on that node.');

  const nodes = await pve.getNodes(client);
  if (!nodes.some((n) => n.node === targetNode)) throw new Error(`No such node "${targetNode}".`);

  // Architecture guardrail — never migrate an x86 guest onto an ARM node (or vice
  // versa). Fail-open when either node's arch is unknown (mirrors placement).
  const arch = await pve.getNodeArchMap(client);
  const src = arch.get(vm.proxmoxNode);
  const dst = arch.get(targetNode);
  if (src && dst && src !== 'unknown' && dst !== 'unknown' && src !== dst) {
    throw new Error(`Architecture mismatch: ${vm.proxmoxNode} is ${src}, ${targetNode} is ${dst}.`);
  }

  const online = opts.offline ? false : (await getVmWithLiveStatus(vm)).live?.status === 'running';
  const upid = await pve.migrateVm(vm.proxmoxNode, vm.proxmoxVmId, targetNode, online, client, {
    ...(opts.targetstorage ? { targetstorage: opts.targetstorage } : {}),
  });

  // Heads-up to the owner as the move starts (best-effort; never blocks the
  // migration). Only for admin-initiated moves, and not when the admin is moving
  // their own VM.
  if (opts.notifyOwner && opts.actorId !== vm.userId) {
    await notifyOwnerOfMigration(vm, online).catch((err) =>
      console.error(`[migrate] owner notification failed for "${vm.name}":`, err),
    );
  }

  // The migrate task runs on the source node; a live migration can take a
  // while, and an offline storage relocation can take much longer.
  await pve.waitForTask(vm.proxmoxNode, upid, client, opts.timeoutMs ?? 1_800_000);
  return prisma.virtualMachine.update({ where: { id: vm.id }, data: { proxmoxNode: targetNode } });
}

/** Email a VM's owner that maintenance is moving their VM. No-op without SMTP. */
async function notifyOwnerOfMigration(vm: VirtualMachine, live: boolean): Promise<void> {
  if (!(await isMailConfigured())) return;
  const owner = await prisma.user.findUnique({ where: { id: vm.userId } });
  if (!owner?.email) return;
  const mail = vmMaintenanceEmail({ vmName: vm.name, live });
  await sendMail({ to: owner.email, ...mail });
}

/**
 * Update a VM's user-editable metadata: free-text notes (`description`) and/or
 * its `name`. The notes are ProxMate-only; a name change is pushed to Proxmox by
 * the route (via `setVmName`) before this writes the new name to our DB.
 */
export async function updateVm(
  vm: VirtualMachine,
  data: { description?: string | null; name?: string; tags?: string | null },
): Promise<VirtualMachine> {
  return prisma.virtualMachine.update({ where: { id: vm.id }, data });
}

/** Normalize a list of tags to the stored CSV form: lowercase, trimmed, deduped. */
export function normalizeTags(tags: string[]): string {
  const clean = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  return [...new Set(clean)].join(',');
}

/** Thrown when a resize can't be applied (e.g. shrinking a disk, which Proxmox forbids). */
export class ResizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResizeError';
  }
}

/**
 * Quota check for an in-place resize: the VM's *new* totals must fit the user's
 * caps, counting every OTHER VM they own plus the requested target values — so a
 * resize is judged on the delta, not by double-counting the VM's current size.
 */
/**
 * The account a size change is billed to. Quota always tracks the VM's OWNER —
 * a shared-VM Manager resizing someone else's VM must be checked against the
 * owner's caps and usage, not their own (the footprint lands on the owner).
 * Admin callers keep their bypass (assertResizeWithinQuota checks `role`), so
 * they pass through unchanged; a missing owner row (orphaned VM) falls back to
 * the caller, which is the stricter of the two options.
 */
export async function quotaAccountFor(user: User, vm: VirtualMachine): Promise<User> {
  if (user.role === 'admin' || user.id === vm.userId) return user;
  const owner = await prisma.user.findUnique({ where: { id: vm.userId } });
  return owner ?? user;
}

export async function assertResizeWithinQuota(
  user: User,
  vm: VirtualMachine,
  target: { cpu: number; ram: number; storage: number },
): Promise<void> {
  // Admins (cluster owners) are not quota-limited. An admin-granted exempt VM
  // stays exempt across resizes — it never enters quota accounting at all.
  if (user.role === 'admin' || vm.quotaExempt) return;

  const others = await prisma.virtualMachine.findMany({
    where: { userId: user.id, id: { not: vm.id }, quotaExempt: false },
  });
  const usedCpu = others.reduce((s, v) => s + v.cpu, 0);
  const usedRam = others.reduce((s, v) => s + v.ram, 0);
  const usedStorage = others.reduce((s, v) => s + v.storage, 0);

  const violations: Record<string, { used: number; requested: number; max: number }> = {};
  if (usedCpu + target.cpu > user.maxCpu)
    violations['cpu'] = { used: usedCpu, requested: target.cpu, max: user.maxCpu };
  if (usedRam + target.ram > user.maxRam)
    violations['ram'] = { used: usedRam, requested: target.ram, max: user.maxRam };
  if (usedStorage + target.storage > user.maxStorage)
    violations['storage'] = { used: usedStorage, requested: target.storage, max: user.maxStorage };

  if (Object.keys(violations).length > 0) throw new QuotaError(violations);
}

// ─── Restored guests ──────────────────────────────────────────
//
// A MateState restore, a snapshot rollback and a restore-from-upload all bring
// back a whole earlier guest config: cores, memory, disks and PCI devices
// included. Quota is summed from the rows, so after each one the row is re-read
// from the guest, and the earlier config is never allowed to hand back more than
// the owner's quota or a PCI device an admin has since taken away.

/**
 * The quota violations a size change would cause, counting only the dimensions it
 * GROWS — a restore that keeps a dimension as it is never fails on it, even when an
 * admin has since lowered the cap below what the owner already uses.
 */
async function growthViolations(
  vm: VirtualMachine,
  target: { cpu: number; ram: number; storage: number },
): Promise<QuotaError['details']> {
  // A row held for being over quota is judged on the full quota: a repeat restore
  // or rollback that merely keeps the oversize must not count as a repair.
  const full = vm.holdReason === QUOTA_HOLD_MESSAGE;
  const owner = await prisma.user.findUnique({ where: { id: vm.userId } });
  if (!owner) return {};
  try {
    await assertResizeWithinQuota(owner, vm, target);
    return {};
  } catch (err) {
    if (!(err instanceof QuotaError)) throw err;
    const grows: Record<string, boolean> = {
      cpu: full || target.cpu > vm.cpu,
      ram: full || target.ram > vm.ram,
      storage: full || target.storage > vm.storage,
    };
    return Object.fromEntries(Object.entries(err.details).filter(([k]) => grows[k]));
  }
}

export interface RestoreReservation {
  /** The row's sizes before the reservation, put back if the restore never starts. */
  previous: { cpu: number; ram: number; storage: number };
}

/**
 * Reserve, under the owner's quota lock, what a restore or rollback to `cfg` (the
 * config the guest will have afterwards — the archive's or the snapshot's) will
 * use: refused with a QuotaError when it would grow the guest past the owner's
 * quota, otherwise the row is grown to the larger of each size right away. A
 * restore takes minutes; recording the growth up front means a create or resize
 * for the same owner in the meantime is judged against it, not against the old
 * size. syncRestoredGuest later writes what the guest really ended up with.
 */
export async function reserveRestoreGrowth(
  vm: VirtualMachine,
  cfg: Record<string, string>,
): Promise<RestoreReservation> {
  return withQuotaLock(vm.userId, async () => {
    const row = (await prisma.virtualMachine.findUnique({ where: { id: vm.id } })) ?? vm;
    const sizes = guestConfigSizes(cfg, kindOf(row));
    const target = { cpu: sizes.cpu ?? row.cpu, ram: sizes.ram, storage: sizes.storage };
    const violations = await growthViolations(row, target);
    if (Object.keys(violations).length > 0) throw new QuotaError(violations);
    const previous = { cpu: row.cpu, ram: row.ram, storage: row.storage };
    await prisma.virtualMachine.update({
      where: { id: row.id },
      data: {
        cpu: Math.max(row.cpu, target.cpu),
        ram: Math.max(row.ram, target.ram),
        storage: Math.max(row.storage, target.storage),
      },
    });
    return { previous };
  });
}

/** Undo a reservation for a restore whose task never started (the guest is unchanged). */
export async function releaseRestoreReservation(vm: VirtualMachine, r: RestoreReservation): Promise<void> {
  await withQuotaLock(vm.userId, () =>
    prisma.virtualMachine.update({ where: { id: vm.id }, data: r.previous }),
  );
}

/** holdReason of a row a restore left over its owner's storage quota. */
export const QUOTA_HOLD_MESSAGE =
  "After the restore this machine's disks exceed the owner's storage quota, so it can't be started. " +
  'Remove a data disk (or ask an admin to raise the quota), then start it again — or delete it.';

/** holdReason of a row whose restored guest referenced volumes that aren't its own. */
export const FOREIGN_VOLUME_MESSAGE =
  "The restored machine referenced disks that belong to another guest. They were detached and it can't be started — " +
  'ask an admin to check it, or delete it.';

/** Thrown when a restored guest references volumes that aren't its own. */
export class ForeignVolumeError extends Error {
  constructor(public readonly keys: string[]) {
    super(FOREIGN_VOLUME_MESSAGE);
    this.name = 'ForeignVolumeError';
  }
}

/**
 * After any restore or rollback: every volume the guest's config references must
 * be its own VMID's. A tenant-built archive could otherwise point a disk line at
 * another guest's volume, and whether Proxmox lets that through must not matter.
 * Foreign lines that are attached are removed from the config with a plain delete
 * (which only detaches them; nothing is ever freed here, so another guest's data
 * is never touched); a container whose rootfs is foreign is destroyed without
 * purging anything unreferenced. The row is then held, the event audited, and
 * ForeignVolumeError thrown so the caller never starts the guest.
 */
export async function assertOwnVolumes(
  vm: VirtualMachine,
  client?: Awaited<ReturnType<typeof pve.getClient>>,
  /**
   * Volumes listed for this VMID before the restore ran. A volume named for the
   * VMID but already there — left by an earlier guest that had the same VMID —
   * is not this guest's either.
   */
  preexisting?: Set<string>,
  opts: {
    /**
     * Count every `unusedN` line as foreign. For a fresh restore with a pool-scoped
     * token: the volume listing taken before the restore cannot see volumes of a
     * VMID outside the pool, so leftovers would go unnoticed, and vzdump never
     * backs up an unused disk, so none of them can be the archive's own.
     */
    unusedAreForeign?: boolean;
  } = {},
): Promise<void> {
  const c = client ?? (await pve.getClient());
  const kind = kindOf(vm);
  const cfg = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, c, kind);
  const foreign = foreignVolumeKeys(cfg, vm.proxmoxVmId);
  if (opts.unusedAreForeign) {
    for (const key of Object.keys(cfg)) if (/^unused\d+$/.test(key) && !foreign.includes(key)) foreign.push(key);
  }
  if (preexisting && preexisting.size > 0) {
    for (const [key, value] of Object.entries(cfg)) {
      const volume = (String(value).split(',')[0] ?? '').replace(/^file=/, '');
      if (preexisting.has(volume) && !foreign.includes(key)) foreign.push(key);
    }
  }
  if (foreign.length === 0) return;
  const attached = foreign.filter((k) => !/^unused\d+$/.test(k));
  if (attached.includes('rootfs')) {
    await c.delete(`/nodes/${vm.proxmoxNode}/${kind}/${vm.proxmoxVmId}`).catch(() => undefined);
  } else if (attached.length > 0) {
    await c.put(`/nodes/${vm.proxmoxNode}/${kind}/${vm.proxmoxVmId}/config`, new URLSearchParams({ delete: attached.join(',') }));
  }
  await holdErroredRow(vm, FOREIGN_VOLUME_MESSAGE);
  await recordAudit({
    action: 'vm.foreign_volume',
    targetType: 'vm',
    targetId: vm.id,
    detail: `restored guest ${vm.proxmoxVmId} referenced volumes that aren't its own (${foreign.map((k) => `${k}=${cfg[k]}`).join('; ')}); detached and held`,
  });
  throw new ForeignVolumeError(foreign);
}

/** holdReason of a row whose restore or rollback did not finish. */
export const RESTORE_FAILED_MESSAGE =
  "A restore or rollback of this machine didn't finish, so it can't be started. " +
  'Restore a backup again, rebuild it, or delete it.';

/**
 * Put a row into `error` with an explanation: its guest may not run until a
 * repair path has re-checked it (see requireOurGuest).
 */
export async function holdErroredRow(vm: VirtualMachine, message: string): Promise<void> {
  await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'error', holdReason: message, ...OP_SETTLED } });
}

/**
 * Lift a restore's over-quota hold once the row fits the owner's quota again (a
 * data disk was removed, or an admin raised the quota). Call under the owner's
 * quota lock. Returns whether the hold was lifted.
 */
export async function liftQuotaHoldIfFits(vmId: string): Promise<boolean> {
  const row = await prisma.virtualMachine.findUnique({ where: { id: vmId } });
  if (!row || row.holdReason !== QUOTA_HOLD_MESSAGE) return false;
  const owner = await prisma.user.findUnique({ where: { id: row.userId } });
  if (owner) {
    try {
      await assertResizeWithinQuota(owner, row, { cpu: row.cpu, ram: row.ram, storage: row.storage });
    } catch (err) {
      if (err instanceof QuotaError) return false;
      throw err;
    }
  }
  await prisma.virtualMachine.update({ where: { id: vmId }, data: { status: 'stopped', holdReason: null, ...OP_SETTLED } });
  return true;
}

/**
 * The PCI lines a guest may keep through a restore or rollback: the ones attached
 * to it right now, and only while the row says a device is approved. Read before
 * the restore, since the restore replaces them.
 */
export async function approvedPciLines(
  vm: VirtualMachine,
  client?: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<string[]> {
  if (!vm.hasPassthrough || kindOf(vm) !== 'qemu') return [];
  const cfg = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, client, 'qemu').catch(() => ({}) as Record<string, string>);
  return pciLines(cfg).map((l) => l.value);
}

/**
 * After a restore or rollback: drop PCI devices that aren't approved for this VM,
 * then re-read cpu/ram/storage from the guest into its row (under the owner's quota
 * lock). A CPU or RAM size that no longer fits the owner's quota is set back to the
 * row's current size; a disk total that doesn't fit is recorded as it is (disks
 * can't shrink) and refused with a QuotaError so the caller leaves the guest off.
 */
export async function syncRestoredGuest(
  vm: VirtualMachine,
  opts: { approvedPci: string[]; client?: Awaited<ReturnType<typeof pve.getClient>> },
): Promise<VirtualMachine> {
  return withQuotaLock(vm.userId, async () => {
    const client = opts.client ?? (await pve.getClient());
    const fresh = await prisma.virtualMachine.findUnique({ where: { id: vm.id } });
    const row = fresh ? { ...fresh, proxmoxNode: vm.proxmoxNode } : vm;
    const kind = kindOf(row);
    const path = `/nodes/${row.proxmoxNode}/${kind}/${row.proxmoxVmId}/config`;
    const cfg = await pve.getVmConfig(row.proxmoxNode, row.proxmoxVmId, client, kind);

    const approved = new Set(opts.approvedPci);
    const unapproved = pciLines(cfg).filter((l) => !approved.has(l.value)).map((l) => l.key);
    if (unapproved.length > 0) {
      await client.put(path, new URLSearchParams({ delete: unapproved.join(',') }));
      for (const k of unapproved) delete cfg[k];
    }

    // A disk the earlier config doesn't have (added after the backup or snapshot)
    // comes back detached, as an `unusedN` volume. ProxMate can neither reattach
    // nor remove such a volume, so it would be storage the owner pays for and can
    // never use or free; it is deleted, as removeDisk does with the volume a
    // detach leaves behind. Proxmox refuses for a volume an existing snapshot still
    // uses — that one stays until the snapshot is deleted.
    const foreignUnused = new Set(foreignVolumeKeys(cfg, row.proxmoxVmId));
    for (const key of Object.keys(cfg).filter((k) => /^unused\d+$/.test(k) && !foreignUnused.has(k))) {
      try {
        await client.put(path, new URLSearchParams({ delete: key }));
        delete cfg[key];
      } catch (err) {
        console.warn(`[vm] kept ${key} of "${row.name}": ${pve.pveMessage(err)}`);
      }
    }

    const sizes = guestConfigSizes(cfg, kind);
    // A container with no `cores` line may use every host core; pin it to the row's.
    let setResources = sizes.cpu === null;
    // ProxMate's cpu is the total vCPU count, written as one socket of that many
    // cores (see pve.setVmResources); a restored multi-socket or `vcpus` layout is
    // rewritten in that form so later resizes act on the total.
    if (kind === 'qemu' && ((cfg['sockets'] ?? '1') !== '1' || cfg['vcpus'] !== undefined || !/^\d+$/.test(cfg['memory'] ?? '0'))) {
      setResources = true;
    }
    let cpu = sizes.cpu ?? row.cpu;
    let ram = sizes.ram;
    const violations = await growthViolations(row, { cpu, ram, storage: sizes.storage });
    if (violations['cpu']) { cpu = row.cpu; setResources = true; }
    if (violations['ram']) { ram = row.ram; setResources = true; }
    if (setResources) await pve.setVmResources(row.proxmoxNode, row.proxmoxVmId, cpu, ram, client, kind);

    const updated = await prisma.virtualMachine.update({
      where: { id: row.id },
      data: {
        cpu,
        ram,
        storage: sizes.storage,
        ...(kind === 'qemu' ? { hasPassthrough: pciLines(cfg).length > 0 } : {}),
      },
    });
    if (violations['storage']) {
      // Disks can't shrink: record what is really there, and keep the guest from
      // running until the owner is back within quota.
      await holdErroredRow(updated, QUOTA_HOLD_MESSAGE);
      throw new QuotaError({ storage: violations['storage'] });
    }
    return updated;
  });
}

export interface ResizeVmInput {
  cpu?: number;
  ram?: number; // MB
  storage?: number; // GB (grow-only)
}

/**
 * Change a VM's allocated CPU/RAM/disk in place. Disk is grow-only (Proxmox can't
 * shrink). Each Proxmox change is written to our DB right after it lands —
 * Proxmox-first, mirroring the rename flow — so a mid-way failure never leaves the
 * DB claiming resources the cluster didn't apply. CPU/RAM changes the guest can't
 * hot-plug take effect on the VM's next start. Returns the updated VM (unchanged
 * if the request is a no-op).
 */
export async function resizeVm(
  user: User,
  vm: VirtualMachine,
  input: ResizeVmInput,
): Promise<VirtualMachine & { autoSnapshot?: AutoSnapshotResult }> {
  // Check and the DB write that records the new size run under the owner's quota
  // lock, so a concurrent create or resize can't both pass on the old usage.
  return withQuotaLock(vm.userId, () => resizeVmLocked(user, vm, input));
}

async function resizeVmLocked(
  user: User,
  staleVm: VirtualMachine,
  input: ResizeVmInput,
): Promise<VirtualMachine & { autoSnapshot?: AutoSnapshotResult }> {
  // Judge the request against the row as it is NOW (under the lock), not as the
  // caller loaded it — a data-disk change may have landed in between.
  const vm = await prisma.virtualMachine.findUnique({ where: { id: staleVm.id } });
  if (!vm) throw new ResizeError('This machine no longer exists.');
  const targetCpu = input.cpu ?? vm.cpu;
  const targetRam = input.ram ?? vm.ram;
  const targetStorage = input.storage ?? vm.storage;

  // Proxmox can only grow a disk, never shrink it.
  if (targetStorage < vm.storage) {
    throw new ResizeError(
      `Disks can only grow — ${targetStorage}GB is smaller than the current ${vm.storage}GB.`,
    );
  }

  const resourcesChanged = targetCpu !== vm.cpu || targetRam !== vm.ram;
  const growDisk = targetStorage > vm.storage;
  if (!resourcesChanged && !growDisk) return vm; // nothing to do

  await assertResizeWithinQuota(await quotaAccountFor(user, vm), vm, { cpu: targetCpu, ram: targetRam, storage: targetStorage });

  const client = await pve.getClient();
  let current = await requireOurGuest(vm, { client });
  const kind = kindOf(current);

  // Resolve the disk up-front so a missing/unresizable disk fails before we
  // change anything else. LXC's root volume is always `rootfs`; a QEMU VM's
  // primary disk is a bus slot (scsi0, …) we read from its config.
  //
  // `storage` is the VM's TOTAL (root + data disks — see disk.service), so the
  // request is a change of the total. The root disk grows by that delta from its
  // own current size; sizing it to the total would hand out the data disks' GB a
  // second time, uncounted.
  let diskKey: string | undefined;
  let rootTargetGb = 0;
  if (growDisk) {
    const cfg = await pve.getVmConfig(current.proxmoxNode, current.proxmoxVmId, client, kind);
    diskKey = kind === 'lxc' ? 'rootfs' : pve.findPrimaryDisk(cfg);
    if (!diskKey || !cfg[diskKey]) throw new ResizeError('Could not find a resizable disk on this VM.');
    rootTargetGb = diskSizeGb(cfg[diskKey]) + (targetStorage - vm.storage);
  }

  // A way back before anything changes; if it can't be taken, nothing is changed.
  const autoSnapshot = await autoSnapshotBefore(current, 'resize', client);

  if (resourcesChanged) {
    await pve.setVmResources(current.proxmoxNode, current.proxmoxVmId, targetCpu, targetRam, client, kind);
    current = await prisma.virtualMachine.update({
      where: { id: current.id },
      data: { cpu: targetCpu, ram: targetRam },
    });
  }

  if (growDisk && diskKey) {
    await pve.resizeDisk(current.proxmoxNode, current.proxmoxVmId, diskKey, rootTargetGb, client, kind);
    current = await prisma.virtualMachine.update({
      where: { id: current.id },
      data: { storage: { increment: targetStorage - vm.storage } },
    });
  }

  return { ...current, autoSnapshot };
}

/** Set (or clear, with nulls) a VM's auto start/stop cron schedule. */
export async function setPowerSchedule(
  vm: VirtualMachine,
  data: { startCron: string | null; stopCron: string | null },
): Promise<VirtualMachine> {
  return prisma.virtualMachine.update({ where: { id: vm.id }, data });
}

/**
 * Ensures the VM's stored node in our database is correct by checking cluster resources.
 * If Proxmox reports the VM is on a different node, we update the DB.
 */
export async function syncVmNode(vm: VirtualMachine): Promise<VirtualMachine> {
  return (await syncVmNodeChecked(vm)).vm;
}

/** syncVmNode that also says whether Proxmox could actually be asked (`synced`). */
export async function syncVmNodeChecked(vm: VirtualMachine): Promise<{ vm: VirtualMachine; synced: boolean }> {
  try {
    const client = await pve.getClient();
    const res = await client.get<{ data: Array<{ type: string; vmid?: number; node?: string }> }>('/cluster/resources');
    const match = res.data.data.find(
      (r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid === vm.proxmoxVmId
    );
    if (match && match.node && match.node !== vm.proxmoxNode) {
      const updated = await prisma.virtualMachine.update({
        where: { id: vm.id },
        data: { proxmoxNode: match.node },
      });
      return { vm: updated, synced: true };
    }
    return { vm, synced: true };
  } catch (err) {
    console.error('Failed to sync VM node from Proxmox:', err);
  }
  return { vm, synced: false };
}

/** Merge a VM's DB record with its live Proxmox status (best-effort). */
/**
 * The ids of those rows whose VMID currently holds a guest carrying the row's own
 * ProxMate tag, from one /cluster/resources listing. Status and IP syncing use it so
 * another guest's state is never written onto a row.
 */
async function rowsWithTaggedGuest(
  vms: Array<Pick<VirtualMachine, 'id' | 'proxmoxVmId'>>,
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<Set<string>> {
  const res = await client.get<{ data: Array<{ type: string; vmid?: number; tags?: string }> }>('/cluster/resources?type=vm');
  const tagsByVmid = new Map<number, string | undefined>();
  for (const r of res.data.data) {
    if ((r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined) tagsByVmid.set(r.vmid, r.tags);
  }
  return new Set(vms.filter((v) => tagsMarkRow(tagsByVmid.get(v.proxmoxVmId), v.id)).map((v) => v.id));
}

export async function getVmWithLiveStatus(
  vm: VirtualMachine,
): Promise<VirtualMachine & { live: pve.PveVmStatus | null }> {
  let currentVm = vm;
  const kind = kindOf(vm);
  try {
    // Another guest's status (and IP) must never be shown as, or written onto, this row.
    if (!(await rowsWithTaggedGuest([vm], await pve.getClient())).has(vm.id)) return { ...vm, live: null };
    let live: pve.PveVmStatus;
    try {
      live = await pve.getVmStatus(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kind);
    } catch (err) {
      // If VM is not found on the stored node, check if it migrated
      const syncedVm = await syncVmNode(currentVm);
      if (syncedVm.proxmoxNode !== currentVm.proxmoxNode) {
        currentVm = syncedVm;
        live = await pve.getVmStatus(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kind);
      } else {
        throw err;
      }
    }

    // Keep the DB status loosely in sync with reality.
    // A held row keeps its state: only a repair path may make it startable again.
    if (live.status && live.status !== currentVm.status && currentVm.status !== 'creating' && !isHeld(currentVm)) {
      await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: live.status } });
      currentVm.status = live.status;
    }
    // Refresh the guest IP (best-effort, needs qemu-guest-agent in the guest).
    if (currentVm.status === 'running') await refreshVmIps([currentVm]);
    return { ...currentVm, live };
  } catch {
    return { ...currentVm, live: null };
  }
}

/**
 * Best-effort refresh of guest IPs via the QEMU guest agent, caching the results
 * on `VirtualMachine.ipAddress` / `.tailscaleIp`. Only running VMs are queried
 * (the agent is unreachable otherwise) and failures are swallowed — a missing
 * agent never breaks the list, it just leaves the IP blank. The LAN IP is sticky
 * (never cleared, so a brief agent hiccup keeps the last known address); the
 * Tailscale IP is cleared when it stops being advertised, since a stale tailnet
 * address is misleading. Mutates + returns the same array.
 */
export async function refreshVmIps<T extends VirtualMachine>(vms: T[]): Promise<T[]> {
  const candidates = vms.filter((v) => v.status === 'running');
  if (candidates.length === 0) return vms;
  const client = await pve.getClient();
  // Only rows whose VMID holds their own tagged guest (best-effort: none on a failed listing).
  const tagged = await rowsWithTaggedGuest(candidates, client).catch(() => new Set<string>());
  const running = candidates.filter((v) => tagged.has(v.id));
  await Promise.all(
    running.map(async (vm) => {
      // LXC has no guest agent — Proxmox reads the container's IPs directly.
      const { ip, tailscaleIp } =
        kindOf(vm) === 'lxc'
          ? await pve.getLxcIps(vm.proxmoxNode, vm.proxmoxVmId, client)
          : await pve.getVmIps(vm.proxmoxNode, vm.proxmoxVmId, client);
      const data: { ipAddress?: string; tailscaleIp?: string | null } = {};
      if (ip && ip !== vm.ipAddress) {
        vm.ipAddress = ip;
        data.ipAddress = ip;
      }
      // Only meaningful when the interface listing was readable at all — a null
      // ip AND null tailscaleIp usually means the agent was unreachable, so we
      // leave the cached tailnet address alone rather than flap it.
      if ((ip || tailscaleIp) && tailscaleIp !== vm.tailscaleIp) {
        vm.tailscaleIp = tailscaleIp;
        data.tailscaleIp = tailscaleIp;
      }
      if (Object.keys(data).length > 0) {
        await prisma.virtualMachine
          .update({ where: { id: vm.id }, data })
          .catch(() => undefined);
      }
    }),
  );
  return vms;
}

export interface LiveUsage {
  cpu: number; // cores currently in use (sum of cpu-fraction × cores over running VMs)
  mem: number; // bytes of RAM currently in use
  maxMem: number; // bytes of RAM allocated to the running VMs
  running: number; // count of running VMs
}

/**
 * Live aggregate resource usage of the requesting user's OWN VMs, from a single
 * `/cluster/resources` call. Drives the dashboard's live-usage sparklines.
 */
export async function getLiveUsage(user: { id: string }): Promise<LiveUsage> {
  const vms = await prisma.virtualMachine.findMany({
    where: { userId: user.id },
    select: { id: true, proxmoxVmId: true },
  });
  // VMID → row id: a guest counts only when it carries that row's own tag.
  const rowByVmid = new Map(vms.map((v) => [v.proxmoxVmId, v.id]));
  const empty: LiveUsage = { cpu: 0, mem: 0, maxMem: 0, running: 0 };
  if (rowByVmid.size === 0) return empty;

  const client = await pve.getClient();
  const res = await client.get<{
    data: Array<{ type: string; vmid?: number; status?: string; cpu?: number; maxcpu?: number; mem?: number; maxmem?: number; tags?: string }>;
  }>('/cluster/resources');

  const usage = { ...empty };
  for (const r of res.data.data) {
    const rowId = r.vmid !== undefined ? rowByVmid.get(r.vmid) : undefined;
    if ((r.type === 'qemu' || r.type === 'lxc') && rowId && tagsMarkRow(r.tags, rowId) && r.status === 'running') {
      usage.cpu += (r.cpu ?? 0) * (r.maxcpu ?? 0);
      usage.mem += r.mem ?? 0;
      usage.maxMem += r.maxmem ?? 0;
      usage.running += 1;
    }
  }
  usage.cpu = Math.round(usage.cpu * 100) / 100;
  return usage;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a VM's status until it reports "stopped" or the timeout elapses. */
async function waitForStopped(
  node: string,
  vmid: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  timeoutMs = 25_000,
  kind: pve.GuestKind = 'qemu',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const s = await pve.getVmStatus(node, vmid, client, kind);
      if (s.status === 'stopped') return;
    } catch {
      return; // VM is gone — nothing left to wait for
    }
  }
}

/**
 * Hard-stop (if needed) and delete a VM on Proxmox, leaving our DB row untouched.
 * A VM that no longer exists on Proxmox is treated as already gone (not an error),
 * so callers can clean up / re-provide regardless. Shared by destroyVm and rebuildVm.
 */
async function stopAndDeleteProxmoxVm(
  node: string,
  vmid: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  kind: pve.GuestKind = 'qemu',
): Promise<void> {
  // Proxmox refuses to delete a running VM, and stop is an async task — so
  // hard-stop first and wait until it's actually stopped before deleting.
  try {
    const status = await pve.getVmStatus(node, vmid, client, kind);
    if (status.status !== 'stopped') {
      await pve.stopVm(node, vmid, client, kind);
      await waitForStopped(node, vmid, client, 25_000, kind);
    }
  } catch {
    /* status unavailable or VM already gone — fall through to delete */
  }

  try {
    await pve.deleteVm(node, vmid, client, kind);
  } catch (err) {
    // If the VM no longer exists on Proxmox, treat it as already deleted.
    const msg = pve.pveMessage(err);
    if (!/does not exist|not found/i.test(msg)) throw err;
  }
}

/**
 * Delete a machine. Its guest is destroyed only when it is demonstrably this row's;
 * if the VMID is empty or holds another row's guest, the row is all there is to
 * remove. A guest with no ProxMate tag (created before tags existed) is neither
 * destroyed nor silently orphaned: the delete is refused until an admin adopts it,
 * or an admin removes just the row with `rowOnly`.
 */
export async function destroyVm(vm: VirtualMachine, opts: { rowOnly?: boolean } = {}): Promise<void> {
  if (opts.rowOnly) {
    // Removing only the record of a machine whose guest IS confirmed as its own would
    // orphan a live, tagged guest — that's what a normal delete is for.
    // And that is only known when the cluster-wide lookup worked: on a stale node an
    // own guest that has moved reads as "absent".
    const { vm: current, synced } = await syncVmNodeChecked(vm);
    if (!synced) throw new Error("Couldn't confirm where this machine's guest is on the cluster — try again.");
    if ((await guestIdentity(current)) === 'ours') {
      throw new GuestIdentityError('ours');
    }
    await deleteVmRow(vm.id);
    return;
  }
  const { vm: currentVm, synced } = await syncVmNodeChecked(vm);
  const client = await pve.getClient();
  const identity = await guestIdentity(currentVm, client);
  if (identity === 'unmarked') throw new GuestIdentityError('unmarked');
  // "Not on the stored node" only means gone when the cluster-wide lookup worked;
  // otherwise the guest may simply have moved, and dropping the row would orphan it.
  if (identity === 'absent' && !synced) {
    throw new Error("Couldn't confirm where this machine's guest is on the cluster — try again.");
  }
  if (identity === 'ours') {
    await stopAndDeleteProxmoxVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, client, kindOf(currentVm));
  }
  await deleteVmRow(currentVm.id);
}

/**
 * Why a machine can't be deleted with its guest right now, or null when it can:
 * its guest carries no ProxMate tag (adopt it or remove the row first), or where
 * the guest is can't be confirmed. Used to refuse an account deletion up front
 * rather than orphan guests.
 */
export async function destroyBlocker(vm: VirtualMachine): Promise<string | null> {
  try {
    const { vm: current, synced } = await syncVmNodeChecked(vm);
    const identity = await guestIdentity(current);
    if (identity === 'unmarked') return "its guest predates ProxMate's ownership tags — adopt it or remove the row first";
    if (identity === 'absent' && !synced) return "couldn't confirm where its guest is on the cluster";
    return null;
  } catch (err) {
    return `couldn't check its guest (${pve.pveMessage(err)})`;
  }
}

/**
 * Source for a rebuild: either a fresh ISO install or a redeploy from a published
 * template / cloud image (with the cloud-init login details re-supplied).
 */
export type RebuildSource =
  | { kind: 'iso'; os: string }
  | { kind: 'template'; template: Template; cloud: CloudInitInput };

/**
 * Re-image an existing VM in place: destroy its current Proxmox VM (keeping our DB
 * row and its VMID/name/owner), then re-provision into the SAME VMID from the chosen
 * source and start it. Resources (cpu/ram) are preserved; a template whose base disk
 * is larger than the VM's current disk grows it (quota-checked). This is destructive
 * — the old disk and all its data are gone. A mid-way failure is settled by
 * settleFailedRebuild (row kept in `error` only when it still has a guest or backups).
 */
export async function rebuildVm(
  user: User,
  vm: VirtualMachine,
  source: RebuildSource,
): Promise<VirtualMachine> {
  // A template rebuild can grow the disk: its quota check and the row update that
  // records the new size run under the owner's lock (released once that is written).
  const release = await acquireQuotaLock(vm.userId);
  const done = beginInFlight(vm.id);
  try {
    return await rebuildVmLocked(user, vm, source, release);
  } finally {
    release();
    done();
  }
}

async function rebuildVmLocked(
  user: User,
  vm: VirtualMachine,
  source: RebuildSource,
  release: () => void,
): Promise<VirtualMachine> {
  const client = await pve.getClient();
  // Never re-image a guest that isn't this row's. An empty VMID is fine to build into.
  const current = await requireOurGuest(vm, { allowAbsent: true, allowError: true, client });
  const vmid = current.proxmoxVmId;
  const isolate = (await getConfig('isolation_enabled')) !== 'false';

  // Decide the target node + final disk size + the OS label we'll store, and run a
  // quota check if a template's base disk would grow this VM's allocation.
  let targetNode = current.proxmoxNode;
  let diskGb = current.storage;
  let osLabel: string;
  let storage: string | undefined;
  let bridge: string | undefined;
  let isoStorage: string | undefined;

  if (source.kind === 'iso') {
    const cfg = await Promise.all([
      getConfig('default_storage'),
      getConfig('default_bridge'),
      getConfig('iso_storage'),
    ]);
    [storage, bridge, isoStorage] = cfg as [string, string, string];
    if (!storage || !bridge || !isoStorage) {
      throw new Error('Server defaults are not configured — finish setup first');
    }
    // The VM must be rebuilt on a node that actually holds the ISO. Prefer the
    // current node; otherwise place it where the ISO lives with the most capacity.
    const isoNodes = await pve.getIsoNodes(isoStorage, source.os, client);
    if (isoNodes.length === 0) {
      throw new Error(
        `Install ISO "${source.os}" isn't available on any node's "${isoStorage}" storage.`,
      );
    }
    targetNode = isoNodes.includes(current.proxmoxNode)
      ? current.proxmoxNode
      : await pve.pickBestNode(
          { cpu: current.cpu, ramMb: current.ram, storageGb: current.storage },
          storage,
          client,
          isoNodes,
          'amd64',
        );
    osLabel = source.os;
  } else {
    const { template } = source;
    targetNode = template.proxmoxNode; // a clone stays on the template's node
    diskGb = Math.max(current.storage, template.diskGb || current.storage);
    osLabel = template.os ?? template.name;
    if (diskGb !== current.storage) {
      await assertResizeWithinQuota(await quotaAccountFor(user, current), current, {
        cpu: current.cpu,
        ram: current.ram,
        storage: diskGb,
      });
    }
  }

  // A successful rebuild clears the row's hold. One held for being over quota is
  // only cleared when the rebuilt size fits the full quota — otherwise the rebuild
  // would just hand back a startable machine that is still over it.
  if (current.holdReason === QUOTA_HOLD_MESSAGE) {
    await assertResizeWithinQuota(await quotaAccountFor(user, current), current, {
      cpu: current.cpu,
      ram: current.ram,
      storage: diskGb,
    });
  }

  // Point of no return: tear down the existing VM, then mark the row rebuilding.
  // Deleting the guest deletes every snapshot it had, automatic ones included.
  await stopAndDeleteProxmoxVm(current.proxmoxNode, vmid, client);
  await prisma.virtualMachine.update({
    where: { id: current.id },
    data: {
      status: 'creating',
      ipAddress: null,
      proxmoxNode: targetNode,
      os: osLabel,
      storage: diskGb,
      opKind: (source.kind === 'iso' ? 'rebuild-iso' : 'rebuild-template') satisfies VmOpKind,
      opStartedAt: new Date(),
      opUpid: null,
      opSourceId: source.kind === 'template' ? source.template.id : null,
    },
  });
  await (async () => prisma.autoSnapshot.deleteMany({ where: { vmId: current.id } }))().catch(() => undefined);
  release(); // usage now reflects the rebuilt size

  let created = false;

  try {
    if (source.kind === 'iso') {
      const createUpid = await pve.createVm(
        {
          node: targetNode,
          vmid,
          name: current.name,
          cores: current.cpu,
          memory: current.ram,
          diskGb: current.storage,
          storage: storage!,
          bridge: bridge!,
          isoStorage: isoStorage!,
          iso: source.os,
          tags: guestMarker(current.id),
          pool: await pve.getGuestPool(),
        },
        client,
      );
      await recordOpTask(current.id, createUpid);
      await pve.waitForTask(targetNode, createUpid, client);
      created = true;
      if (isolate) {
        await pve.configureVmIsolation(targetNode, vmid, await pve.readIsolationOptions(), client);
      }
    } else {
      const { template } = source;
      const plan = await planTemplateClone(targetNode, template, client);
      const upid = await pve.cloneVm(
        {
          node: targetNode,
          templateVmid: template.proxmoxVmId,
          newVmid: vmid,
          name: current.name,
          full: plan.full,
          storage: plan.storage,
          pool: await pve.getGuestPool(),
          description: cloneNonce(current.id),
        },
        client,
      );
      await recordOpTask(current.id, upid);
      await pve.waitForTask(targetNode, upid, client, 600_000);
      created = true;
      await markClonedGuest({ ...current, proxmoxNode: targetNode }, client);
      await configureClonedVm(
        { node: targetNode, vmid, template, cpu: current.cpu, ram: current.ram, diskGb, isolate, cloud: source.cloud },
        client,
      );
    }

    // The rebuilt guest is configured from scratch: a successful rebuild is a repair.
    await prisma.virtualMachine.update({
      where: { id: current.id },
      data: { status: 'stopped', holdReason: null, ...OP_SETTLED },
    });
    const startUpid = await pve.startVm(targetNode, vmid, client);
    await pve.waitForTask(targetNode, startUpid, client);
    // A template rebuild re-runs cloud-init on the fresh clone, so lock it until
    // that settles. Either way the disk is wiped, so drop any prior IDE-install
    // marker — a stale 'ready' would point the IDE button at a guest with no code-server.
    const deploying = source.kind !== 'iso' && source.template.cloudInit;
    return prisma.virtualMachine.update({
      where: { id: current.id },
      data: {
        status: 'running',
        ideState: null,
        ideStateAt: null,
        deployState: deploying ? 'deploying' : null,
        deployStateAt: deploying ? new Date() : null,
        // A rebuild re-runs cloud-init on a fresh disk, so the password has to be
        // re-applied the same way — via the agent, never through the seed. Cleared
        // on an ISO rebuild, where there is no cloud-init to wait for.
        pendingCiPassword:
          deploying && source.kind === 'template' && source.cloud.password
            ? encrypt(source.cloud.password)
            : null,
      },
    });
  } catch (err) {
    await settleFailedRebuild({ ...current, proxmoxNode: targetNode }, err, created);
    throw err;
  }
}

/**
 * Settle a rebuild that failed after the old guest was torn down — like
 * settleFailedCreate, the row only keeps pointing at its VMID when a guest of ours
 * is there. The one exception is a machine with backups: the row is what those
 * backups hang off, and restoring one into the (empty) VMID is the way back, so it
 * stays in `error` (every action on it re-checks the guest). The owner is told
 * either way.
 */
export async function settleFailedRebuild(vm: VirtualMachine, err: unknown, guestCreated: boolean): Promise<void> {
  const ours = guestCreated || (await guestIdentity(vm).then((id) => id === 'ours', () => true));
  const hasBackups = !ours && (await prisma.mateState.count({ where: { vmId: vm.id } }).catch(() => 1)) > 0;
  const kept = ours || hasBackups;
  if (kept) {
    await markVmError(vm.id, vm.name, err).catch(() => undefined);
  } else {
    await deleteVmRow(vm.id).catch(() => undefined);
    await notify({
      event: 'vm.error',
      title: vm.name,
      message: `Rebuild of "${vm.name}" failed: ${pve.pveMessage(err)}`,
    }).catch(() => undefined);
  }
  await notifyOwnerOfFailedRebuild(vm, kept, err).catch((e) =>
    console.error(`[rebuild] owner notification failed for "${vm.name}":`, e),
  );
}

export async function notifyOwnerOfFailedRebuild(vm: VirtualMachine, kept: boolean, err: unknown): Promise<void> {
  if (!(await isMailConfigured())) return;
  const owner = await prisma.user.findUnique({ where: { id: vm.userId } });
  if (!owner?.email) return;
  await sendMail({ to: owner.email, ...vmRebuildFailedEmail({ vmName: vm.name, kept, reason: pve.pveMessage(err) }) });
}

/**
 * Guard a power-on against the OWNER's compute window — not the caller's.
 *
 * Without this, suspension is decorative on any shared VM: a co-owner whose own
 * access is fine holds the `power` capability, so one click on Start undoes the
 * suspension of the machine's actual owner.
 */
export async function assertOwnerAccessActive(vm: VirtualMachine): Promise<void> {
  const owner = await prisma.user.findUnique({
    where: { id: vm.userId },
    select: { role: true, accessExpiresAt: true },
  });
  if (owner && isAccessExpired(owner)) {
    throw new Error("This machine's owner has reached the end of their compute access window.");
  }
}

export async function startVm(vm: VirtualMachine): Promise<void> {
  await assertOwnerAccessActive(vm);
  const currentVm = await requireOurGuest(vm);
  const upid = await pve.startVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kindOf(currentVm));
  // Same reasoning as stopVm: only a task that finished OK means the guest is up.
  await awaitPowerTask(
    currentVm.proxmoxNode,
    upid,
    'The guest is still starting — check again in a moment.',
  );
  await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: 'running' } });
}

/**
 * Proxmox runs a stop or shutdown ASYNCHRONOUSLY: the POST returns a task UPID and
 * nothing more. Firing it and assuming it worked made a graceful shutdown the guest
 * ignores — `qmshutdown: VM quit/powerdown failed - got timeout`, routine for a
 * guest with no ACPI handler, mid-boot or hung — report success and write
 * `status: 'stopped'` over a guest that was still running. The row self-healed on
 * the next reconcile, but the caller had already been told the machine was off, and
 * the next action paid for it: a destroy straight after came back
 * `VM 106 is running - destroy failed`. So wait for the task and let its exit
 * status decide; on failure nothing is written and the error reaches the user.
 *
 * The wait is deliberately BOUNDED and well under a reverse proxy's own ceiling
 * (the Cloudflare Tunnel in front of production gives up around 100s): this runs
 * inside the HTTP request, and `POST /api/vms/bulk` loops over it. A guest that has
 * not gone down by then is the very case this function exists to report, so say so
 * instead of waiting on it.
 */
const POWER_TASK_TIMEOUT_MS = 45_000;

/**
 * Wait for a power task and let its exit status decide. A task Proxmox reports as
 * failed throws its own message. Running past our deadline is not a Proxmox refusal
 * — the task may yet finish — so it throws `onTimeout`, something the user can act
 * on, rather than "Proxmox task timed out"; the caller writes nothing either way and
 * the reconciler records whatever actually happens.
 */
async function awaitPowerTask(node: string, upid: string, onTimeout: string | null): Promise<void> {
  try {
    await pve.waitForTask(node, upid, undefined, POWER_TASK_TIMEOUT_MS);
  } catch (err) {
    if (onTimeout && /task timed out/i.test(pve.pveMessage(err))) throw new Error(onTimeout);
    throw err;
  }
}

export async function stopVm(vm: VirtualMachine, force: boolean): Promise<void> {
  const currentVm = await requireOurGuest(vm, { allowError: true });
  const kind = kindOf(currentVm);
  const upid = force
    ? await pve.stopVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kind)
    : await pve.shutdownVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kind);
  await awaitPowerTask(
    currentVm.proxmoxNode,
    upid,
    force
      ? null
      : 'The guest has not shut down yet — it may be ignoring the shutdown request. ' +
          'Give it a moment, or stop it forcibly.',
  );
  if (!isHeld(currentVm)) {
    await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: 'stopped' } });
  }
}

export async function restartVm(vm: VirtualMachine): Promise<void> {
  await assertOwnerAccessActive(vm); // same owner-window guard as startVm
  const currentVm = await requireOurGuest(vm);
  const upid = await pve.rebootVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kindOf(currentVm));
  // A reboot is a graceful shutdown then a start, so a guest that ignores ACPI hangs
  // it exactly as it hangs a shutdown.
  await awaitPowerTask(
    currentVm.proxmoxNode,
    upid,
    'The guest has not restarted yet — it may be ignoring the shutdown request. ' +
      'Give it a moment, or stop it forcibly and start it again.',
  );
  await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: 'running' } });
}

/**
 * Pause (QEMU suspend) a running VM — execution freezes with RAM resident, so
 * resuming is instant. DB status stays "running" (the guest is still resident on
 * the node and holding its resources); the live qmpstatus reports "paused".
 * QEMU-only: Proxmox's LXC suspend is experimental, so containers are rejected.
 */
export async function pauseVm(vm: VirtualMachine): Promise<void> {
  if (kindOf(vm) === 'lxc') throw new Error('Containers (LXC) cannot be paused');
  const client = await pve.getClient();
  const currentVm = await requireOurGuest(vm, { client });
  await pve.suspendVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, client);
}

/** Resume a paused VM. QEMU-only, the counterpart of {@link pauseVm}. */
export async function resumeVm(vm: VirtualMachine): Promise<void> {
  if (kindOf(vm) === 'lxc') throw new Error('Containers (LXC) cannot be paused');
  // Resuming is a power-ON: gate on the OWNER's window (a share-holder whose
  // own access is fine must not be able to revive a suspended tenant's guest).
  await assertOwnerAccessActive(vm);
  const client = await pve.getClient();
  const currentVm = await requireOurGuest(vm, { client });
  await pve.resumeVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, client);
}

// ─── Guest password reset ─────────────────────────────────────

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * A CSPRNG-generated, unambiguous (no 0/O/1/l/I) 20-char guest password.
 * Uses `crypto.randomInt` for an *unbiased* index into the alphabet — plain
 * `randomBytes % length` skews toward the first (256 % length) characters.
 */
export function generateGuestPassword(): string {
  let out = '';
  for (let i = 0; i < 20; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

/**
 * Reset a user's password inside the guest via the QEMU guest agent (its
 * dedicated set-user-password call — no shell involved). For tenants locked
 * out of key-only cloud images. Returns the new password exactly once; it is
 * never stored or logged. QEMU + running agent required.
 */
export async function resetGuestPassword(vm: VirtualMachine, username: string): Promise<string> {
  if (kindOf(vm) === 'lxc') throw new Error('Password reset needs the QEMU guest agent — containers are not supported');
  const client = await pve.getClient();
  const currentVm = await requireOurGuest(vm, { client });
  const password = generateGuestPassword();
  await pve.setGuestUserPassword(currentVm.proxmoxNode, currentVm.proxmoxVmId, username, password, client);
  return password;
}

/**
 * Append an SSH public key to a user's authorized_keys inside the guest via the
 * QEMU guest agent — the post-create counterpart of the deploy wizard's key
 * injection (cloud-init only applies `sshkeys` on first boot). Also merges the
 * key into the VM's cloud-init `sshkeys` config best-effort, so the stored
 * config stays truthful for later flows that reuse it (duplicate, rebuild).
 * QEMU + running agent required, like {@link resetGuestPassword}.
 */
export async function addGuestSshKey(vm: VirtualMachine, username: string, publicKey: string): Promise<void> {
  if (kindOf(vm) === 'lxc') throw new Error('Adding SSH keys needs the QEMU guest agent — containers are not supported');
  const key = publicKey.trim();
  // Same shape check as saved keys / cloud-init: single line, OpenSSH format —
  // the authorized_keys-injection guard (a multi-line paste smuggles extra keys).
  if (!isValidPublicKey(key)) throw new Error("That doesn't look like an OpenSSH public key");
  const client = await pve.getClient();
  const current = await requireOurGuest(vm, { client });
  await pve.injectGuestSshKey(current.proxmoxNode, current.proxmoxVmId, username, key, client);

  // Best-effort config sync: the live injection above already succeeded, so a
  // failure here (e.g. VM locked mid-backup) must never fail the action.
  try {
    const cfg = await pve.getVmConfig(current.proxmoxNode, current.proxmoxVmId, client);
    if (pve.isCloudInitTemplate(cfg)) {
      const existing = cfg['sshkeys'] ? decodeURIComponent(cfg['sshkeys']) : '';
      const lines = existing.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.includes(key)) {
        // setCloudInitConfig defaults ipconfig0 to DHCP — pass the VM's current
        // value through so a static-IP config is never clobbered by a key add.
        await pve.setCloudInitConfig(
          current.proxmoxNode,
          current.proxmoxVmId,
          { sshKeys: [...lines, key].join('\n'), ipConfig: cfg['ipconfig0'] },
          client,
        );
      }
    }
  } catch {
    /* cosmetic — the key is already live in the guest */
  }
}

// ─── Rescue mode ──────────────────────────────────────────────

/**
 * Boot a VM from the admin-designated rescue ISO. The current { boot, ide3 }
 * config is snapshotted on `rescueBoot` first so {@link exitRescue} can put
 * everything back. The VM is force-stopped if running (rescue exists for
 * machines that won't boot or can't shut down cleanly), reconfigured, then
 * started into the ISO.
 */
export async function enterRescue(vm: VirtualMachine): Promise<VirtualMachine & { autoSnapshot: AutoSnapshotResult }> {
  if (kindOf(vm) === 'lxc') throw new Error('Rescue mode is for VMs — containers share the host kernel');
  if (vm.rescueBoot) throw new Error('Already in rescue mode');
  const iso = await getConfig('rescue_iso');
  if (!iso) throw new Error('No rescue ISO is configured — an admin can set one under Admin → Settings');

  // Rescue ends in a boot, so the owner's window is checked before anything is
  // stopped or rewritten — a refusal must leave the guest exactly as it was.
  await assertOwnerAccessActive(vm);
  const client = await pve.getClient();
  const current = await requireOurGuest(vm, { client });
  const cfg = await pve.getVmConfig(current.proxmoxNode, current.proxmoxVmId, client);
  const snap: pve.RescueSnapshot = { boot: cfg['boot'] ?? null, ide3: cfg['ide3'] ?? null };

  // Taken before the force-stop, so a refusal still leaves the guest as it was.
  const autoSnapshot = await autoSnapshotBefore(current, 'rescue', client);

  const status = await pve.getVmStatus(current.proxmoxNode, current.proxmoxVmId, client).catch(() => null);
  if (status?.status === 'running') {
    const upid = await pve.stopVm(current.proxmoxNode, current.proxmoxVmId, client);
    await pve.waitForTask(current.proxmoxNode, upid, client);
  }

  await pve.applyRescueConfig(current.proxmoxNode, current.proxmoxVmId, iso, client);
  const updated = await prisma.virtualMachine.update({
    where: { id: current.id },
    data: { rescueBoot: JSON.stringify(snap), status: 'running' },
  });
  await pve.startVm(current.proxmoxNode, current.proxmoxVmId, client);
  return { ...updated, autoSnapshot };
}

/** Leave rescue mode: stop, restore the snapshotted boot config, boot from disk. */
export async function exitRescue(vm: VirtualMachine): Promise<VirtualMachine> {
  if (!vm.rescueBoot) throw new Error('Not in rescue mode');
  const snap = JSON.parse(vm.rescueBoot) as pve.RescueSnapshot;

  // Same ordering as enterRescue: refuse before the guest is stopped or rewritten.
  await assertOwnerAccessActive(vm);
  const client = await pve.getClient();
  const current = await requireOurGuest(vm, { client });
  const status = await pve.getVmStatus(current.proxmoxNode, current.proxmoxVmId, client).catch(() => null);
  if (status?.status === 'running') {
    const upid = await pve.stopVm(current.proxmoxNode, current.proxmoxVmId, client);
    await pve.waitForTask(current.proxmoxNode, upid, client);
  }

  await pve.restoreBootConfig(current.proxmoxNode, current.proxmoxVmId, snap, client);
  const updated = await prisma.virtualMachine.update({
    where: { id: current.id },
    data: { rescueBoot: null, status: 'running' },
  });
  await pve.startVm(current.proxmoxNode, current.proxmoxVmId, client);
  return updated;
}

// ─── Storage pinning report (B-40) ────────────────────────────

export interface PinnedGuest {
  id: string;
  name: string;
  proxmoxVmId: number;
  proxmoxNode: string;
  /** Distinct storages this guest's volumes live on. */
  storages: string[];
  /** Of those, the ones that are NOT shared across the cluster. */
  localStorages: string[];
  /** Volume ids Proxmox itself calls node-local — its answer, not our inference. */
  localDisks: string[];
  /** How many other nodes Proxmox will accept a migration to. */
  migrationTargets: number;
  /** True when the guest sits entirely off the admin's configured default pool. */
  offDefaultStorage: boolean;
}

export interface StoragePinningReport {
  defaultStorage: string | null;
  /** Storages the cluster reports as shared — the ones that don't pin a guest. */
  sharedStorages: string[];
  /** Guests with at least one node-local volume, worst (fewest targets) first. */
  pinned: PinnedGuest[];
  /** Guests whose migratability could not be determined, with the reason. */
  unknown: Array<{ id: string; name: string; proxmoxVmId: number; reason: string }>;
  checked: number;
}

/**
 * Which ProxMate-managed guests cannot migrate, and why.
 *
 * The B-38 fix is forward-looking: it stops NEW guests inheriting a template's
 * node-local storage, but every guest deployed before it is still where it landed —
 * pinned to one node, unmigratable, and invisible until someone tries to drain that
 * node. This is the report that finds them.
 *
 * Migratability comes from **Proxmox's own preflight**, not from our own reasoning
 * about which storage is shared. Re-deriving it would mean maintaining a second
 * opinion that can disagree with the one that actually governs the migration — and
 * the storage flags here exist to explain the verdict, never to replace it.
 *
 * Read-only by design. Moving a disk is a deliberate human act with real cost; a
 * report that quietly relocated volumes would be a far worse surprise than the
 * pinning it reports.
 */
export async function getStoragePinningReport(): Promise<StoragePinningReport> {
  const client = await pve.getClient();
  const [vms, storages, defaultStorage] = await Promise.all([
    prisma.virtualMachine.findMany({
      where: { status: { not: 'error' } },
      select: { id: true, name: true, proxmoxVmId: true, proxmoxNode: true, type: true },
      orderBy: { name: 'asc' },
    }),
    pve.getStorages(client),
    getConfig('default_storage'),
  ]);

  // `shared` is not on PveStorage (the /storage list carries it as 0/1), so read it
  // off the raw rows rather than adding a second source of truth.
  const shared = new Set(
    storages.filter((s) => (s as unknown as { shared?: number }).shared === 1).map((s) => s.storage),
  );

  const pinned: PinnedGuest[] = [];
  const unknown: StoragePinningReport['unknown'] = [];

  // Two Proxmox calls per guest; run in small batches so a 200-guest cluster doesn't
  // open 400 sockets at once against pveproxy's fixed worker pool.
  const BATCH = 8;
  for (let i = 0; i < vms.length; i += BATCH) {
    await Promise.all(
      vms.slice(i, i + BATCH).map(async (vm) => {
        const kind = kindOf(vm);
        // LXC has no live migration and a different preflight; report the storage
        // facts and let the target count stand at 0 rather than guess.
        try {
          const cfg = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, client, kind);
          const vmStorages = pve.getVolumeStorages(cfg);
          const localStorages = vmStorages.filter((s) => !shared.has(s));
          const pre = kind === 'qemu'
            ? await pve.migratePreflight(vm.proxmoxNode, vm.proxmoxVmId, client).catch(() => null)
            : null;

          // Proxmox's verdict wins; the storage flags are the explanation.
          const localDisks = pre ? pre.localDisks.map((d) => d.volid) : [];
          if (localDisks.length === 0 && localStorages.length === 0) return;
          if (kind === 'qemu' && !pre) {
            unknown.push({ id: vm.id, name: vm.name, proxmoxVmId: vm.proxmoxVmId, reason: 'migration preflight unavailable' });
            return;
          }
          pinned.push({
            id: vm.id,
            name: vm.name,
            proxmoxVmId: vm.proxmoxVmId,
            proxmoxNode: vm.proxmoxNode,
            storages: vmStorages,
            localStorages,
            localDisks,
            migrationTargets: pre ? pre.allowed.length : 0,
            offDefaultStorage: Boolean(defaultStorage) && !vmStorages.includes(defaultStorage!),
          });
        } catch (err) {
          unknown.push({ id: vm.id, name: vm.name, proxmoxVmId: vm.proxmoxVmId, reason: pve.pveMessage(err) });
        }
      }),
    );
  }

  pinned.sort((a, b) => a.migrationTargets - b.migrationTargets || a.name.localeCompare(b.name));
  return { defaultStorage, sharedStorages: [...shared].sort(), pinned, unknown, checked: vms.length };
}
