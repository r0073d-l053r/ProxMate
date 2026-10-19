import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A RAM value Proxmox is certain to reject must be refused at the schema, before
// a row (and the VMID it holds) is ever written.

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
vi.mock('../src/services/vm.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vm.service.js')>();
  return {
    ...actual,
    createVm: vi.fn(),
    createContainer: vi.fn(),
    deployFromTemplate: vi.fn(),
    resolveCreateTarget: vi.fn(),
    getVmWithCap: vi.fn(async () => null),
  };
});

import vmRouter from '../src/routes/vm.routes.js';
import templateRouter from '../src/routes/template.routes.js';
import * as vmService from '../src/services/vm.service.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/vms', vmRouter);
  app.use('/templates', templateRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (path: string, body: unknown, method = 'POST') =>
  fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const ramError = async (res: Response) =>
  ((await res.json()) as { details?: { fieldErrors?: { ram?: string[] } } }).details?.fieldErrors?.ram?.[0] ?? '';

describe('RAM floor', () => {
  it('refuses a VM create below the floor without reaching the service', async () => {
    const res = await post('/vms', { name: 'x', cpu: 1, ram: 1, storage: 10, os: 'debian.iso' });
    expect(res.status).toBe(400);
    expect(await ramError(res)).toMatch(/at least 64 MB/);
    expect(vmService.createVm).not.toHaveBeenCalled();
  });

  it('refuses a container create below the floor', async () => {
    const res = await post('/vms/containers', {
      name: 'x', cpu: 1, ram: 8, storage: 4, template: 'local:vztmpl/debian-12.tar.zst',
    });
    expect(res.status).toBe(400);
    expect(await ramError(res)).toMatch(/at least 64 MB/);
    expect(vmService.createContainer).not.toHaveBeenCalled();
  });

  it('refuses a template deploy below the floor', async () => {
    const res = await post('/templates/deploy', { templateId: 't1', name: 'x', cpu: 1, ram: 16, storage: 10 });
    expect(res.status).toBe(400);
    expect(await ramError(res)).toMatch(/at least 64 MB/);
    expect(vmService.deployFromTemplate).not.toHaveBeenCalled();
  });

  it('refuses a resize below the floor', async () => {
    vi.mocked(vmService.getVmWithCap).mockResolvedValueOnce({ id: 'abc', userId: 'u1' } as never);
    const res = await post('/vms/abc', { ram: 32 }, 'PATCH');
    expect(res.status).toBe(400);
    expect(await ramError(res)).toMatch(/at least 64 MB/);
  });
});
