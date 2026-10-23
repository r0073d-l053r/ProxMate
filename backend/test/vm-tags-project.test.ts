import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// PATCH /api/vms/:id `tags` edits the plain labels. The VM's project tag is set
// only through /api/projects/assign, so a label edit — including one by a
// manager-level sharee — keeps the project the owner chose.

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u2', role: 'user' };
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
const ROW = { id: 'vm1', userId: 'u1', name: 'web', tags: 'prod,project:shop', adminManaged: false, quotaExempt: false };
vi.mock('../src/services/vm.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vm.service.js')>();
  return {
    ...actual,
    getVmWithCap: vi.fn(async () => ({ ...ROW })),
    updateVm: vi.fn(async (vm: object, data: object) => ({ ...vm, ...data })),
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
beforeEach(() => vi.clearAllMocks());

const patch = (body: unknown) =>
  fetch(`${base}/vms/vm1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('PATCH /api/vms/:id tags', () => {
  it('keeps the project tag when the labels change', async () => {
    const res = await patch({ tags: ['web', 'Staging'] });
    expect(res.status).toBe(200);
    expect(vmService.updateVm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vm1' }),
      expect.objectContaining({ tags: 'web,staging,project:shop' }),
    );
  });

  it('keeps the project tag when every label is cleared', async () => {
    await patch({ tags: [] });
    expect(vmService.updateVm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tags: 'project:shop' }));
  });

  it('refuses a project tag in the label list', async () => {
    const res = await patch({ tags: ['project:other'] });
    expect(res.status).toBe(400);
    expect(vmService.updateVm).not.toHaveBeenCalled();
  });
});
