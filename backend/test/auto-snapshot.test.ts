import { describe, it, expect, vi, beforeEach } from 'vitest';

// Automatic snapshots before risky changes: taken (or honestly skipped), recorded,
// and pruned — where retention may only ever delete a snapshot ProxMate recorded
// itself, never one a user took.

const records: Array<{ id: string; vmId: string; name: string; op: string; snaptime: number | null; createdAt: Date }> = [];
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    autoSnapshot: {
      findMany: vi.fn(async () => [...records].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())),
      create: vi.fn(async ({ data }: { data: (typeof records)[number] }) => {
        const r = { ...data, id: `rec-${records.length + 1}`, createdAt: new Date() };
        records.push(r);
        return r;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const i = records.findIndex((r) => r.id === where.id);
        if (i >= 0) records.splice(i, 1);
        return {};
      }),
    },
  },
}));
const config: Record<string, string> = {};
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (k: string) => config[k] ?? null),
  setConfig: vi.fn(async (k: string, v: string) => {
    config[k] = v;
  }),
}));

import { prisma } from '../src/lib/prisma.js';
import {
  autoSnapshotBefore,
  autoSnapshotName,
  getAutoSnapshotSettings,
  saveAutoSnapshotSettings,
  isReservedSnapshotName,
  pruneAutoSnapshots,
  AutoSnapshotError,
  MAX_SNAPSHOTS_PER_VM,
} from '../src/services/auto-snapshot.service.js';
import { fakeClient, asClient, type FakeClient } from './helpers.js';

const NOW = new Date('2026-10-23T15:30:00Z');
const vm = (over: Record<string, unknown> = {}) =>
  ({ id: 'vm1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1', ...over }) as never;

type Snap = { name: string; snaptime?: number; description?: string };

/** Fake PVE holding a snapshot list that create/delete act on. */
function pveWith(initial: Snap[], opts: { feature?: number; createFails?: string } = {}) {
  let snaps = [...initial];
  let t = 1_800_000_000;
  const c: FakeClient = fakeClient();
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  c.get.mockImplementation((url: string) => {
    if (/\/feature\?feature=snapshot$/.test(url)) return ok({ hasFeature: opts.feature ?? 1 });
    if (/\/qemu\/100\/snapshot$/.test(url)) return ok([...snaps, { name: 'current' }]);
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    return ok(null);
  });
  c.post.mockImplementation((url: string, body: URLSearchParams) => {
    if (/\/qemu\/100\/snapshot$/.test(url)) {
      if (opts.createFails) return Promise.reject(new Error(opts.createFails));
      snaps.push({ name: body.get('snapname')!, snaptime: ++t });
      return ok('UPID:pve1:snap');
    }
    return ok('UPID:pve1:x');
  });
  c.delete.mockImplementation((url: string) => {
    const name = decodeURIComponent(url.split('/').pop()!);
    snaps = snaps.filter((s) => s.name !== name);
    return ok('UPID:pve1:del');
  });
  return { c, snaps: () => snaps };
}

const deletedNames = (c: FakeClient) => c.delete.mock.calls.map((x) => decodeURIComponent(String(x[0]).split('/').pop()!));

beforeEach(() => {
  vi.clearAllMocks();
  records.length = 0;
  for (const k of Object.keys(config)) delete config[k];
});

describe('settings', () => {
  it('defaults to on, keeping 3; saves and validates the keep count', async () => {
    expect(await getAutoSnapshotSettings()).toEqual({ enabled: true, keep: 3 });
    await saveAutoSnapshotSettings({ enabled: false, keep: 5 });
    expect(await getAutoSnapshotSettings()).toEqual({ enabled: false, keep: 5 });
    config['auto_snapshot_keep'] = 'lots';
    expect((await getAutoSnapshotSettings()).keep).toBe(3);
  });

  it('reserves the pm-auto- prefix and names snapshots clearly', () => {
    expect(isReservedSnapshotName('pm-auto-mine')).toBe(true);
    expect(isReservedSnapshotName('PM-AUTO-x')).toBe(true);
    expect(isReservedSnapshotName('before-upgrade')).toBe(false);
    expect(autoSnapshotName('disk-resize', NOW)).toBe('pm-auto-disk-resize-20261023-153000');
    // Proxmox caps snapshot names at 40 characters.
    expect(autoSnapshotName('disk-resize', NOW).length).toBeLessThanOrEqual(40);
  });
});

