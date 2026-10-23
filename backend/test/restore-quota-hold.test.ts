import { describe, it, expect, vi, beforeEach } from 'vitest';

// A guest must never be startable until (1) its isolation, bridge and name are
// re-applied, (2) its sizes are synced and within quota, (3) its devices are
// approved. These tests drive a MateState restore against an in-memory DB so the
// quota the owner sees DURING the restore is the real one.

type Row = Record<string, unknown> & { id: string; userId: string; cpu: number; ram: number; storage: number };
const db = { rows: new Map<string, Row>() };

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = db.rows.get(where.id);
        return r ? { ...r } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { userId?: string; id?: { not: string } } }) =>
        [...db.rows.values()].filter((r) => (!where.userId || r.userId === where.userId) && (!where.id || r.id !== where.id.not)),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = { ...db.rows.get(where.id)!, ...data } as Row;
        db.rows.set(where.id, r);
        return { ...r };
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200, accessExpiresAt: null })),
    },
    mateState: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (key: string) => ({ default_bridge: 'vmbr0', isolation_enabled: 'true' })[key] ?? null),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  const getClient = vi.fn();
  // disk.service calls these without a client; route them to the fake one.
  type C = Parameters<typeof actual.getVmConfig>[2];
  return {
    ...actual,
    getClient,
    getVmConfig: async (n: string, v: number, c?: C, k?: 'qemu' | 'lxc') => actual.getVmConfig(n, v, c ?? (await getClient()), k),
    removeDisk: async (n: string, v: number, slot: string, c?: C) => actual.removeDisk(n, v, slot, c ?? (await getClient())),
    readIsolationOptions: vi.fn(async () => ({ dnsServers: [] })),
    configureVmIsolation: vi.fn(async () => undefined),
  };
});

import * as pve from '../src/services/proxmox.service.js';
import {
  guestMarker,
  QuotaError,
  acquireQuotaLock,
  assertWithinQuota,
  startVm,
  GuestErroredError,
  QUOTA_HOLD_MESSAGE,
  RESTORE_FAILED_MESSAGE,
  FOREIGN_VOLUME_MESSAGE,
} from '../src/services/vm.service.js';
import { restoreFromMateState } from '../src/services/matestate.service.js';
import { removeDataDisk } from '../src/services/disk.service.js';
import { fakeClient, asClient } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const VOLID = 'backups:backup/vzdump-qemu-100-2026_10_01-03_00_00.vma.zst';
const marker = guestMarker('rowa');
const ms = { id: 'ms1', vmId: 'rowa', status: 'ready', volid: VOLID, proxmoxNode: 'pve1', storage: 'backups' } as never;
const LIVE = { name: 'web', tags: marker, cores: '1', memory: '1024', scsi0: 'local-lvm:vm-100-disk-0,size=32G', net0: 'virtio=AA:BB,bridge=vmbr0,firewall=1' };

/** Fake PVE. `restored` is the guest's config after the restore; `archive` what extractconfig says. */
function fakePve(archive: Record<string, string>, restored: Record<string, string> = archive) {
  const c = fakeClient();
  const state = { cfg: { ...LIVE } as Record<string, string>, taskDone: true };
  const toText = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n');
  c.get.mockImplementation((url: string) => {
    if (url.startsWith('/cluster/resources')) return ok([{ type: 'qemu', vmid: 100, node: 'pve1' }, { type: 'node', node: 'pve1', status: 'online' }]);
    if (/\/qemu\/100\/config$/.test(url)) return ok(state.cfg);
    if (/\/qemu\/100\/status\/current$/.test(url)) return ok({ status: 'stopped' });
    if (/\/tasks\/.*\/status$/.test(url)) return ok(state.taskDone ? { status: 'stopped', exitstatus: 'OK' } : { status: 'running' });
    if (url.startsWith('/nodes/pve1/vzdump/extractconfig')) return ok(toText(archive));
    if (url.startsWith('/nodes/pve1/storage/backups/content')) return ok([{ volid: VOLID, vmid: 100 }]);
    if (/\/firewall\/rules$/.test(url)) return ok([]);
    return ok(null);
  });
  c.post.mockImplementation((url: string) => {
    if (url === '/nodes/pve1/qemu') state.cfg = { ...restored };
    return ok('UPID:fake');
  });
  c.put.mockImplementation((url: string, body: URLSearchParams) => {
    if (/\/qemu\/100\/config$/.test(url)) {
      for (const [k, v] of body) {
        if (k === 'delete') for (const d of v.split(',')) delete state.cfg[d];
        else state.cfg[k] = v;
      }
    }
    return ok('');
  });
  c.delete.mockImplementation(() => ok(''));
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return { c, state };
}

const started = (c: ReturnType<typeof fakeClient>) => c.post.mock.calls.some((x) => /status\/start$/.test(String(x[0])));

beforeEach(() => {
  vi.clearAllMocks();
  db.rows.clear();
  db.rows.set('rowa', {
    id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1',
    cpu: 1, ram: 1024, storage: 32, hasPassthrough: false, quotaExempt: false, status: 'running', holdReason: null,
  });
});

