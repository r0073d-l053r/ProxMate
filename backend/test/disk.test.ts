import { describe, it, expect } from 'vitest';
import { parseDisks, diskSizeGb, nextFreeSlot } from '../src/services/disk.service.js';

describe('parseDisks', () => {
  it('lists real disks, flags the root, and skips cdrom/cloud-init/nics', () => {
    const config: Record<string, string> = {
      scsi0: 'local-lvm:vm-100-disk-0,size=20G',
      scsi1: 'local-lvm:vm-100-disk-1,size=50G',
      ide2: 'local:iso/debian.iso,media=cdrom',
      scsi3: 'local-lvm:vm-100-cloudinit,cloudinit=1',
      net0: 'virtio=AA:BB:CC,bridge=vmbr0',
      name: 'web',
    };
    const disks = parseDisks(config);
    expect(disks.map((d) => d.slot)).toEqual(['scsi0', 'scsi1']);
    expect(disks.find((d) => d.slot === 'scsi0')!.isRoot).toBe(true);
    expect(disks.find((d) => d.slot === 'scsi1')!.isRoot).toBe(false);
    expect(disks.find((d) => d.slot === 'scsi1')!.sizeGb).toBe(50);
    expect(disks[0]!.storage).toBe('local-lvm');
  });
});

describe('diskSizeGb', () => {
  it('parses G / M / T units, 0 when absent', () => {
    expect(diskSizeGb('local:x,size=32G')).toBe(32);
    expect(diskSizeGb('local:x,size=2048M')).toBe(2);
    expect(diskSizeGb('local:x,size=1T')).toBe(1024);
    expect(diskSizeGb('local:x')).toBe(0);
  });
});

describe('nextFreeSlot', () => {
  it('returns the first open slot on the bus', () => {
    expect(nextFreeSlot({ scsi0: 'x', scsi1: 'x' }, 'scsi')).toBe('scsi2');
    expect(nextFreeSlot({ scsi0: 'x' }, 'virtio')).toBe('virtio0');
  });
});
