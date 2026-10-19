import { describe, it, expect, vi, beforeEach } from 'vitest';

// A restored guest may only reference its own VMID's volumes. A config line that
// points at another guest's volume is detached (never freed), and the row is held
// and audited, whatever Proxmox itself would have allowed.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { update: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(async () => null) }));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { assertOwnVolumes, ForeignVolumeError, FOREIGN_VOLUME_MESSAGE } from '../src/services/vm.service.js';
import { foreignVolumeKeys } from '../src/lib/guest-config.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const row = (type = 'qemu') =>
  ({ id: 'rowa', userId: 'u1', name: 'web', type, proxmoxVmId: 100, proxmoxNode: 'pve1', status: 'creating', holdReason: null }) as never;

function pveWith(cfg: Record<string, string>, kind = 'qemu') {
  const c = fakeClient();
  c.get.mockImplementation((url: string) => (url === `/nodes/pve1/${kind}/100/config` ? ok(cfg) : ok(null)));
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return c;
}

beforeEach(() => vi.clearAllMocks());

describe('foreignVolumeKeys', () => {
  it('accepts every storage naming of this VMID\'s volumes, empty and ISO cdroms', () => {
    expect(
      foreignVolumeKeys(
        {
          scsi0: 'local-lvm:vm-100-disk-0,size=32G',
          scsi1: 'local:100/vm-100-disk-1.qcow2,size=10G',
          virtio0: 'local-lvm:base-9000-disk-0/vm-100-disk-2,size=8G',
          efidisk0: 'local-lvm:vm-100-disk-3,size=4M',
          ide2: 'local:iso/debian.iso,media=cdrom',
          ide3: 'none,media=cdrom',
          ide0: 'local-lvm:vm-100-cloudinit,media=cdrom',
          rootfs: 'local-lvm:subvol-100-disk-0,size=8G',
          unused0: 'local-lvm:vm-100-disk-9',
          net0: 'virtio,bridge=vmbr0',
        },
        100,
      ),
    ).toEqual([]);
  });

  it('flags a directory-storage volume filed under another VMID\'s directory (audit round 3)', () => {
    expect(
      foreignVolumeKeys(
        {
          scsi0: 'local:200/vm-100-disk-0.qcow2,size=10G',
          scsi1: 'nfs:100/vm-100-disk-1.qcow2,size=10G',
          scsi2: 'local:9000/base-9000-disk-0.qcow2/100/vm-100-disk-2.qcow2,size=10G',
        },
        100,
      ),
    ).toEqual(['scsi0']);
  });

  it('flags another guest\'s volume, a host path, and another VMID that only starts with the same digits', () => {
    expect(
      foreignVolumeKeys(
        {
          scsi1: 'local-lvm:vm-200-disk-0,size=10G',
          scsi2: '/dev/sdb,size=10G',
          scsi3: 'local-lvm:vm-1000-disk-0,size=1G',
          ide2: 'local-lvm:vm-200-disk-1,media=cdrom',
          unused0: 'local-lvm:vm-200-disk-5',
          mp0: 'local-lvm:subvol-200-disk-0,mp=/data,size=8G',
        },
        100,
      ).sort(),
    ).toEqual(['ide2', 'mp0', 'scsi1', 'scsi2', 'scsi3', 'unused0']);
  });
});

describe('assertOwnVolumes (audit round 2, blocker 2)', () => {
  it('detaches a disk line pointing at another VMID\'s volume without freeing it, holds the row and audits', async () => {
    const c = pveWith({ scsi0: 'local-lvm:vm-100-disk-0,size=32G', scsi1: 'local-lvm:vm-200-disk-0,size=10G', unused0: 'local-lvm:vm-200-disk-5' });
    await expect(assertOwnVolumes(row())).rejects.toBeInstanceOf(ForeignVolumeError);
    // Only a plain config delete of the attached line; the unused line is left (unlinking it would free it).
    expect(c.put).toHaveBeenCalledTimes(1);
    expect(bodyOf(c.put.mock.calls[0]!)).toEqual({ delete: 'scsi1' });
    expect(c.delete).not.toHaveBeenCalled();
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: { status: 'error', holdReason: FOREIGN_VOLUME_MESSAGE },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'vm.foreign_volume', targetId: 'rowa' }) });
  });

  it('destroys (without purging) a container whose rootfs is foreign', async () => {
    const c = pveWith({ rootfs: 'local-lvm:subvol-200-disk-0,size=8G' }, 'lxc');
    await expect(assertOwnVolumes(row('lxc'))).rejects.toBeInstanceOf(ForeignVolumeError);
    expect(c.delete).toHaveBeenCalledWith('/nodes/pve1/lxc/100');
    expect(c.put).not.toHaveBeenCalled();
  });

  it('treats a volume that was already listed for the VMID before the restore as foreign (audit round 3)', async () => {
    const c = pveWith({ scsi0: 'local-lvm:vm-100-disk-0,size=32G', scsi1: 'local-lvm:vm-100-disk-7,size=10G' });
    await expect(assertOwnVolumes(row(), undefined, new Set(['local-lvm:vm-100-disk-7']))).rejects.toBeInstanceOf(ForeignVolumeError);
    expect(bodyOf(c.put.mock.calls[0]!)).toEqual({ delete: 'scsi1' });
  });

  it('lists every volume Proxmox holds for a VMID on the node\'s active storages', async () => {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/nodes/pve1/storage') return ok([{ storage: 'local-lvm' }, { storage: 'broken' }]);
      if (url === '/nodes/pve1/storage/local-lvm/content') return ok([{ volid: 'local-lvm:vm-100-disk-7' }]);
      return Promise.reject(new Error('storage offline'));
    });
    expect(await pve.listGuestVolumes('pve1', 100, asClient(c))).toEqual(new Set(['local-lvm:vm-100-disk-7']));
  });

  it('passes a guest that only has its own volumes', async () => {
    const c = pveWith({ scsi0: 'local-lvm:vm-100-disk-0,size=32G' });
    await expect(assertOwnVolumes(row())).resolves.toBeUndefined();
    expect(c.put).not.toHaveBeenCalled();
  });
});