describe('quota during a restore (audit MAJOR 2)', () => {
  it('a deploy for the same owner while the restore runs is judged against the restore\'s sizes', async () => {
    const { state } = fakePve({ ...LIVE, cores: '8', memory: '8192' });
    state.taskDone = false;
    const restore = restoreFromMateState(db.rows.get('rowa') as never, ms);
    await vi.waitFor(() => expect(db.rows.get('rowa')!.cpu).toBe(8));

    // A concurrent create for the same owner: 8 cores reserved, so 1 more doesn't fit.
    const release = await acquireQuotaLock('u1');
    try {
      await expect(
        assertWithinQuota({ id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200 } as never, {
          name: 'x', cpu: 1, ram: 512, storage: 10, os: 'x.iso',
        }),
      ).rejects.toBeInstanceOf(QuotaError);
    } finally {
      release();
    }
    state.taskDone = true;
    await restore;
    expect(db.rows.get('rowa')).toMatchObject({ cpu: 8, ram: 8192, status: 'running' });
  });

  it('gives the reservation back when the restore never started', async () => {
    const { c } = fakePve({ ...LIVE, cores: '8' });
    c.post.mockRejectedValue(new Error('restore refused'));
    await expect(restoreFromMateState(db.rows.get('rowa') as never, ms)).rejects.toThrow(/restore refused/);
    expect(db.rows.get('rowa')).toMatchObject({ cpu: 1, status: 'running' });
  });
});

describe('a restore that leaves the guest over its storage quota (audit MAJOR 2)', () => {
  // The archive says 32G; the restored guest really has 300G (e.g. a disk added by
  // a concurrent path, or a size the archive under-reported).
  const big = { ...LIVE, tags: '', scsi1: 'local-lvm:vm-100-disk-1,size=300G', net0: 'virtio=AA:BB,bridge=vmbr7' };

  it('re-applies isolation first, records the real size, holds the row in error and never starts it', async () => {
    const { c, state } = fakePve(LIVE, big);
    await expect(restoreFromMateState(db.rows.get('rowa') as never, ms)).rejects.toBeInstanceOf(QuotaError);
    expect(state.cfg['net0']).toContain('bridge=vmbr0');
    expect(pve.configureVmIsolation).toHaveBeenCalled();
    expect(started(c)).toBe(false);
    expect(db.rows.get('rowa')).toMatchObject({ storage: 332, status: 'error', holdReason: QUOTA_HOLD_MESSAGE });
    await expect(startVm(db.rows.get('rowa') as never)).rejects.toBeInstanceOf(GuestErroredError);
  });

  it('a repeat restore that keeps the oversize is judged on the full quota and does not lift the hold (audit round 2)', async () => {
    const { c } = fakePve(LIVE, big);
    await expect(restoreFromMateState(db.rows.get('rowa') as never, ms)).rejects.toBeInstanceOf(QuotaError);
    c.post.mockClear();
    // Same backup again — the archive says 332 GB now, which does not "grow" the row.
    fakePve(big, big);
    await expect(restoreFromMateState(db.rows.get('rowa') as never, ms)).rejects.toBeInstanceOf(QuotaError);
    expect(db.rows.get('rowa')).toMatchObject({ status: 'error', holdReason: QUOTA_HOLD_MESSAGE });
  });

  it('removing the extra data disk lifts the hold', async () => {
    fakePve(LIVE, big);
    await expect(restoreFromMateState(db.rows.get('rowa') as never, ms)).rejects.toBeInstanceOf(QuotaError);
    await removeDataDisk(db.rows.get('rowa') as never, 'scsi1');
    expect(db.rows.get('rowa')).toMatchObject({ storage: 32, status: 'stopped', holdReason: null });
    // Lifting the hold also settles any task the row still named, so the restart
    // reconciler never takes the now-running machine for an interrupted one.
    expect(db.rows.get('rowa')).toMatchObject({ opKind: null, opUpid: null, opArchive: null });
  });
});

describe('a restored config pointing at another guest\'s volume (audit round 2, blocker 2)', () => {
  it('detaches it, holds the row and never starts the guest', async () => {
    const { c, state } = fakePve(LIVE, { ...LIVE, tags: '', scsi1: 'local-lvm:vm-200-disk-0,size=10G' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined); // audit table not mocked here
    await expect(restoreFromMateState(db.rows.get('rowa') as never, ms)).rejects.toThrow(/belong to another guest/);
    errSpy.mockRestore();
    expect(state.cfg['scsi1']).toBeUndefined();
    expect(started(c)).toBe(false);
    expect(db.rows.get('rowa')).toMatchObject({ status: 'error', holdReason: FOREIGN_VOLUME_MESSAGE });
  });
});

describe('a restore that fails after its task ran (audit MAJOR 2)', () => {
  it('leaves the row in error with an explanation, and the guest off', async () => {
    const { c } = fakePve(LIVE);
    vi.mocked(pve.configureVmIsolation).mockRejectedValueOnce(new Error('firewall API down'));
    await expect(restoreFromMateState(db.rows.get('rowa') as never, ms)).rejects.toThrow(/firewall API down/);
    expect(started(c)).toBe(false);
    expect(db.rows.get('rowa')).toMatchObject({ status: 'error', holdReason: RESTORE_FAILED_MESSAGE });
  });

  it('a successful restore clears the error and records the guest as running', async () => {
    db.rows.set('rowa', { ...db.rows.get('rowa')!, status: 'error', holdReason: RESTORE_FAILED_MESSAGE });
    const { c } = fakePve(LIVE);
    await restoreFromMateState(db.rows.get('rowa') as never, ms);
    expect(started(c)).toBe(true);
    expect(db.rows.get('rowa')).toMatchObject({ status: 'running', holdReason: null });
  });
});