describe('autoSnapshotBefore', () => {
  it('does nothing when turned off, or for a container', async () => {
    const { c } = pveWith([]);
    config['auto_snapshot_enabled'] = 'false';
    expect(await autoSnapshotBefore(vm(), 'resize', asClient(c), NOW)).toEqual({ taken: null, skipped: 'disabled' });
    delete config['auto_snapshot_enabled'];
    expect(await autoSnapshotBefore(vm({ type: 'lxc' }), 'resize', asClient(c), NOW)).toEqual({ taken: null, skipped: 'container' });
    expect(c.get).not.toHaveBeenCalled();
    expect(c.post).not.toHaveBeenCalled();
  });

  it('reports (rather than fails on) storage that cannot snapshot at all', async () => {
    const { c } = pveWith([], { feature: 0 });
    expect(await autoSnapshotBefore(vm(), 'resize', asClient(c), NOW)).toEqual({ taken: null, skipped: 'unsupported' });
    expect(c.post).not.toHaveBeenCalled();
  });

  it('takes a disk-only snapshot and records it with its snaptime', async () => {
    const { c } = pveWith([]);
    expect(await autoSnapshotBefore(vm(), 'resize', asClient(c), NOW)).toEqual({ taken: 'pm-auto-resize-20261023-153000' });
    const body = c.post.mock.calls[0]![1] as URLSearchParams;
    expect(body.get('snapname')).toBe('pm-auto-resize-20261023-153000');
    expect(body.get('vmstate')).toBeNull();
    expect(records).toEqual([expect.objectContaining({ vmId: 'vm1', name: 'pm-auto-resize-20261023-153000', op: 'resize', snaptime: expect.any(Number) })]);
  });

  it('refuses (throws) when the snapshot fails, recording nothing', async () => {
    const { c } = pveWith([], { createFails: 'storage full' });
    await expect(autoSnapshotBefore(vm(), 'rescue', asClient(c), NOW)).rejects.toBeInstanceOf(AutoSnapshotError);
    await expect(autoSnapshotBefore(vm(), 'rescue', asClient(c), NOW)).rejects.toThrow(/storage full.*nothing was changed/);
    expect(prisma.autoSnapshot.create).not.toHaveBeenCalled();
  });

  it('refuses at the snapshot cap when every snapshot is the user\'s, deleting none', async () => {
    const user = Array.from({ length: MAX_SNAPSHOTS_PER_VM }, (_, i) => ({ name: `mine${i}`, snaptime: 100 + i }));
    const { c } = pveWith(user);
    await expect(autoSnapshotBefore(vm(), 'resize', asClient(c), NOW)).rejects.toThrow(/maximum of 12 snapshots/);
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('at the cap, makes room by removing only its own oldest automatic snapshot', async () => {
    const user = Array.from({ length: MAX_SNAPSHOTS_PER_VM - 1 }, (_, i) => ({ name: `mine${i}`, snaptime: 10 + i }));
    const { c } = pveWith([...user, { name: 'pm-auto-resize-20261001-000000', snaptime: 50 }]);
    records.push({ id: 'r0', vmId: 'vm1', name: 'pm-auto-resize-20261001-000000', op: 'resize', snaptime: 50, createdAt: new Date(1) });
    expect((await autoSnapshotBefore(vm(), 'resize', asClient(c), NOW)).taken).toBe('pm-auto-resize-20261023-153000');
    expect(deletedNames(c)).toEqual(['pm-auto-resize-20261001-000000']);
  });
});

describe('retention never deletes a user snapshot', () => {
  it('never deletes a recorded snapshot whose snaptime was not recorded', async () => {
    const { c } = pveWith([
      { name: 'pm-auto-resize-20260101-000000', snaptime: 1 },
      { name: 'pm-auto-resize-20260201-000000', snaptime: 2 },
    ]);
    records.push(
      { id: 'n', vmId: 'vm1', name: 'pm-auto-resize-20260101-000000', op: 'resize', snaptime: null, createdAt: new Date(1) },
      { id: 'm', vmId: 'vm1', name: 'pm-auto-resize-20260201-000000', op: 'resize', snaptime: 2, createdAt: new Date(2) },
    );
    expect(await pruneAutoSnapshots(vm(), 0, asClient(c))).toBe(1);
    expect(deletedNames(c)).toEqual(['pm-auto-resize-20260201-000000']);
  });

  it('keeps the newest N recorded automatic snapshots and nothing else is a candidate', async () => {
    const live: Snap[] = [
      { name: 'my-old-snapshot', snaptime: 1 }, // user's, older than everything
      { name: 'pm-auto-resize-20260101-000000', snaptime: 2 }, // looks automatic but was never recorded
      { name: 'pm-auto-resize-20260201-000000', snaptime: 3 }, // recorded
      { name: 'pm-auto-rescue-20260301-000000', snaptime: 4 }, // recorded
      { name: 'pm-auto-resize-20260401-000000', snaptime: 99 }, // recorded name, but a different snapshot now
      { name: 'pm-auto-resize-20260501-000000', snaptime: 6 }, // recorded
    ];
    const { c, snaps } = pveWith(live);
    records.push(
      { id: 'a', vmId: 'vm1', name: 'pm-auto-resize-20260201-000000', op: 'resize', snaptime: 3, createdAt: new Date(3) },
      { id: 'b', vmId: 'vm1', name: 'pm-auto-rescue-20260301-000000', op: 'rescue', snaptime: 4, createdAt: new Date(4) },
      { id: 'c', vmId: 'vm1', name: 'pm-auto-resize-20260401-000000', op: 'resize', snaptime: 5, createdAt: new Date(5) },
      { id: 'd', vmId: 'vm1', name: 'pm-auto-resize-20260501-000000', op: 'resize', snaptime: 6, createdAt: new Date(6) },
      { id: 'gone', vmId: 'vm1', name: 'pm-auto-resize-20250101-000000', op: 'resize', snaptime: 0, createdAt: new Date(0) },
    );

    expect(await pruneAutoSnapshots(vm(), 1, asClient(c))).toBe(2);
    expect(deletedNames(c).sort()).toEqual(['pm-auto-rescue-20260301-000000', 'pm-auto-resize-20260201-000000']);
    const left = snaps().map((s) => s.name);
    expect(left).toContain('my-old-snapshot');
    expect(left).toContain('pm-auto-resize-20260101-000000');
    expect(left).toContain('pm-auto-resize-20260401-000000');
    expect(left).toContain('pm-auto-resize-20260501-000000');
    // The record whose snapshot no longer exists is dropped; nothing is deleted for it.
    expect(records.map((r) => r.id).sort()).toEqual(['c', 'd']);
  });

  it('applies retention after each new snapshot (default keep 3)', async () => {
    const { c } = pveWith([{ name: 'keep-me', snaptime: 1 }]);
    for (let i = 0; i < 5; i++) {
      await autoSnapshotBefore(vm(), 'resize', asClient(c), new Date(NOW.getTime() + i * 1000));
    }
    expect(records).toHaveLength(3);
    expect(deletedNames(c)).not.toContain('keep-me');
    expect(deletedNames(c)).toEqual(['pm-auto-resize-20261023-153000', 'pm-auto-resize-20261023-153001']);
  });
});
