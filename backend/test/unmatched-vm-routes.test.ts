import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Admin handling of machines whose guest carries no ProxMate tag: list them,
// adopt the guest, or remove just the row — and a tenant can do neither.

let role = 'admin';
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', role };
    next();
  },
  requireSession: (_req: unknown, _res: unknown, next: () => void) => next(),
  allowExpiredAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/middleware/mfa.js', () => ({
  enforceMfaSetup: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/services/audit.service.js', () => ({
  recordAudit: vi.fn(async () => undefined),
  listAudit: vi.fn(async () => []),
  listAuditForTarget: vi.fn(async () => []),
}));
vi.mock('../src/services/vm.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vm.service.js')>();
  const row = { id: 'rowa', userId: 'u2', name: 'web', proxmoxVmId: 100, proxmoxNode: 'pve1', status: 'running' };
  return {
    ...actual,
    getOwnedVm: vi.fn(async () => row),
    listUnmatchedVms: vi.fn(async () => [{ id: 'rowa', name: 'web' }]),
    adoptGuest: vi.fn(async () => row),
    destroyVm: vi.fn(async () => undefined),
  };
});

import adminRouter from '../src/routes/admin.routes.js';
import vmRouter from '../src/routes/vm.routes.js';
import * as vmService from '../src/services/vm.service.js';
import { recordAudit } from '../src/services/audit.service.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  app.use('/vms', vmRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  vi.clearAllMocks();
  role = 'admin';
});

const call = (method: string, path: string) => fetch(`${base}${path}`, { method });

describe('admin: unmatched machines', () => {
  it('lists them', async () => {
    const res = await call('GET', '/admin/vms/unmatched');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'rowa', name: 'web' }]);
  });

  it('adopts a guest and audits it', async () => {
    const res = await call('POST', '/admin/vms/rowa/adopt');
    expect(res.status).toBe(200);
    expect(vmService.adoptGuest).toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'vm.adopt', targetId: 'rowa' }));
  });

  it('reports a refused adoption as 409', async () => {
    vi.mocked(vmService.adoptGuest).mockRejectedValueOnce(new vmService.AdoptError('carries another tag'));
    const res = await call('POST', '/admin/vms/rowa/adopt');
    expect(res.status).toBe(409);
  });

  it('removes just the row on request, and audits that the guest was left alone', async () => {
    const res = await call('DELETE', '/vms/rowa?rowOnly=true');
    expect(res.status).toBe(200);
    expect(vmService.destroyVm).toHaveBeenCalledWith(expect.objectContaining({ id: 'rowa' }), { rowOnly: true });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'vm.delete_row', targetId: 'rowa' }));
  });
});

describe('tenants', () => {
  it('cannot remove just the row', async () => {
    role = 'user';
    const res = await call('DELETE', '/vms/rowa?rowOnly=true');
    expect(res.status).toBe(403);
    expect(vmService.destroyVm).not.toHaveBeenCalled();
  });

  it('cannot list or adopt', async () => {
    role = 'user';
    expect((await call('GET', '/admin/vms/unmatched')).status).toBe(403);
    expect((await call('POST', '/admin/vms/rowa/adopt')).status).toBe(403);
    expect(vmService.adoptGuest).not.toHaveBeenCalled();
  });

  it('a plain delete passes no row-only flag', async () => {
    role = 'user';
    await call('DELETE', '/vms/rowa');
    expect(vmService.destroyVm).toHaveBeenCalledWith(expect.anything(), { rowOnly: false });
  });
});
