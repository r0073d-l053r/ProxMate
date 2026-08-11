import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { findMany: vi.fn() }, systemConfig: { findUnique: vi.fn() } },
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(async () => ({}) as never),
    getStorages: vi.fn(async () => []),
    getVmConfig: vi.fn(async () => ({})),
    migratePreflight: vi.fn(async () => null),
  };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { getStoragePinningReport } from '../src/services/vm.service.js';

/**
 * B-40. The B-38 fix is forward-looking: it stops NEW guests inheriting a template's
 * node-local storage, but every guest deployed before it is still where it landed —
 * pinned to one node, unmigratable, and invisible until someone tries to drain that
 * node. This report is how those get found.
 *
 * The rule it must not break: **Proxmox's own preflight is the verdict.** The shared/
 * local storage flags exist to EXPLAIN why a guest is pinned, never to decide it —
 * a second opinion that can disagree with the one actually governing the migration
 * would be worse than no report.
 */

const findMany = vi.mocked(prisma.virtualMachine.findMany);
const findConfig = vi.mocked(prisma.systemConfig.findUnique);
const getStorages = vi.mocked(pve.getStorages);
const getVmConfig = vi.mocked(pve.getVmConfig);
const preflight = vi.mocked(pve.migratePreflight);

const vm = (over: Record<string, unknown> = {}) =>
  ({ id: 'v1', name: 'student-a', proxmoxVmId: 104, proxmoxNode: 'pve', type: 'qemu', ...over }) as never;

/** `tank` is node-local (a ZFS pool on one node); `ceph-vm` spans the cluster. */
const STORAGES = [
  { storage: 'tank', type: 'zfspool', shared: 0 },
  { storage: 'ceph-vm', type: 'rbd', shared: 1 },
  { storage: 'local', type: 'dir', shared: 0 },
] as never;

beforeEach(() => {
  vi.clearAllMocks();
  findConfig.mockImplementation((args: { where: { key: string } }) =>
    (args.where.key === 'default_storage' ? { key: 'default_storage', value: 'ceph-vm', sensitive: false } : null) as never,
  );
  getStorages.mockResolvedValue(STORAGES);
});

describe('a guest that cannot migrate', () => {
  beforeEach(() => {
    findMany.mockResolvedValue([vm()] as never);
    getVmConfig.mockResolvedValue({ scsi0: 'tank:vm-104-disk-0,size=5G' } as never);
    preflight.mockResolvedValue({
      allowed: [],
      blocked: [{ node: 'pve-1', reason: "storage 'tank' is not available on node 'pve-1'" }],
      localDisks: [{ volid: 'tank:vm-104-disk-0' }],
    } as never);
  });

  it('names it, its node-local volume, and how few places it can go', async () => {
    const r = await getStoragePinningReport();
    expect(r.pinned).toHaveLength(1);
    expect(r.pinned[0]).toMatchObject({
      name: 'student-a',
      proxmoxVmId: 104,
      localStorages: ['tank'],
      localDisks: ['tank:vm-104-disk-0'],
      migrationTargets: 0,
      offDefaultStorage: true,
    });
  });

  it('reports which storages the cluster considers shared, so the verdict is explicable', async () => {
    const r = await getStoragePinningReport();
    expect(r.sharedStorages).toEqual(['ceph-vm']);
    expect(r.defaultStorage).toBe('ceph-vm');
  });
});

describe('a guest that is fine', () => {
  it('is left out entirely — the report is a work list, not an inventory', async () => {
    findMany.mockResolvedValue([vm({ name: 'healthy' })] as never);
    getVmConfig.mockResolvedValue({ scsi0: 'ceph-vm:vm-104-disk-0,size=5G' } as never);
    preflight.mockResolvedValue({ allowed: ['pve-0', 'pve-1'], blocked: [], localDisks: [] } as never);

    const r = await getStoragePinningReport();
    expect(r.pinned).toEqual([]);
    expect(r.checked).toBe(1);
  });
});

