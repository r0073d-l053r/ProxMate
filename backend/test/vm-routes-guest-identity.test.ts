import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Route-level guest-identity gates: when a row's VMID does not hold the guest
// ProxMate created for it, write routes refuse without calling Proxmox, and
// read routes show nothing rather than the other guest's data.

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
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
vi.mock('../src/services/live-stats.service.js', () => ({
  getLiveStats: vi.fn(async () => ({
    100: { status: 'running', cpu: 0.9, maxcpu: 8, mem: 7, maxmem: 8, uptime: 99, tags: 'proxmate-someoneelse' },
  })),
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    setVmName: vi.fn(),
    listSnapshots: vi.fn(async () => [{ name: 'theirs' }]),
    createSnapshot: vi.fn(),
    rollbackSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
    getVmRrdData: vi.fn(async () => [{ cpu: 1 }]),
    getVmConfig: vi.fn(async () => ({ hostpci0: 'mapping=gpu' })),
  };
});
vi.mock('../src/services/vm.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vm.service.js')>();
  const row = { id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1', status: 'running', cpu: 1 };
  return {
    ...actual,
    getVmWithCap: vi.fn(async () => row),
    getViewableVm: vi.fn(async () => row),
    requireOurGuest: vi.fn(async () => {
      throw new actual.GuestIdentityError('foreign');
    }),
    ourGuestOrNull: vi.fn(async () => null),
  };
});

import vmRouter from '../src/routes/vm.routes.js';
import * as pve from '../src/services/proxmox.service.js';

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
beforeEach(() => vi.clearAllMocks());

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('write routes refuse a foreign guest without touching Proxmox', () => {
  it('rename', async () => {
    const res = await call('PATCH', '/vms/rowa', { name: 'renamed' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(pve.setVmName).not.toHaveBeenCalled();
  });

  it('snapshot create', async () => {
    const res = await call('POST', '/vms/rowa/snapshots', { name: 'snap1' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(pve.createSnapshot).not.toHaveBeenCalled();
  });

  it('snapshot rollback', async () => {
    const res = await call('POST', '/vms/rowa/snapshots/snap1/rollback');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(pve.rollbackSnapshot).not.toHaveBeenCalled();
  });

  it('snapshot delete', async () => {
    const res = await call('DELETE', '/vms/rowa/snapshots/snap1');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(pve.deleteSnapshot).not.toHaveBeenCalled();
  });
});

describe('read routes show nothing of a foreign guest', () => {
  it('metrics', async () => {
    const res = await call('GET', '/vms/rowa/metrics');
    expect(await res.json()).toEqual({ timeframe: 'hour', points: [] });
    expect(pve.getVmRrdData).not.toHaveBeenCalled();
  });

  it('passthrough devices', async () => {
    const res = await call('GET', '/vms/rowa/passthrough');
    expect(await res.json()).toEqual({ devices: [] });
  });

  it('snapshots', async () => {
    const res = await call('GET', '/vms/rowa/snapshots');
    expect(await res.json()).toEqual([]);
    expect(pve.listSnapshots).not.toHaveBeenCalled();
  });

  it('live stats', async () => {
    const res = await call('GET', '/vms/rowa/live-stats');
    expect(await res.json()).toEqual({ status: 'running', cpu: 0, maxcpu: 1, mem: 0, maxmem: 0 });
  });
});
