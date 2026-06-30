import type { VirtualMachine, User } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import * as pve from './proxmox.service.js';
import { QuotaError } from './vm.service.js';

/**
 * Extra-data-disk management. A VM's `storage` column tracks **total** provisioned
 * GB (root + data disks), so the existing quota accounting (sum of `vm.storage`)
 * naturally covers data disks too — we just keep it in step as disks change.
 */
export interface VmDisk {
  slot: string; // e.g. "scsi1"
  storage: string; // e.g. "local-lvm"
  sizeGb: number;
  isRoot: boolean;
}

const DISK_SLOT = /^(scsi|virtio|sata|ide)\d+$/;
// Per-bus slot ceilings Proxmox supports.
const BUS_MAX: Record<string, number> = { scsi: 30, virtio: 15, sata: 5, ide: 3 };

/** Parse real disks (not cdrom, not the cloud-init drive) from a VM config. */
export function parseDisks(config: Record<string, string>): VmDisk[] {
  const root = pve.findPrimaryDisk(config);
  const disks: VmDisk[] = [];
  for (const [slot, raw] of Object.entries(config)) {
    if (!DISK_SLOT.test(slot)) continue;
    const val = String(raw);
    if (val.includes('media=cdrom') || val.includes('cloudinit')) continue;
    disks.push({
      slot,
      storage: val.split(':')[0] ?? '',
      sizeGb: diskSizeGb(val),
      isRoot: slot === root,
    });
  }
  return disks.sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }));
}

/** Whole-GB size from a disk config string's `size=` token (0 if absent). */
export function diskSizeGb(val: string): number {
  const m = /\bsize=(\d+(?:\.\d+)?)([KMGT])?/i.exec(val);
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? 'G').toUpperCase();
  const gb = unit === 'T' ? n * 1024 : unit === 'M' ? n / 1024 : unit === 'K' ? n / 1024 / 1024 : n;
  return Math.round(gb);
}

/** Next free slot on the root disk's bus (so a SCSI VM gets scsi1, scsi2, …). */
export function nextFreeSlot(config: Record<string, string>, bus: string): string | null {
  const max = BUS_MAX[bus] ?? 0;
  for (let i = 0; i <= max; i++) {
    if (!(`${bus}${i}` in config)) return `${bus}${i}`;
  }
  return null;
}

const busOf = (slot: string): string => slot.match(/^[a-z]+/)?.[0] ?? 'scsi';

/** Quota guard for a storage change of `deltaGb` against the VM owner's cap. */
async function assertStorageDelta(owner: User, deltaGb: number): Promise<void> {
  if (owner.role === 'admin' || deltaGb <= 0) return;
  const vms = await prisma.virtualMachine.findMany({ where: { userId: owner.id }, select: { storage: true } });
  const used = vms.reduce((s, v) => s + v.storage, 0);
  if (used + deltaGb > owner.maxStorage) {
    throw new QuotaError({ storage: { used, requested: deltaGb, max: owner.maxStorage } });
  }
}

async function ownerOf(vm: VirtualMachine): Promise<User> {
  const owner = await prisma.user.findUnique({ where: { id: vm.userId } });
  if (!owner) throw new Error('VM owner not found');
  return owner;
}

/** List a VM's disks (live from Proxmox). */
export async function listDisks(vm: VirtualMachine): Promise<VmDisk[]> {
  return parseDisks(await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId));
}

/** Attach a new data disk (allocated on the root disk's storage). Quota-checked. */
export async function addDataDisk(vm: VirtualMachine, sizeGb: number): Promise<VmDisk> {
  const owner = await ownerOf(vm);
  await assertStorageDelta(owner, sizeGb);

  const config = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId);
  const root = pve.findPrimaryDisk(config) ?? 'scsi0';
  const bus = busOf(root);
  const slot = nextFreeSlot(config, bus);
  if (!slot) throw new Error(`No free ${bus} slot for another disk.`);
  const storage = config[root]?.split(':')[0] ?? '';
  if (!storage) throw new Error('Could not determine the VM storage pool.');

  await pve.attachDisk(vm.proxmoxNode, vm.proxmoxVmId, slot, storage, sizeGb);
  await prisma.virtualMachine.update({ where: { id: vm.id }, data: { storage: vm.storage + sizeGb } });
  return { slot, storage, sizeGb, isRoot: false };
}

/** Grow a data disk to `sizeGb` (grow-only). Cannot target the root disk. Quota-checked. */
export async function resizeDataDisk(vm: VirtualMachine, slot: string, sizeGb: number): Promise<void> {
  const config = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId);
  if (!(slot in config)) throw new Error('Disk not found.');
  if (slot === pve.findPrimaryDisk(config)) throw new Error('Resize the root disk from the VM resize controls.');
  const current = diskSizeGb(String(config[slot]));
  if (sizeGb <= current) throw new Error(`A disk can only grow (currently ${current} GB).`);

  await assertStorageDelta(await ownerOf(vm), sizeGb - current);
  await pve.resizeDisk(vm.proxmoxNode, vm.proxmoxVmId, slot, sizeGb);
  await prisma.virtualMachine.update({ where: { id: vm.id }, data: { storage: vm.storage + (sizeGb - current) } });
}

/** Detach + destroy a data disk. Refuses the root disk. Frees the quota it used. */
export async function removeDataDisk(vm: VirtualMachine, slot: string): Promise<void> {
  const config = await pve.getVmConfig(vm.proxmoxNode, vm.proxmoxVmId);
  if (!(slot in config)) throw new Error('Disk not found.');
  if (slot === pve.findPrimaryDisk(config)) throw new Error('The root disk cannot be removed.');
  const freed = diskSizeGb(String(config[slot]));

  await pve.removeDisk(vm.proxmoxNode, vm.proxmoxVmId, slot);
  await prisma.virtualMachine.update({
    where: { id: vm.id },
    data: { storage: Math.max(0, vm.storage - freed) },
  });
}