describe('Proxmox is the verdict, not our storage flags', () => {
  it('lists a guest Proxmox calls pinned even when every storage looks shared', async () => {
    // e.g. a passthrough device or a snapshot lock. If we trusted our own flags we
    // would report "fine" about a guest that cannot actually move.
    findMany.mockResolvedValue([vm({ name: 'gpu-box' })] as never);
    getVmConfig.mockResolvedValue({ scsi0: 'ceph-vm:vm-104-disk-0,size=5G' } as never);
    preflight.mockResolvedValue({
      allowed: [],
      blocked: [{ node: 'pve-1', reason: 'cannot migrate VM with local resources' }],
      localDisks: [{ volid: 'ceph-vm:vm-104-disk-0' }],
    } as never);

    const r = await getStoragePinningReport();
    expect(r.pinned).toHaveLength(1);
    expect(r.pinned[0]!.migrationTargets).toBe(0);
  });

  it('does not claim a guest is pinned when only our flags say so and Proxmox disagrees', async () => {
    // Disk on a non-shared storage, but Proxmox will still accept the migration
    // (it can copy the volume). Reporting it would send an admin chasing a non-problem.
    findMany.mockResolvedValue([vm({ name: 'copyable' })] as never);
    getVmConfig.mockResolvedValue({ scsi0: 'tank:vm-104-disk-0,size=5G' } as never);
    preflight.mockResolvedValue({ allowed: ['pve-0', 'pve-1', 'pve-2'], blocked: [], localDisks: [] } as never);

    const r = await getStoragePinningReport();
    expect(r.pinned[0]).toMatchObject({ name: 'copyable', localDisks: [], migrationTargets: 3 });
  });
});

describe('when the truth cannot be established', () => {
  it('says so instead of guessing', async () => {
    findMany.mockResolvedValue([vm()] as never);
    getVmConfig.mockResolvedValue({ scsi0: 'tank:vm-104-disk-0,size=5G' } as never);
    preflight.mockResolvedValue(null); // preflight unavailable

    const r = await getStoragePinningReport();
    expect(r.pinned).toEqual([]);
    expect(r.unknown[0]).toMatchObject({ name: 'student-a', reason: 'migration preflight unavailable' });
  });

  it('one unreadable guest does not sink the whole report', async () => {
    findMany.mockResolvedValue([vm({ id: 'a', name: 'broken' }), vm({ id: 'b', name: 'ok', proxmoxVmId: 105 })] as never);
    getVmConfig
      .mockRejectedValueOnce(new Error('VM 104 not found'))
      .mockResolvedValue({ scsi0: 'ceph-vm:vm-105-disk-0,size=5G' } as never);
    preflight.mockResolvedValue({ allowed: ['pve-0'], blocked: [], localDisks: [] } as never);

    const r = await getStoragePinningReport();
    expect(r.unknown).toHaveLength(1);
    expect(r.unknown[0]!.name).toBe('broken');
    expect(r.checked).toBe(2);
  });
});

describe('ordering', () => {
  it('puts the most stranded guest first — that is the one to move', async () => {
    findMany.mockResolvedValue([
      vm({ id: 'a', name: 'two-targets', proxmoxVmId: 101 }),
      vm({ id: 'b', name: 'stranded', proxmoxVmId: 102 }),
    ] as never);
    getVmConfig.mockResolvedValue({ scsi0: 'tank:vm-x-disk-0,size=5G' } as never);
    preflight
      .mockResolvedValueOnce({ allowed: ['pve-0', 'pve-1'], blocked: [], localDisks: [{ volid: 'tank:a' }] } as never)
      .mockResolvedValueOnce({ allowed: [], blocked: [], localDisks: [{ volid: 'tank:b' }] } as never);

    const r = await getStoragePinningReport();
    expect(r.pinned.map((p) => p.name)).toEqual(['stranded', 'two-targets']);
  });
});
