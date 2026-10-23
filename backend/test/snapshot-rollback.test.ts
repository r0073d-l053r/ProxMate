import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A snapshot holds the whole guest config of its moment. Rolling back must not
// hand back CPU/RAM/disks beyond the owner's quota, must re-sync the row, and
// must not bring back a PCI device that has since been detached.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    mateState: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', role: 'user' };
    next();
  },
  allowExpiredAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/middleware/mfa.js', () => ({
  enforceMfaSetup: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/services/audit.service.js', () => ({
  recordAudit: vi.fn(async () => undefined),
  listAuditForTarget: vi.fn(async () => []),
}));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async () => null),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  // The snapshot-delete route calls these without a client.
  return { ...actual, getClient: vi.fn(), deleteSnapshot: vi.fn(async () => 'UPID:del'), waitForTask: vi.fn(async () => undefined) };
});
vi.mock('../src/services/vm.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vm.service.js')>();
  return { ...actual, getVmWithCap: vi.fn() };
});

import vmRouter from '../src/routes/vm.routes.js';
import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { getVmWithCap, guestMarker } from '../src/services/vm.service.js';
import { fakeClient, asClient } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const marker = guestMarker('rowa');
const row = (over: Record<string, unknown> = {}) =>
  ({
    id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1',
    cpu: 1, ram: 1024, storage: 32, hasPassthrough: false, quotaExempt: false, status: 'running', ...over,
  }) as never;

const LIVE = { name: 'web', tags: marker, cores: '1', memory: '1024', scsi0: 'local-lvm:vm-100-disk-0,size=32G', net0: 'virtio=AA:BB,bridge=vmbr0,firewall=1' };
const SNAP = { name: 'web', cores: '8', memory: '16384', scsi0: 'local-lvm:vm-100-disk-0,size=32G', scsi1: 'local-lvm:vm-100-disk-1,size=100G', net0: 'virtio=AA:BB,bridge=vmbr0,firewall=1', snaptime: '1700000000' };

/** Stateful fake PVE: guest 100 on pve1 with `live`; rollback to "snap1" swaps in `snap`. */
function fakePve(live: Record<string, string>, snap: Record<string, string>) {
  const c = fakeClient();
  const state = { cfg: { ...live } as Record<string, string>, status: 'stopped' };
  c.get.mockImplementation((url: string) => {
    if (url.startsWith('/cluster/resources')) return ok([{ type: 'qemu', vmid: 100, node: 'pve1' }]);
    if (url === '/nodes/pve1/qemu/100/snapshot/snap1/config') return ok(snap);
    if (/\/qemu\/100\/config$/.test(url)) return ok(state.cfg);
    if (/\/qemu\/100\/status\/current$/.test(url)) return ok({ status: state.status });
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    if (/\/firewall\/rules$/.test(url)) return ok([]);
    return ok(null);
  });
  c.post.mockImplementation((url: string) => {
    if (url === '/nodes/pve1/qemu/100/snapshot/snap1/rollback') {
      state.cfg = Object.fromEntries(Object.entries(snap).filter(([k]) => k !== 'snaptime' && k !== 'vmstate'));
      if (snap['vmstate']) state.status = 'running';
    }
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
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return { c, state };
}

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/vms', vmRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVmWithCap).mockResolvedValue(row());
  vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row());
  vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.virtualMachine.update).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ ...(row() as object), ...data }) as never,
  );
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200, accessExpiresAt: null } as never);
});

const rollback = () => fetch(`${base}/vms/rowa/snapshots/snap1/rollback`, { method: 'POST' });
const rolledBack = (c: ReturnType<typeof fakeClient>) =>
  c.post.mock.calls.some((x) => x[0] === '/nodes/pve1/qemu/100/snapshot/snap1/rollback');

describe('snapshot rollback and the owner\'s compute-access window (BUG-067)', () => {
  const expired = () =>
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200, accessExpiresAt: new Date(Date.now() - 60_000),
    } as never);

  it('refuses a RAM snapshot (it comes back running) when the owner\'s window has closed', async () => {
    const { c } = fakePve(LIVE, { ...LIVE, vmstate: 'local-lvm:vm-100-state-snap1' });
    expired();
    const res = await rollback();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(rolledBack(c)).toBe(false);
  });

  it('still allows a disk-only rollback (the guest stays off)', async () => {
    const { c } = fakePve(LIVE, LIVE);
    expired();
    const res = await rollback();
    expect(res.status).toBe(200);
    expect(rolledBack(c)).toBe(true);
  });
});

