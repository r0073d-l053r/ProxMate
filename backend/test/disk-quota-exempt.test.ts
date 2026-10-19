import { describe, it, expect, vi } from 'vitest';

// A quota-exempt machine (an admin's deploy-for-tenant grant) does not count
// against the tenant's storage quota when they add a data disk to another machine,
// exactly as it does not count when they create or resize one.

const rows = [
  { id: 'vm-a', userId: 'u1', storage: 10, quotaExempt: false },
  { id: 'vm-big', userId: 'u1', storage: 500, quotaExempt: true },
];

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; quotaExempt?: boolean } }) =>
        rows.filter((r) => r.userId === where.userId && (where.quotaExempt === undefined || r.quotaExempt === where.quotaExempt)),
      ),
      update: vi.fn(async () => ({})),
    },
    user: { findUnique: vi.fn(async () => ({ id: 'u1', role: 'user', maxStorage: 50 })) },
  },
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/proxmox.service.js')>()),
  getVmConfig: vi.fn(async () => ({ tags: 'proxmate-vm-a', scsi0: 'local-lvm:vm-1-disk-0,size=10G' })),
  attachDisk: vi.fn(async () => undefined),
}));
vi.mock('../src/services/vm.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/vm.service.js')>()),
  requireOurGuest: vi.fn(async (vm: unknown) => vm),
}));

import { addDataDisk } from '../src/services/disk.service.js';
import * as pve from '../src/services/proxmox.service.js';

describe('addDataDisk storage quota', () => {
  it('ignores the owner\'s quota-exempt machines', async () => {
    const vm = { id: 'vm-a', userId: 'u1', proxmoxNode: 'pve1', proxmoxVmId: 100, storage: 10 } as never;
    await expect(addDataDisk(vm, 20)).resolves.toMatchObject({ sizeGb: 20 });
    expect(pve.attachDisk).toHaveBeenCalled();
  });
});
