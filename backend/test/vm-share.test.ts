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
  getVmWithCap,
  getViewableVm,
  annotateAccess,
  listVms,
} from '../src/services/vm.service.js';
import {
  VM_CAPS,
  SHARE_ROLES,
  CAPS_BY_ROLE,
  ALL_CAPS,
  normalizeShareRole,
  type VmCap,
} from '../src/services/vm-share.service.js';

const vmFindUnique = vi.mocked(prisma.virtualMachine.findUnique);
const vmFindMany = vi.mocked(prisma.virtualMachine.findMany);
const shareFindUnique = vi.mocked(prisma.vmShare.findUnique);
const shareFindMany = vi.mocked(prisma.vmShare.findMany);

const VM = { id: 'vm1', userId: 'owner1' };

beforeEach(() => vi.clearAllMocks());

// ─── The capability model itself ──────────────────────────────────────────────

describe('caps model invariants', () => {
  it('presets strictly escalate: viewer ⊂ operator ⊂ manager', () => {
    for (const cap of CAPS_BY_ROLE.viewer) expect(CAPS_BY_ROLE.operator.has(cap)).toBe(true);
    for (const cap of CAPS_BY_ROLE.operator) expect(CAPS_BY_ROLE.manager.has(cap)).toBe(true);
    expect(CAPS_BY_ROLE.viewer.size).toBeLessThan(CAPS_BY_ROLE.operator.size);
    expect(CAPS_BY_ROLE.operator.size).toBeLessThan(CAPS_BY_ROLE.manager.size);
  });

  it('every preset can at least view, and ALL_CAPS covers the full vocabulary', () => {
    for (const role of SHARE_ROLES) expect(CAPS_BY_ROLE[role].has('view')).toBe(true);
    expect([...ALL_CAPS].sort()).toEqual([...VM_CAPS].sort());
  });

  it('normalizeShareRole maps legacy + unknown strings safely (least privilege)', () => {
    expect(normalizeShareRole('co-owner')).toBe('manager');
    expect(normalizeShareRole('read-only')).toBe('viewer');
    expect(normalizeShareRole('garbage')).toBe('viewer');
    for (const role of SHARE_ROLES) expect(normalizeShareRole(role)).toBe(role);
  });
});

// ─── resolveVmAccess ──────────────────────────────────────────────────────────

describe('resolveVmAccess', () => {
  it('owner + admin get every capability', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    const owner = await resolveVmAccess('vm1', { id: 'owner1', role: 'user' });
    expect(owner?.access).toBe('owner');
    expect([...(owner?.caps ?? [])].sort()).toEqual([...VM_CAPS].sort());
    const admin = await resolveVmAccess('vm1', { id: 'x', role: 'admin' });
    expect(admin?.access).toBe('admin');
    expect(admin?.caps.has('ide')).toBe(true);
  });

  it('maps each preset to its capability set', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    for (const role of SHARE_ROLES) {
      shareFindUnique.mockResolvedValue({ role } as never);
      const r = await resolveVmAccess('vm1', { id: 'friend', role: 'user' });
      expect(r?.access).toBe(role);
      expect(r?.caps).toEqual(CAPS_BY_ROLE[role]);
    }
  });

  it('a legacy stored co-owner row behaves as manager (defense-in-depth)', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    shareFindUnique.mockResolvedValue({ role: 'co-owner' } as never);
    const r = await resolveVmAccess('vm1', { id: 'friend', role: 'user' });
    expect(r?.access).toBe('manager');
    expect(r?.caps.has('configure')).toBe(true);
  });

  it('returns null for a stranger', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    shareFindUnique.mockResolvedValue(null as never);
    expect(await resolveVmAccess('vm1', { id: 'stranger', role: 'user' })).toBeNull();
  });
});

// ─── getVmWithCap: the full preset × capability matrix ────────────────────────

describe('getVmWithCap matrix', () => {
  const expected: Record<string, Record<VmCap, boolean>> = {
    viewer: { view: true, power: false, console: false, configure: false, backups: false, ide: false },
    operator: { view: true, power: true, console: true, configure: false, backups: false, ide: false },
    manager: { view: true, power: true, console: true, configure: true, backups: true, ide: true },
  };

  for (const role of SHARE_ROLES) {
    for (const cap of VM_CAPS) {
      const allowed = expected[role]![cap];
      it(`${role} ${allowed ? 'holds' : 'lacks'} ${cap}`, async () => {
        vmFindUnique.mockResolvedValue(VM as never);
        shareFindUnique.mockResolvedValue({ role } as never);
        const vm = await getVmWithCap('vm1', { id: 'friend', role: 'user' }, cap);
        expect(vm ? true : false).toBe(allowed);
      });
    }
  }

  it('owner and admin pass every capability', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    for (const cap of VM_CAPS) {
      expect(await getVmWithCap('vm1', { id: 'owner1', role: 'user' }, cap)).not.toBeNull();
      expect(await getVmWithCap('vm1', { id: 'x', role: 'admin' }, cap)).not.toBeNull();
    }
  });

  it('getViewableVm is the view capability', async () => {
    vmFindUnique.mockResolvedValue(VM as never);
    shareFindUnique.mockResolvedValue({ role: 'viewer' } as never);
    expect(await getViewableVm('vm1', { id: 'friend', role: 'user' })).not.toBeNull();
    shareFindUnique.mockResolvedValue(null as never);
    expect(await getViewableVm('vm1', { id: 'stranger', role: 'user' })).toBeNull();
  });
});

// ─── annotateAccess + listVms ─────────────────────────────────────────────────

describe('annotateAccess', () => {
  it('tags owner + normalized share roles with caps arrays for a non-admin', async () => {
    const vms = [
      { id: 'vm1', userId: 'me' },
      { id: 'vm2', userId: 'someone' },
      { id: 'vm3', userId: 'someone' },
    ];
    shareFindMany.mockResolvedValue([
      { vmId: 'vm2', role: 'operator' },
      { vmId: 'vm3', role: 'co-owner' }, // legacy row → manager
    ] as never);
    const tagged = await annotateAccess(vms, { id: 'me', role: 'user' });
    expect(tagged.map((v) => v.access)).toEqual(['owner', 'operator', 'manager']);
    expect(tagged[0]!.caps.sort()).toEqual([...VM_CAPS].sort());
    expect(tagged[1]!.caps.sort()).toEqual([...CAPS_BY_ROLE.operator].sort());
  });

  it('tags everything admin for an admin without reading shares', async () => {
    const tagged = await annotateAccess([{ id: 'vm1', userId: 'someone' }], { id: 'a', role: 'admin' });
    expect(tagged[0]!.access).toBe('admin');
    expect(shareFindMany).not.toHaveBeenCalled();
  });
});

describe('listVms', () => {
  it('includes owned + shared VMs for a tenant', async () => {
    shareFindMany.mockResolvedValue([{ vmId: 'vm9' }] as never);
    vmFindMany.mockResolvedValue([] as never);
    await listVms({ id: 'me', role: 'user' });
    expect(vmFindMany).toHaveBeenCalledWith({
      where: { OR: [{ userId: 'me' }, { id: { in: ['vm9'] } }] },
      orderBy: { createdAt: 'desc' },
    });
  });
});
