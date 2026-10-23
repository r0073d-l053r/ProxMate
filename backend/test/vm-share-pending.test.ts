import { describe, it, expect, vi, beforeEach } from 'vitest';

// Sharing with an address that has no account yet keeps a pending share. It turns
// into a live share only when an account is created with that address AND the
// address is confirmed (emailed invite or verified SSO email).

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    vmShare: { findFirst: vi.fn(), count: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    pendingVmShare: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import {
  addShare,
  addShareWithNotice,
  removeShare,
  claimPendingShares,
  MAX_SHARES_PER_VM,
  ShareError,
} from '../src/services/vm-share.service.js';

const vm = { id: 'vm1', userId: 'owner' };
const at = new Date('2026-10-20T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.vmShare.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.pendingVmShare.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.vmShare.count).mockResolvedValue(0);
  vi.mocked(prisma.pendingVmShare.count).mockResolvedValue(0);
  vi.mocked(prisma.pendingVmShare.upsert).mockImplementation((async (a: { create: Record<string, unknown> }) =>
    ({ id: 'p1', createdAt: at, ...a.create })) as never);
  vi.mocked(prisma.vmShare.upsert).mockImplementation((async (a: { create: Record<string, unknown> }) =>
    ({ id: 's1', createdAt: at, user: { email: 'known@example.com' }, ...a.create })) as never);
  vi.mocked(prisma.pendingVmShare.delete).mockResolvedValue({} as never);
});

describe('addShare', () => {
  it('keeps a pending share for an address with no account', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    const view = await addShare(vm, ' Later@Example.com ', 'operator');

    expect(prisma.pendingVmShare.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { vmId_email: { vmId: 'vm1', email: 'later@example.com' } },
      create: { vmId: 'vm1', email: 'later@example.com', role: 'operator' },
    }));
    expect(prisma.vmShare.upsert).not.toHaveBeenCalled();
    expect(view).toEqual({ id: 'p1', email: 'later@example.com', role: 'operator', createdAt: at.toISOString() });
  });

  it('shares live with an existing account and drops an earlier pending share for that address', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u2', email: 'known@example.com' } as never);
    vi.mocked(prisma.pendingVmShare.findUnique).mockResolvedValue({ id: 'p9' } as never);

    await addShare(vm, 'known@example.com', 'viewer');

    expect(prisma.vmShare.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.pendingVmShare.upsert).not.toHaveBeenCalled();
    expect(prisma.pendingVmShare.delete).toHaveBeenCalledWith({ where: { id: 'p9' } });
  });

  it('refuses a new address once the VM holds the maximum, before looking the address up', async () => {
    vi.mocked(prisma.vmShare.count).mockResolvedValue(MAX_SHARES_PER_VM - 1);
    vi.mocked(prisma.pendingVmShare.count).mockResolvedValue(1);

    const err = await addShare(vm, 'new@example.com', 'viewer').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShareError);
    expect((err as ShareError).status).toBe(409);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('still lets an address that is already shared change its level at the cap', async () => {
    vi.mocked(prisma.vmShare.count).mockResolvedValue(MAX_SHARES_PER_VM);
    vi.mocked(prisma.pendingVmShare.findUnique).mockResolvedValue({ id: 'p1' } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await expect(addShare(vm, 'later@example.com', 'manager')).resolves.toBeTruthy();
  });

  it('refuses sharing a VM with its own owner', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'owner', email: 'me@example.com' } as never);
    await expect(addShare(vm, 'me@example.com', 'viewer')).rejects.toBeInstanceOf(ShareError);
  });
});

describe('addShareWithNotice', () => {
  const named = { ...vm, name: 'web' };

  it('has no notice for a pending share — nobody is emailed', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const { notice } = await addShareWithNotice(named, 'later@example.com', 'operator');
    expect(notice).toBeNull();
  });

  it('notices a new live share, including one that replaces a pending share', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u2', email: 'known@example.com' } as never);
    vi.mocked(prisma.pendingVmShare.findUnique).mockResolvedValue({ id: 'p9' } as never);
    const { notice } = await addShareWithNotice(named, 'known@example.com', 'viewer');
    expect(notice).toEqual({ userId: 'u2', vmId: 'vm1', vmName: 'web', role: 'viewer', previousRole: null });
  });

  it('notices a level change with the previous level, and not a re-save at the same level', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u2', email: 'known@example.com' } as never);
    vi.mocked(prisma.vmShare.findFirst).mockResolvedValue({ id: 's1', role: 'co-owner' } as never);
    expect((await addShareWithNotice(named, 'known@example.com', 'operator')).notice).toMatchObject({
      role: 'operator',
      previousRole: 'manager',
    });
    expect((await addShareWithNotice(named, 'known@example.com', 'manager')).notice).toBeNull();
  });
});

describe('removeShare', () => {
  it('removes a pending share by its id', async () => {
    vi.mocked(prisma.vmShare.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.pendingVmShare.findFirst).mockResolvedValue({ id: 'p1', vmId: 'vm1' } as never);

    expect(await removeShare('vm1', 'p1')).toBe(true);
    expect(prisma.pendingVmShare.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });

  it('answers false for an id that is neither', async () => {
    vi.mocked(prisma.pendingVmShare.findFirst).mockResolvedValue(null);
    expect(await removeShare('vm1', 'nope')).toBe(false);
  });
});

describe('claimPendingShares', () => {
  const pending = [
    { id: 'p1', vmId: 'vm1', email: 'new@example.com', role: 'operator', vm: { userId: 'owner' } },
    { id: 'p2', vmId: 'vm2', email: 'new@example.com', role: 'co-owner', vm: { userId: 'owner2' } },
  ];

  it('does nothing for an account whose address nobody confirmed', async () => {
    expect(await claimPendingShares({ id: 'u9', email: 'new@example.com', emailBound: false })).toBe(0);
    expect(prisma.pendingVmShare.findMany).not.toHaveBeenCalled();
    expect(prisma.vmShare.upsert).not.toHaveBeenCalled();
  });

  it('turns every pending share for a confirmed address into a live share', async () => {
    vi.mocked(prisma.pendingVmShare.findMany).mockResolvedValue(pending as never);

    expect(await claimPendingShares({ id: 'u9', email: 'New@Example.com', emailBound: true })).toBe(2);

    expect(prisma.pendingVmShare.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'new@example.com' } }));
    expect(prisma.vmShare.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { vmId: 'vm1', userId: 'u9', role: 'operator' },
    }));
    // Legacy role names are normalised on the way in.
    expect(prisma.vmShare.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { vmId: 'vm2', userId: 'u9', role: 'manager' },
    }));
    expect(prisma.pendingVmShare.delete).toHaveBeenCalledTimes(2);
  });

  it('never shares a VM with its own owner', async () => {
    vi.mocked(prisma.pendingVmShare.findMany).mockResolvedValue([{ ...pending[0], vm: { userId: 'u9' } }] as never);

    expect(await claimPendingShares({ id: 'u9', email: 'new@example.com', emailBound: true })).toBe(0);
    expect(prisma.vmShare.upsert).not.toHaveBeenCalled();
    expect(prisma.pendingVmShare.delete).toHaveBeenCalledTimes(1);
  });
});
