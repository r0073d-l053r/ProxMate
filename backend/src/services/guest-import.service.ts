import type { User, VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { guestConfigSizes, foreignVolumeKeys } from '../lib/guest-config.js';
import { recordAudit, type AuditActor } from './audit.service.js';
import * as pve from './proxmox.service.js';
import {
  hasProxmateTag,
  writeGuestMarker,
  withQuotaLock,
  assertWithinQuota,
  holdErroredRow,
  OP_SETTLED,
  type VmOpKind,
} from './vm.service.js';
import { beginInFlight } from '../lib/in-flight.js';

/**
 * Admin import of a Proxmox guest ProxMate didn't create. ProxMate otherwise only
 * manages guests it made (each carries its row's `proxmate-<id>` tag, see
 * guestMarker); this brings an existing QEMU VM or LXC container under management
 * for a chosen owner: a row is written, the guest gets that row's tag (its other
 * tags kept), the same network placement and isolation firewall a new guest gets,
 * and its size counts toward the owner's quota unless the admin marks it exempt.
 *
 * Only a guest nothing else could claim is offered or accepted: no row references
 * its VMID, it carries no ProxMate tag (a machine's or a template's), it is not a
 * Proxmox template or a Template Store entry, every volume it references is its
 * own, and it has no host device or host-level setting a tenant must not inherit.
 */

/** Thrown when a guest can't be imported; the message says why. */
export class ImportError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/** holdReason of an imported row whose isolation couldn't be applied. */
export const IMPORT_FAILED_MESSAGE =
  "This machine's import didn't finish (its isolation firewall couldn't be applied), so it can't be started. " +
  'Ask an admin to adopt it again, or delete it.';

export interface ImportableGuest {
  vmid: number;
  node: string;
  name: string | null;
  type: pve.GuestKind;
  status: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
}

type ResourceEntry = {
  type: string;
  vmid?: number;
  node?: string;
  name?: string;
  tags?: string;
  template?: number;
  status?: string;
  maxcpu?: number;
  maxmem?: number;
  maxdisk?: number;
};

/**
 * Guests an admin may import: QEMU and LXC guests no machine row references, with
 * no ProxMate tag, that are neither Proxmox templates nor Template Store entries.
 * Read from one /cluster/resources listing; the full checks run at import.
 */
export async function listImportableGuests(): Promise<ImportableGuest[]> {
  const client = await pve.getClient();
  const [res, rows, templates] = await Promise.all([
    client.get<{ data: ResourceEntry[] }>('/cluster/resources?type=vm'),
    prisma.virtualMachine.findMany({ select: { proxmoxVmId: true } }),
    prisma.template.findMany({ select: { proxmoxVmId: true } }),
  ]);
  const taken = new Set([...rows, ...templates].map((r) => r.proxmoxVmId));
  return res.data.data
    .filter(
      (r) =>
        (r.type === 'qemu' || r.type === 'lxc') &&
        r.vmid !== undefined &&
        r.node &&
        !taken.has(r.vmid) &&
        (r.template ?? 0) !== 1 &&
        !hasProxmateTag(r.tags),
    )
    .map((r) => ({
      vmid: r.vmid!,
      node: r.node!,
      name: r.name ?? null,
      type: r.type as pve.GuestKind,
      status: r.status ?? 'unknown',
      cpu: r.maxcpu ?? 0,
      ramMb: Math.round((r.maxmem ?? 0) / 1024 / 1024),
      diskGb: Math.round((r.maxdisk ?? 0) / 1024 ** 3),
    }))
    .sort((a, b) => a.vmid - b.vmid);
}

/**
 * Config lines a tenant must not inherit with an imported guest: host devices
 * (PCI, USB, serial/parallel ports, container device nodes), raw host-level
 * options (QEMU `args`, LXC `lxc.*`), hook scripts, and a privileged container.
 * ProxMate's passthrough model only knows devices an admin attached through an
 * approved request, so these are refused rather than carried over.
 */
export function hostLevelKeys(cfg: Record<string, string>, kind: pve.GuestKind): string[] {
  const out: string[] = [];
  for (const [key, raw] of Object.entries(cfg)) {
    const value = String(raw);
    if (key === 'hookscript') out.push(key);
    else if (kind === 'qemu') {
      if (/^hostpci\d+$/.test(key) || key === 'args') out.push(key);
      else if (/^usb\d+$/.test(key) && !/^spice\b/.test(value)) out.push(key);
      else if (/^(serial|parallel)\d+$/.test(key) && value !== 'socket') out.push(key);
    } else if (/^dev\d+$/.test(key) || key.startsWith('lxc')) out.push(key);
  }
  if (kind === 'lxc' && cfg['unprivileged'] !== '1') out.push('unprivileged');
  return out;
}

const vmidLocks = new Map<number, Promise<void>>();

/** Run `fn` holding a lock on this VMID, so two imports of one guest run one at a time. */
async function withVmidLock<T>(vmid: number, fn: () => Promise<T>): Promise<T> {
  const prev = vmidLocks.get(vmid) ?? Promise.resolve();
  let open!: () => void;
  const mine = new Promise<void>((r) => (open = r));
  const tail = prev.then(() => mine);
  vmidLocks.set(vmid, tail);
  await prev;
  try {
    return await fn();
  } finally {
    open();
    if (vmidLocks.get(vmid) === tail) vmidLocks.delete(vmid);
  }
}

export interface ImportGuestInput {
  vmid: number;
  owner: User;
  /** Admin grant: the guest doesn't count toward the owner's quota (always admin-managed). */
  quotaExempt?: boolean;
  /** The owner may operate but not resize it. Defaults to true for another user's account. */
  adminManaged?: boolean;
}

/**
 * Import one guest for `owner`. Serialized per VMID (a second import of the same
 * guest waits, then finds it taken) and, for the quota check and row write, under
 * the owner's quota lock. Refused with an ImportError when the guest can't safely
 * be handed over, or a QuotaError when it doesn't fit the owner's quota.
 */
export async function importGuest(actor: AuditActor, input: ImportGuestInput): Promise<VirtualMachine> {
  return withVmidLock(input.vmid, () => importGuestLocked(actor, input));
}

async function importGuestLocked(actor: AuditActor, input: ImportGuestInput): Promise<VirtualMachine> {
  const { vmid, owner } = input;
  if ((await prisma.virtualMachine.count({ where: { proxmoxVmId: vmid } })) > 0) {
    throw new ImportError('A machine already references this VMID — it is managed by ProxMate already.');
  }
  if ((await prisma.template.count({ where: { proxmoxVmId: vmid } })) > 0) {
    throw new ImportError('This VMID belongs to a Template Store entry, not a machine.');
  }

  const client = await pve.getClient();
  const res = await client.get<{ data: ResourceEntry[] }>('/cluster/resources?type=vm');
  const guest = res.data.data.find((r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid === vmid);
  if (!guest?.node) throw new ImportError('There is no Proxmox guest at this VMID.', 404);
  const kind = guest.type as pve.GuestKind;
  const node = guest.node;

  // Decide on the guest's own config: the resource listing may lag or omit tags.
  const cfg = await pve.getVmConfig(node, vmid, client, kind);
  if (cfg['template'] === '1' || (guest.template ?? 0) === 1) {
    throw new ImportError('This guest is a Proxmox template, not a machine.');
  }
  if (hasProxmateTag(cfg['tags']) || hasProxmateTag(guest.tags)) {
    throw new ImportError("This guest carries a ProxMate tag (another machine's or a template's), so it isn't importable.");
  }
  if (cfg['lock']) {
    throw new ImportError(`The guest is busy in Proxmox (lock: ${cfg['lock']}). Try again once that has finished.`);
  }
  const foreign = foreignVolumeKeys(cfg, vmid);
  if (foreign.length > 0) {
    throw new ImportError(
      `The guest references disks that aren't its own (${foreign.join(', ')}). Detach them in Proxmox first.`,
    );
  }
  const hostLevel = hostLevelKeys(cfg, kind);
  if (hostLevel.length > 0) {
    throw new ImportError(
      `The guest has host devices or host-level settings a tenant can't be given (${hostLevel.join(', ')}). ` +
        'Remove them in Proxmox first' +
        (hostLevel.some((k) => k.startsWith('hostpci')) ? ', then attach the device through a passthrough request.' : '.'),
    );
  }
  const sizes = guestConfigSizes(cfg, kind);
  if (sizes.cpu === null) {
    throw new ImportError('The container has no CPU core limit. Set one in Proxmox first so its quota can be counted.');
  }
  if (sizes.unsizedDisk) {
    throw new ImportError("A disk of this guest has no recorded size, so its quota can't be counted.");
  }
  const cpu = sizes.cpu;
  const name = (kind === 'lxc' ? cfg['hostname'] : cfg['name']) || guest.name || `guest-${vmid}`;
  const quotaExempt = input.quotaExempt ?? false;
  // A quota-exempt grant is always admin-managed: a tenant who could resize a free
  // grant would bypass quota entirely (same rule as an admin's deploy-for-tenant).
  const adminManaged = quotaExempt || (input.adminManaged ?? owner.id !== actor.id);

  const vm = await withQuotaLock(owner.id, async () => {
    await assertWithinQuota(owner, {
      name,
      cpu,
      ram: sizes.ram,
      storage: sizes.storage,
      os: kind,
      quotaExempt,
    });
    return prisma.virtualMachine.create({
      data: {
        userId: owner.id,
        proxmoxVmId: vmid,
        proxmoxNode: node,
        type: kind,
        name,
        description: `Imported from Proxmox (VMID ${vmid})`,
        cpu,
        ram: sizes.ram,
        storage: sizes.storage,
        os: cfg['ostype'] || kind,
        status: 'creating',
        opKind: 'import' satisfies VmOpKind,
        opStartedAt: new Date(),
        quotaExempt,
        adminManaged,
      },
    });
  });
  // Until it settles, the restart reconciler leaves this row alone.
  const done = beginInFlight(vm.id);
  try {
    return await finishImport(actor, vm, { cfg, client, kind, node, vmid, name, owner, cpu, sizes, quotaExempt });
  } finally {
    done();
  }
}

async function finishImport(
  actor: AuditActor,
  vm: VirtualMachine,
  a: {
    cfg: Record<string, string>;
    client: Awaited<ReturnType<typeof pve.getClient>>;
    kind: pve.GuestKind;
    node: string;
    vmid: number;
    name: string;
    owner: User;
    cpu: number;
    sizes: { ram: number; storage: number };
    quotaExempt: boolean;
  },
): Promise<VirtualMachine> {
  const { cfg, client, kind, node, vmid, name, owner, cpu, sizes, quotaExempt } = a;
  try {
    await writeGuestMarker(vm, client, cfg['tags']);
  } catch (err) {
    // Nothing on the guest changed: drop the row so the guest stays importable.
    await prisma.virtualMachine.delete({ where: { id: vm.id } }).catch(() => undefined);
    throw err;
  }

  try {
    // Network placement and isolation exactly as a new guest gets them. Loaded
    // lazily: matestate.service imports vm.service.
    const { reapplyIsolation } = await import('./matestate.service.js');
    await reapplyIsolation(vm, client);
  } catch (err) {
    // The guest is tagged as this row's, but isn't isolated: hold it so nothing
    // starts it through ProxMate until an admin's adopt re-applies isolation.
    await holdErroredRow(vm, IMPORT_FAILED_MESSAGE).catch(() => undefined);
    await recordAudit({
      action: 'vm.import',
      actor,
      targetType: 'vm',
      targetId: vm.id,
      detail: `${name} (vmid ${vmid}) imported for ${owner.email} but held: isolation failed (${pve.pveMessage(err)})`,
    });
    throw new ImportError(`The guest was imported but its isolation couldn't be applied, so it is held: ${pve.pveMessage(err)}`, 502);
  }

  const live = await pve.getVmStatus(node, vmid, client, kind).catch(() => null);
  const status = live?.status === 'running' || live?.status === 'paused' ? live.status : 'stopped';
  const updated = await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status, ...OP_SETTLED } });
  await recordAudit({
    action: 'vm.import',
    actor,
    targetType: 'vm',
    targetId: vm.id,
    detail:
      `${name} (${kind} vmid ${vmid} on ${node}) imported for ${owner.email}: ${cpu} vCPU, ${sizes.ram} MB, ${sizes.storage} GB` +
      (quotaExempt ? ' (quota-exempt)' : ''),
  });
  return updated;
}