describe('MateState restore route (BUG-024)', () => {
  it('answers 403 with the quota details when the backup would exceed the quota', async () => {
    const c = fakePve(LIVE, SNAP).c;
    const get = c.get.getMockImplementation()!;
    const text = Object.entries(SNAP).map(([k, v]) => `${k}: ${v}`).join('\n');
    c.get.mockImplementation((url: string) => {
      if (url.startsWith('/cluster/resources')) return ok([{ type: 'qemu', vmid: 100, node: 'pve1' }, { type: 'node', node: 'pve1', status: 'online' }]);
      if (url.startsWith('/nodes/pve1/storage/backups/content')) return ok([{ volid: 'backups:backup/x.vma.zst' }]);
      if (url.startsWith('/nodes/pve1/vzdump/extractconfig')) return ok(text);
      return get(url);
    });
    vi.mocked(prisma.mateState.findUnique).mockResolvedValue({ id: 'ms1', vmId: 'rowa', status: 'ready', volid: 'backups:backup/x.vma.zst', storage: 'backups', createdAt: new Date() } as never);
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([{ id: 'other', cpu: 7, ram: 15360, storage: 20 }] as never);
    const res = await fetch(`${base}/vms/rowa/matestates/ms1/restore`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await res.json()).details.cpu).toBeDefined();
  });
});

describe('snapshot delete on a held machine (audit round 2)', () => {
  it('is allowed (it only frees space), while creating one is not', async () => {
    const held = row({ status: 'error', holdReason: 'Over quota after a restore.' });
    vi.mocked(getVmWithCap).mockResolvedValue(held);
    fakePve(LIVE, LIVE);
    const del = await fetch(`${base}/vms/rowa/snapshots/snap1`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(pve.deleteSnapshot).toHaveBeenCalledWith('pve1', 100, 'snap1');
    const create = await fetch(`${base}/vms/rowa/snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'snap2' }),
    });
    expect(create.status).toBeGreaterThanOrEqual(400);
  });
});

describe('snapshot rollback (BUG-039)', () => {
  it('is refused when the snapshot would grow the guest past the quota spent elsewhere since', async () => {
    const { c } = fakePve(LIVE, SNAP);
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([{ id: 'other', cpu: 7, ram: 15360, storage: 20 }] as never);
    const res = await rollback();
    expect(res.status).toBe(403);
    expect(rolledBack(c)).toBe(false);
  });

  it('re-syncs cpu/ram/storage from the rolled-back guest', async () => {
    const { c } = fakePve(LIVE, SNAP);
    const res = await rollback();
    expect(res.status).toBe(200);
    expect(rolledBack(c)).toBe(true);
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: expect.objectContaining({ cpu: 8, ram: 16384, storage: 132 }),
    });
  });

  it('refuses a snapshot holding a PCI device that was detached since (audit minor)', async () => {
    const { c } = fakePve(LIVE, { ...LIVE, hostpci0: 'mapping=gpu0,pcie=1' });
    const res = await rollback();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).error).toMatch(/hostpci0/);
    expect(rolledBack(c)).toBe(false);
  });

  it('refuses a snapshot holding host-level settings or another guest’s volume, whatever the live config', async () => {
    for (const extra of [
      { args: '-drive file=/dev/sdb' },
      { usb0: 'host=1234:5678' },
      { serial0: '/dev/ttyS0' },
      { hookscript: 'local:snippets/hook.sh' },
      { virtiofs0: 'dirid=share' },
      { scsi3: 'local-lvm:vm-999-disk-0,size=5G' },
    ]) {
      const { c } = fakePve(LIVE, { ...LIVE, ...extra });
      const res = await rollback();
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await res.json()).error).toMatch(new RegExp(`may not have \\(${Object.keys(extra)[0]}\\)`));
      expect(rolledBack(c)).toBe(false);
    }
  });

  it('allows a snapshot whose PCI device is approved and attached now', async () => {
    const gpu = 'mapping=gpu0,pcie=1';
    vi.mocked(getVmWithCap).mockResolvedValue(row({ hasPassthrough: true }));
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row({ hasPassthrough: true }));
    const { c } = fakePve({ ...LIVE, hostpci0: gpu }, { ...LIVE, hostpci0: gpu });
    const res = await rollback();
    expect(res.status).toBe(200);
    expect(rolledBack(c)).toBe(true);
  });
});
