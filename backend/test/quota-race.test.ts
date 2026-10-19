import { describe, it, expect, vi, beforeEach } from 'vitest';

// Overlapping creates for one tenant must not all pass a quota check that each ran
// before the others' rows existed. The DB below is a tiny in-memory table so usage
// reflects whatever rows have actually been written at the moment of each check.

const rows: Array<Record<string, unknown>> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; id?: { not: string } } }) =>
        rows.filter((r) => r['userId'] === where.userId && (!where.id || r['id'] !== where.id.not)),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `row${rows.length}`, quotaExempt: false, ...data };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r['id'] === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          row[k] =
            typeof v === 'object' && v && 'increment' in v
              ? (row[k] as number) + (v as { increment: number }).increment
              : typeof v === 'object' && v && 'decrement' in v
                ? (row[k] as number) - (v as { decrement: number }).decrement
                : v;
        }
        return row;
      }),
      delete: vi.fn(),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r['id'] === where.id) ?? null),
    },
    user: { findUnique: vi.fn(async () => USER) },
  },
}));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (key: string) =>
    ({ default_storage: 'local-lvm', default_bridge: 'vmbr0', iso_storage: 'local', isolation_enabled: 'false' })[key] ?? null,
  ),
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
let nextId = 100;
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(),
    // Proxmox round-trips take a while — the window the old check-then-act lost.
    getIsoNodes: vi.fn(async () => (await sleep(20), ['pve1'])),
    pickBestNode: vi.fn(async () => (await sleep(20), 'pve1')),
    getNextVmId: vi.fn(async () => (await sleep(5), nextId++)),
    getVmConfig: vi.fn(async () => (await sleep(10), { tags: 'proxmate-vm-a', scsi0: 'local-lvm:vm-1-disk-0,size=10G' })),
    attachDisk: vi.fn(async () => sleep(10)),
    removeDisk: vi.fn(async () => sleep(10)),
  };
});

import * as pve from '../src/services/proxmox.service.js';
import { createVm, resizeVm, QuotaError } from '../src/services/vm.service.js';
import { addDataDisk, removeDataDisk } from '../src/services/disk.service.js';
import { fakeClient, asClient } from './helpers.js';

let c: ReturnType<typeof fakeClient>;
const USER = { id: 'u1', role: 'user', maxCpu: 4, maxRam: 4096, maxStorage: 50 } as never;

beforeEach(() => {
  rows.length = 0;
  nextId = 100;
  c = fakeClient();
  c.get.mockImplementation((url: string) =>
    Promise.resolve({ data: { data: /\/tasks\//.test(url) ? { status: 'stopped', exitstatus: 'OK' } : null } }),
  );
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
});

describe('concurrent creates against one quota', () => {
  it('admits only what fits, however many requests overlap', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        createVm(USER, { name: `vm${i}`, cpu: 4, ram: 4096, storage: 50, os: 'debian.iso' }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const quota = results.filter((r) => r.status === 'rejected' && r.reason instanceof QuotaError);
    expect(ok).toHaveLength(1);
    expect(quota).toHaveLength(9);
    expect(rows.reduce((s, r) => s + (r['cpu'] as number), 0)).toBe(4);
  });
});

describe('concurrent data-disk adds against one quota', () => {
  it('counts both adds (no lost update) and refuses the one that no longer fits', async () => {
    rows.push({ id: 'vm-a', userId: 'u1', storage: 10, cpu: 1, ram: 512, quotaExempt: false });
    const vm = { ...rows[0] } as never;
    const results = await Promise.allSettled([addDataDisk(vm, 20), addDataDisk(vm, 20), addDataDisk(vm, 20)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof QuotaError)).toHaveLength(1);
    expect(rows[0]!['storage']).toBe(50);
  });
});

describe('resize and disk changes overlapping on one VM', () => {
  it('a resize is judged on the row as it is under the lock, not the copy the caller loaded', async () => {
    rows.push({ id: 'vm-a', userId: 'u1', storage: 10, cpu: 1, ram: 512, quotaExempt: false });
    const stale = { ...rows[0] } as never; // the caller loaded storage = 10
    // A 20 GB data disk lands first; the resize then asks for a 45 GB total.
    await Promise.all([addDataDisk(stale, 20), resizeVm(USER, stale, { storage: 45 })]);
    // 10 → 30 (disk) → 45 (resize): the root grows by 15 GB, not by 35.
    const resize = c.put.mock.calls.find((x) => /\/resize$/.test(String(x[0])));
    expect(Object.fromEntries(resize![1] as URLSearchParams)).toEqual({ disk: 'scsi0', size: '25G' });
    expect(rows[0]!['storage']).toBe(45);
  });

  it('removing a data disk frees exactly its size even when the caller\'s copy is stale', async () => {
    rows.push({ id: 'vm-a', userId: 'u1', storage: 10, cpu: 1, ram: 512, quotaExempt: false });
    const stale = { ...rows[0] } as never;
    vi.mocked(pve.getVmConfig).mockImplementation(async () => ({
      tags: 'proxmate-vm-a',
      scsi0: 'local-lvm:vm-1-disk-0,size=10G',
      scsi1: 'local-lvm:vm-1-disk-1,size=20G',
    }));
    await Promise.all([addDataDisk(stale, 15), removeDataDisk(stale, 'scsi1')]);
    expect(rows[0]!['storage']).toBe(5); // 10 + 15 - 20 (the stale copy would have written 10 - 20 → 0)
  });

  it('removing a data disk never drives recorded storage below zero', async () => {
    rows.push({ id: 'vm-a', userId: 'u1', storage: 10, cpu: 1, ram: 512, quotaExempt: false });
    vi.mocked(pve.getVmConfig).mockImplementation(async () => ({
      tags: 'proxmate-vm-a',
      scsi0: 'local-lvm:vm-1-disk-0,size=10G',
      scsi1: 'local-lvm:vm-1-disk-1,size=20G',
    }));
    await removeDataDisk({ ...rows[0] } as never, 'scsi1');
    expect(rows[0]!['storage']).toBe(0);
  });
});
