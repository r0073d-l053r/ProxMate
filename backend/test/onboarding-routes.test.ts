import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Routes for importing guests (admin only) and bulk template deploys (tenants for
// themselves within the caps; admins for others too).

let role = 'admin';
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, email: `${where.id}@example.com` })) },
    template: { findUnique: vi.fn(async () => ({ id: 't1', name: 'Debian', published: true, cloudInit: false })) },
    virtualMachine: { findUnique: vi.fn(async () => ({ id: 'queued', status: 'creating' })) },
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', role, email: 'u1@example.com' };
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
vi.mock('../src/services/guest-import.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/guest-import.service.js')>();
  return {
    ...actual,
    listImportableGuests: vi.fn(async () => [{ vmid: 200, node: 'pve1', name: 'legacy', type: 'qemu' }]),
    importGuest: vi.fn(async () => ({ id: 'row1' })),
  };
});

import adminRouter from '../src/routes/admin.routes.js';
import templateRouter from '../src/routes/template.routes.js';
import vmRouter from '../src/routes/vm.routes.js';
import * as importService from '../src/services/guest-import.service.js';
import { QuotaError } from '../src/services/vm.service.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  app.use('/templates', templateRouter);
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

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('guest import routes', () => {
  it('lists importable guests and imports one for an owner', async () => {
    expect(await (await send('GET', '/admin/guests/importable')).json()).toEqual([
      { vmid: 200, node: 'pve1', name: 'legacy', type: 'qemu' },
    ]);
    const res = await send('POST', '/admin/guests/import', { vmid: 200, ownerId: 'u2', quotaExempt: true });
    expect(res.status).toBe(201);
    expect(importService.importGuest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      expect.objectContaining({ vmid: 200, quotaExempt: true, owner: expect.objectContaining({ id: 'u2' }) }),
    );
  });

  it('says plainly when the import would exceed the owner’s quota', async () => {
    vi.mocked(importService.importGuest).mockRejectedValueOnce(new QuotaError({ cpu: { used: 7, requested: 2, max: 8 } }));
    const res = await send('POST', '/admin/guests/import', { vmid: 200, ownerId: 'u2' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/would exceed u2@example.com's quota \(cpu\)/);
  });

  it('reports a refused import as 409', async () => {
    vi.mocked(importService.importGuest).mockRejectedValueOnce(new importService.ImportError('carries a ProxMate tag'));
    const res = await send('POST', '/admin/guests/import', { vmid: 200, ownerId: 'u2' });
    expect(res.status).toBe(409);
  });

  it('is admin-only', async () => {
    role = 'user';
    expect((await send('GET', '/admin/guests/importable')).status).toBe(403);
    expect((await send('POST', '/admin/guests/import', { vmid: 200, ownerId: 'u1' })).status).toBe(403);
    expect(importService.importGuest).not.toHaveBeenCalled();
  });
});

describe('a machine still being created', () => {
  it('answers 409 to anything but viewing or deleting it', async () => {
    role = 'user';
    for (const path of ['/vms/queued/rebuild', '/vms/queued/start', '/vms/queued/snapshots/s1/rollback']) {
      const res = await send('POST', path, {});
      expect(res.status, path).toBe(409);
      expect((await res.json()).error).toMatch(/still being created/);
    }
  });
});
