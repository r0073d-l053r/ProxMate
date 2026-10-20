import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The per-VM lock (IDE installing, cloud-init deploying) applies to bulk actions
// and to migration exactly as it does to the single-VM power and delete routes.

let role = 'user';
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', role };
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
const ROWS: Record<string, Record<string, unknown>> = {
  ready: { id: 'ready', userId: 'u1', name: 'a', proxmoxVmId: 100, proxmoxNode: 'pve1', ideState: null, deployState: 'ready' },
  ready2: { id: 'ready2', userId: 'u1', name: 'a2', proxmoxVmId: 103, proxmoxNode: 'pve1', ideState: null, deployState: 'ready' },
  deploying: { id: 'deploying', userId: 'u1', name: 'b', proxmoxVmId: 101, proxmoxNode: 'pve1', ideState: null, deployState: 'deploying' },
  ide: { id: 'ide', userId: 'u1', name: 'c', proxmoxVmId: 102, proxmoxNode: 'pve1', ideState: 'installing', deployState: null },
};
vi.mock('../src/services/vm.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vm.service.js')>();
  return {
    ...actual,
    getOwnedVm: vi.fn(async (id: string) => ROWS[id] ?? null),
    startVm: vi.fn(async () => undefined),
    stopVm: vi.fn(async () => undefined),
    restartVm: vi.fn(async () => undefined),
    destroyVm: vi.fn(async () => undefined),
    migrateVmToNode: vi.fn(async () => ({ proxmoxNode: 'pve2' })),
  };
});

import vmRouter from '../src/routes/vm.routes.js';
import * as vmService from '../src/services/vm.service.js';

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
  role = 'user';
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/vms/bulk', () => {
  it('skips locked VMs for delete, reporting them as failures, and acts on the rest', async () => {
    const res = await post('/vms/bulk', { action: 'delete', ids: ['ready', 'deploying', 'ide'] });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: Array<{ id: string; ok: boolean; error?: string }> };
    expect(results.map((r) => [r.id, r.ok])).toEqual([
      ['ready', true],
      ['deploying', false],
      ['ide', false],
    ]);
    expect(results[1]!.error).toMatch(/cloud-init/);
    expect(results[2]!.error).toMatch(/IDE/);
    expect(vmService.destroyVm).toHaveBeenCalledTimes(1);
    expect(vmService.destroyVm).toHaveBeenCalledWith(expect.objectContaining({ id: 'ready' }));
  });

  it('applies the lock to stop and restart as well', async () => {
    await post('/vms/bulk', { action: 'stop', ids: ['deploying'] });
    await post('/vms/bulk', { action: 'restart', ids: ['ide'] });
    expect(vmService.stopVm).not.toHaveBeenCalled();
    expect(vmService.restartVm).not.toHaveBeenCalled();
  });

  it('stops several VMs side by side so the request is not the sum of every shutdown', async () => {
    // A stop waits for the guest to go down; one after another, a few slow guests
    // would outlast a reverse proxy's request timeout.
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(vmService.stopVm).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
    });
    const res = await post('/vms/bulk', { action: 'stop', ids: ['ready', 'ready2', 'deploying'] });
    const { results } = (await res.json()) as { results: Array<{ id: string; ok: boolean }> };
    expect(results.map((r) => [r.id, r.ok])).toEqual([
      ['ready', true],
      ['ready2', true],
      ['deploying', false],
    ]);
    expect(vmService.stopVm).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(2);
  });

  it('restarts several VMs side by side too', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(vmService.restartVm).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
    });
    await post('/vms/bulk', { action: 'restart', ids: ['ready', 'ready2'] });
    expect(maxInFlight).toBe(2);
  });

  it('still starts a locked VM, as the single-VM start route does', async () => {
    await post('/vms/bulk', { action: 'start', ids: ['deploying'] });
    expect(vmService.startVm).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/vms/:id/migrate', () => {
  it('refuses while the VM is locked', async () => {
    role = 'admin';
    const res = await post('/vms/deploying/migrate', { targetNode: 'pve2' });
    expect(res.status).toBe(409);
    expect(vmService.migrateVmToNode).not.toHaveBeenCalled();
  });
});
