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
vi.mock('../src/services/bulk-deploy.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/bulk-deploy.service.js')>();
  return { ...actual, startTemplateBatch: vi.fn(async () => ({ id: 'b1', items: [] })) };
});

import adminRouter from '../src/routes/admin.routes.js';
import templateRouter from '../src/routes/template.routes.js';
import vmRouter from '../src/routes/vm.routes.js';
import * as importService from '../src/services/guest-import.service.js';
import * as bulk from '../src/services/bulk-deploy.service.js';
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

describe('bulk deploy routes', () => {
  const body = { templateId: 't1', cpu: 1, ram: 1024, storage: 10, namePattern: 'web-{n}', count: 3 };

  it('starts a batch and returns 202', async () => {
    role = 'user';
    const res = await send('POST', '/templates/deploy-bulk', body);
    expect(res.status).toBe(202);
    expect(bulk.startTemplateBatch).toHaveBeenCalled();
  });

  it('refuses a tenant deploying into other users’ accounts', async () => {
    role = 'user';
    const res = await send('POST', '/templates/deploy-bulk', { ...body, count: undefined, forUserIds: ['u2'] });
    expect(res.status).toBe(403);
    expect(bulk.startTemplateBatch).not.toHaveBeenCalled();
  });

  it('refuses more copies than the cap', async () => {
    role = 'user';
    expect((await send('POST', '/templates/deploy-bulk', { ...body, count: 21 })).status).toBe(400);
    role = 'admin';
    expect((await send('POST', '/templates/deploy-bulk', { ...body, count: 51 })).status).toBe(400);
    expect(bulk.startTemplateBatch).not.toHaveBeenCalled();
  });

  it('hides a batch from anyone but its starter and admins', async () => {
    expect((await send('GET', '/templates/deploy-bulk/nope')).status).toBe(404);
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
