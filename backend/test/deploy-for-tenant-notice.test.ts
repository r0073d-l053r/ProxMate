import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// An admin creating a VM in a tenant's account emails that tenant (after the
// response). Creating one for yourself sends nothing.

vi.mock('../src/lib/prisma.js', () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'admin', role: 'admin', email: 'admin@example.com', displayName: 'Ada Admin' };
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
vi.mock('../src/services/config.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/config.service.js')>()),
  getConfig: vi.fn(async () => null),
}));
vi.mock('../src/services/mail.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/mail.service.js')>()),
  getMailConfig: vi.fn(async () => ({ host: 'smtp' })),
  sendMail: vi.fn(async () => undefined),
}));
vi.mock('../src/services/vm.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/vm.service.js')>()),
  resolveCreateTarget: vi.fn(),
  createVm: vi.fn(),
  createContainer: vi.fn(),
}));

import vmRouter from '../src/routes/vm.routes.js';
import { prisma } from '../src/lib/prisma.js';
import { sendMail } from '../src/services/mail.service.js';
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

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const row = (userId: string, type = 'qemu') => ({
  id: 'vm1', userId, name: 'lab-01', type, cpu: 2, ram: 2048, storage: 20, quotaExempt: false,
  proxmoxVmId: 101, proxmoxNode: 'pve1', status: 'running', adminManaged: userId !== 'admin',
});

const post = (path: string, body: unknown) =>
  fetch(`${base}/vms${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const vmBody = { name: 'lab-01', cpu: 2, ram: 2048, storage: 20, os: 'debian.iso' };

describe('deploy for a tenant', () => {
  it('emails the tenant when an admin creates a VM in their account', async () => {
    vi.mocked(vmService.resolveCreateTarget).mockResolvedValue({ id: 'tenant' } as never);
    vi.mocked(vmService.createVm).mockResolvedValue(row('tenant') as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ email: 't@example.com', displayName: 'Tess', activityEmailOptOut: false } as never);

    expect((await post('', { ...vmBody, forUserId: 'tenant' })).status).toBe(201);
    await settle();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMail).mock.calls[0]![0]).toMatchObject({ to: 't@example.com' });
    expect(vi.mocked(sendMail).mock.calls[0]![0].text).toContain('Ada Admin (an admin) set up a new virtual machine, "lab-01"');
  });

  it('emails for a container too', async () => {
    vi.mocked(vmService.resolveCreateTarget).mockResolvedValue({ id: 'tenant' } as never);
    vi.mocked(vmService.createContainer).mockResolvedValue(row('tenant', 'lxc') as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ email: 't@example.com', displayName: 'Tess', activityEmailOptOut: false } as never);

    const res = await post('/containers', { name: 'ct-01', cpu: 1, ram: 512, storage: 8, template: 'local:vztmpl/debian.tar.zst', password: 'longenough1', forUserId: 'tenant' });
    expect(res.status).toBe(201);
    await settle();
    expect(vi.mocked(sendMail).mock.calls[0]![0].subject).toContain('container');
  });

  it('sends nothing when an admin creates a VM for themselves', async () => {
    vi.mocked(vmService.resolveCreateTarget).mockResolvedValue({ id: 'admin' } as never);
    vi.mocked(vmService.createVm).mockResolvedValue(row('admin') as never);
    expect((await post('', vmBody)).status).toBe(201);
    await settle();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('respects the tenant opting out of activity emails', async () => {
    vi.mocked(vmService.resolveCreateTarget).mockResolvedValue({ id: 'tenant' } as never);
    vi.mocked(vmService.createVm).mockResolvedValue(row('tenant') as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ email: 't@example.com', displayName: 'Tess', activityEmailOptOut: true } as never);
    expect((await post('', { ...vmBody, forUserId: 'tenant' })).status).toBe(201);
    await settle();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
