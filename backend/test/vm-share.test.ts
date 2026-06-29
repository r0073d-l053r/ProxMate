import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findUnique: vi.fn(), findMany: vi.fn() },
    vmShare: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import {
  resolveVmAccess,
  getWritableVm,
  getViewableVm,
  annotateAccess,
  listVms,
} from '../src/services/vm.service.js';

const vmFindUnique = vi.mocked(prisma.virtualMachine.findUnique);
const vmFindMany = vi.mocked(prisma.virtualMachine.findMany);
const shareFindUnique = vi.mocked(prisma.vmShare.findUnique);
const shareFindMany = vi.mocked(prisma.vmShare.findMany);

const VM = { id: 'vm1', userId: 'owner1' };

beforeEach(() => vi.clearAllMocks());

describe('resolveVmAccess', () => {
  it('returns owner for the owning user', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    expect((await resolveVmAccess('vm1', { id: 'owner1', role: 'user' }))?.access).toBe('owner');
  });

  it('returns admin for an admin on someone else’s VM', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    expect((await resolveVmAccess('vm1', { id: 'x', role: 'admin' }))?.access).toBe('admin');
  });

  it('maps a co-owner share', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    shareFindUnique.mockResolvedValue({ role: 'co-owner' } as never);
    expect((await resolveVmAccess('vm1', { id: 'u2', role: 'user' }))?.access).toBe('co-owner');
  });

  it('maps a read-only share', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    shareFindUnique.mockResolvedValue({ role: 'read-only' } as never);
    expect((await resolveVmAccess('vm1', { id: 'u2', role: 'user' }))?.access).toBe('read-only');
  });

  it('returns null for an unrelated user, or a missing VM', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    shareFindUnique.mockResolvedValue(null as never);
    expect(await resolveVmAccess('vm1', { id: 'u3', role: 'user' })).toBeNull();
    vmFindUnique.mockResolvedValue(null as never);
    expect(await resolveVmAccess('nope', { id: 'x', role: 'admin' })).toBeNull();
  });
});

describe('view vs write gating', () => {
  it('read-only can view but not operate', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    shareFindUnique.mockResolvedValue({ role: 'read-only' } as never);
    expect(await getViewableVm('vm1', { id: 'u2', role: 'user' })).not.toBeNull();
    vmFindUnique.mockResolvedValue(VM as never);
    shareFindUnique.mockResolvedValue({ role: 'read-only' } as never);
    expect(await getWritableVm('vm1', { id: 'u2', role: 'user' })).toBeNull();
  });

  it('co-owner can operate', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    shareFindUnique.mockResolvedValue({ role: 'co-owner' } as never);
    expect(await getWritableVm('vm1', { id: 'u2', role: 'user' })).not.toBeNull();
  });
});

describe('annotateAccess', () => {
  it('tags owner + shared roles for a non-admin', async () => {
    shareFindMany.mockResolvedValue([{ vmId: 'vmB', role: 'co-owner' }] as never);
    const out = await annotateAccess(
      [
        { id: 'vmA', userId: 'me' },
        { id: 'vmB', userId: 'other' },
        { id: 'vmC', userId: 'other2' },
      ],
      { id: 'me', role: 'user' },
    );
    expect(out.find((v) => v.id === 'vmA')!.access).toBe('owner');
    expect(out.find((v) => v.id === 'vmB')!.access).toBe('co-owner');
    expect(out.find((v) => v.id === 'vmC')!.access).toBe('read-only');
  });

  it('tags everything as admin without a share lookup', async () => {
    const out = await annotateAccess([{ id: 'v', userId: 'someone' }], { id: 'a', role: 'admin' });
    expect(out[0]!.access).toBe('admin');
    expect(shareFindMany).not.toHaveBeenCalled();
  });
});

describe('listVms', () => {
  it('includes owned OR shared VMs for a non-admin', async () => {
    shareFindMany.mockResolvedValue([{ vmId: 'shared1' }] as never);
    vmFindMany.mockResolvedValue([] as never);
    await listVms({ id: 'me', role: 'user' });
    expect(vmFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ userId: 'me' }, { id: { in: ['shared1'] } }] } }),
    );
  });
});
