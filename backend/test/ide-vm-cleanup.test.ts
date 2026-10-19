import { describe, it, expect, beforeEach, vi } from 'vitest';

// Each prisma call returns a tag so the test can see exactly which operations
// went into the single $transaction alongside the VM row delete.
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    virtualMachine: {
      delete: vi.fn((a: { where: { id: string } }) => `vm.delete:${a.where.id}`),
      update: vi.fn(),
    },
    ideGuestSecret: { deleteMany: vi.fn((a: { where: { vmId: string } }) => `secret.deleteMany:${a.where.vmId}`) },
    ideGatewayToken: { deleteMany: vi.fn((a: { where: { vmId: string } }) => `token.deleteMany:${a.where.vmId}`) },
    template: { upsert: vi.fn().mockResolvedValue({ id: 't1' }) },
  },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn().mockResolvedValue({ get: vi.fn().mockRejectedValue(new Error('offline')) }),
  getVmStatus: vi.fn().mockResolvedValue({ status: 'stopped' }),
  deleteVm: vi.fn().mockResolvedValue(undefined),
  convertToTemplate: vi.fn().mockResolvedValue(undefined),
  pveMessage: vi.fn(() => ''),
  // The guest at the VMID carries this row's ownership tag.
  getVmConfig: vi.fn().mockResolvedValue({ tags: 'proxmate-vm1' }),
}));

import { prisma } from '../src/lib/prisma.js';
import { destroyVm } from '../src/services/vm.service.js';
import { convertVmToTemplate } from '../src/services/template.service.js';

const vm = { id: 'vm1', proxmoxNode: 'pve', proxmoxVmId: 101, type: 'qemu', os: 'x', storage: 10 } as never;
const EXPECTED = ['vm.delete:vm1', 'secret.deleteMany:vm1', 'token.deleteMany:vm1'];

beforeEach(() => vi.clearAllMocks());

describe('VM removal clears its IDE credentials in the same transaction', () => {
  it('destroyVm', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await destroyVm(vm);
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledOnce();
    expect([...(vi.mocked(prisma.$transaction).mock.calls[0]![0] as unknown as string[])].sort()).toEqual(
      [...EXPECTED].sort(),
    );
  });

  it('convertVmToTemplate', async () => {
    await convertVmToTemplate(vm, { name: 'tpl', os: 'x' });
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledOnce();
    expect([...(vi.mocked(prisma.$transaction).mock.calls[0]![0] as unknown as string[])].sort()).toEqual(
      [...EXPECTED].sort(),
    );
  });
});
