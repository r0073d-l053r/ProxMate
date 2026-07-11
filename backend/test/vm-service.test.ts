import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import {
  assertWithinQuota,
  assertResizeWithinQuota,
  resolveCreateTarget,
  CreateOptionError,
  getOwnedVm,
  updateVm,
  QuotaError,
} from '../src/services/vm.service.js';

const findMany = vi.mocked(prisma.virtualMachine.findMany);
const findUnique = vi.mocked(prisma.virtualMachine.findUnique);
const update = vi.mocked(prisma.virtualMachine.update);
const userFindUnique = vi.mocked(prisma.user.findUnique);

// Minimal stand-ins; assertWithinQuota only reads these fields.
const user = (over: Record<string, unknown> = {}) =>
  ({ id: 'u1', role: 'user', maxCpu: 4, maxRam: 8192, maxStorage: 100, ...over }) as never;
const input = (over: Record<string, unknown> = {}) =>
  ({ name: 'vm', cpu: 1, ram: 1024, storage: 10, os: 'x.iso', ...over }) as never;

beforeEach(() => vi.clearAllMocks());

describe('assertWithinQuota', () => {
  it('lets admins bypass quota without even reading their VMs', async () => {
    await expect(
      assertWithinQuota(user({ role: 'admin' }), input({ cpu: 9999, ram: 9_999_999, storage: 99999 })),
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('allows a request that fits the remaining quota', async () => {
    findMany.mockResolvedValue([{ cpu: 1, ram: 1024, storage: 10 }] as never);
    await expect(
      assertWithinQuota(user(), input({ cpu: 1, ram: 1024, storage: 10 })),
    ).resolves.toBeUndefined();
  });

  it('allows hitting the cap exactly (boundary, not a violation)', async () => {
    findMany.mockResolvedValue([{ cpu: 2, ram: 4096, storage: 50 }] as never);
    await expect(
      assertWithinQuota(user(), input({ cpu: 2, ram: 4096, storage: 50 })),
    ).resolves.toBeUndefined();
  });

  it('rejects a single over-limit resource and reports only that one', async () => {
    findMany.mockResolvedValue([{ cpu: 3, ram: 1024, storage: 10 }] as never);
    let err: unknown;
    try {
      await assertWithinQuota(user(), input({ cpu: 2, ram: 1024, storage: 10 }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QuotaError);
    const details = (err as QuotaError).details;
    expect(details.cpu).toEqual({ used: 3, requested: 2, max: 4 });
    expect(details).not.toHaveProperty('ram');
    expect(details).not.toHaveProperty('storage');
  });

  it('reports every exceeded resource at once', async () => {
    findMany.mockResolvedValue([{ cpu: 4, ram: 8192, storage: 100 }] as never);
    let err: unknown;
    try {
      await assertWithinQuota(user(), input({ cpu: 1, ram: 1, storage: 1 }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QuotaError);
    expect(Object.keys((err as QuotaError).details).sort()).toEqual(['cpu', 'ram', 'storage']);
  });

  it('sums usage across all of the user\'s existing VMs', async () => {
    findMany.mockResolvedValue([
      { cpu: 1, ram: 2048, storage: 30 },
      { cpu: 2, ram: 2048, storage: 30 },
    ] as never);
    // used cpu = 3; +2 = 5 > max 4 → cpu violation
    await expect(
      assertWithinQuota(user(), input({ cpu: 2, ram: 1024, storage: 10 })),
    ).rejects.toBeInstanceOf(QuotaError);
  });
});

describe('quota-exempt VMs (admin grants, owner decision 2026-07-11)', () => {
  it('an exempt create skips the quota check entirely', async () => {
    await expect(
      assertWithinQuota(user(), input({ cpu: 9999, ram: 9_999_999, storage: 99999, quotaExempt: true })),
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('usage sums exclude exempt VMs (the where clause filters them out)', async () => {
    findMany.mockResolvedValue([] as never);
    await assertWithinQuota(user(), input());
    expect(findMany).toHaveBeenCalledWith({ where: { userId: 'u1', quotaExempt: false } });
  });

  it('resizing an exempt VM skips the check — exempt stays exempt', async () => {
    await expect(
      assertResizeWithinQuota(
        user(),
        { id: 'v1', userId: 'u1', quotaExempt: true } as never,
        { cpu: 9999, ram: 9_999_999, storage: 99999 },
      ),
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('a resize of a normal VM ignores exempt siblings in the usage sum', async () => {
    findMany.mockResolvedValue([] as never);
    await assertResizeWithinQuota(
      user(),
      { id: 'v1', userId: 'u1', quotaExempt: false } as never,
      { cpu: 1, ram: 1024, storage: 10 },
    );
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', id: { not: 'v1' }, quotaExempt: false },
    });
  });
});

describe('resolveCreateTarget (admin-only create options)', () => {
  it('rejects a tenant using node / forUserId / quotaExempt (closes the ungated node param)', async () => {
    for (const opts of [{ node: 'pve' }, { forUserId: 'u2' }, { quotaExempt: true }, { quotaExempt: false }]) {
      await expect(resolveCreateTarget({ id: 'u1', role: 'user' }, opts)).rejects.toBeInstanceOf(CreateOptionError);
    }
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it('a plain tenant create resolves to the tenant themself', async () => {
    userFindUnique.mockResolvedValue({ id: 'u1', role: 'user' } as never);
    const owner = await resolveCreateTarget({ id: 'u1', role: 'user' }, {});
    expect(owner.id).toBe('u1');
    expect(userFindUnique).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });

  it('an admin deploy-for resolves the TARGET user (quota applies to them)', async () => {
    userFindUnique.mockResolvedValue({ id: 'tenant9', role: 'user', maxCpu: 2 } as never);
    const owner = await resolveCreateTarget({ id: 'admin1', role: 'admin' }, { forUserId: 'tenant9', quotaExempt: true, node: 'pve-2' });
    expect(owner.id).toBe('tenant9');
    expect(userFindUnique).toHaveBeenCalledWith({ where: { id: 'tenant9' } });
  });

  it('404s (status) on a missing deploy-for target', async () => {
    userFindUnique.mockResolvedValue(null as never);
    let err: unknown;
    try {
      await resolveCreateTarget({ id: 'admin1', role: 'admin' }, { forUserId: 'ghost' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CreateOptionError);
    expect((err as CreateOptionError).status).toBe(404);
  });
});

describe('getOwnedVm (ownership / tenant isolation at the data layer)', () => {
  it('returns null when the VM does not exist', async () => {
    findUnique.mockResolvedValue(null);
    expect(await getOwnedVm('missing', { id: 'u1', role: 'user' })).toBeNull();
  });

  it('returns the VM to its owner', async () => {
    const vm = { id: 'vm1', userId: 'u1' };
    findUnique.mockResolvedValue(vm as never);
    expect(await getOwnedVm('vm1', { id: 'u1', role: 'user' })).toBe(vm);
  });

  it("hides another tenant's VM from a non-admin", async () => {
    findUnique.mockResolvedValue({ id: 'vm1', userId: 'someone-else' } as never);
    expect(await getOwnedVm('vm1', { id: 'u1', role: 'user' })).toBeNull();
  });

  it('lets an admin access any VM', async () => {
    const vm = { id: 'vm1', userId: 'someone-else' };
    findUnique.mockResolvedValue(vm as never);
    expect(await getOwnedVm('vm1', { id: 'admin', role: 'admin' })).toBe(vm);
  });
});

describe('updateVm (user-editable notes/description)', () => {
  it('writes the new description scoped to the VM id', async () => {
    const vm = { id: 'vm1' } as never;
    update.mockResolvedValue({ id: 'vm1', description: 'my notes' } as never);
    const result = await updateVm(vm, { description: 'my notes' });
    expect(update).toHaveBeenCalledWith({ where: { id: 'vm1' }, data: { description: 'my notes' } });
    expect(result).toEqual({ id: 'vm1', description: 'my notes' });
  });

  it('passes a null through to clear the field', async () => {
    const vm = { id: 'vm1' } as never;
    update.mockResolvedValue({ id: 'vm1', description: null } as never);
    await updateVm(vm, { description: null });
    expect(update).toHaveBeenCalledWith({ where: { id: 'vm1' }, data: { description: null } });
  });
});
