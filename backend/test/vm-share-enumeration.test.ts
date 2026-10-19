import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Sharing a VM by email answers the same way whether or not an account exists for
// that address, so the endpoint can't be used to find out who has an account.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    vmShare: {
      findMany: vi.fn(async () => [
        {
          id: 's1',
          role: 'operator',
          createdAt: new Date('2026-10-01T00:00:00Z'),
          user: { id: 'u2', email: 'exists@example.com', displayName: 'Exists Person' },
        },
      ]),
      upsert: vi.fn(async () => ({
        id: 's1',
        role: 'viewer',
        createdAt: new Date(),
        user: { id: 'u2', email: 'exists@example.com', displayName: 'Exists' },
      })),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 1),
    },
    pendingVmShare: {
      findMany: vi.fn(async () => [
        { id: 'p1', vmId: 'vm1', email: 'later@example.com', role: 'viewer', createdAt: new Date('2026-10-02T00:00:00Z') },
      ]),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 1),
      upsert: vi.fn(async () => ({ id: 'p2', vmId: 'vm1', email: 'nobody@example.com', role: 'viewer', createdAt: new Date() })),
      delete: vi.fn(async () => ({})),
    },
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
vi.mock('../src/services/vm.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/vm.service.js')>()),
  getOwnedVm: vi.fn(async () => ({ id: 'vm1', userId: 'u1', name: 'web' })),
}));

import vmRouter from '../src/routes/vm.routes.js';
import { prisma } from '../src/lib/prisma.js';
import { recordAudit } from '../src/services/audit.service.js';

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

const share = (email: string) =>
  fetch(`${base}/vms/vm1/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, role: 'viewer' }),
  });

describe('POST /api/vms/:id/shares', () => {
  it('answers identically for an existing and an unknown address', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u2', email: 'exists@example.com' } as never);
    const hit = await share('exists@example.com');
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    const miss = await share('nobody@example.com');

    expect(hit.status).toBe(miss.status);
    expect(await hit.json()).toEqual(await miss.json());
    expect(prisma.vmShare.upsert).toHaveBeenCalledTimes(1);
    // The unknown address is kept as a pending share rather than dropped.
    expect(prisma.pendingVmShare.upsert).toHaveBeenCalledTimes(1);
  });

  it('records the same audit detail either way (the VM activity feed is tenant-visible)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    await share('nobody@example.com');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'vm.share', detail: 'nobody@example.com as viewer' }));
  });
});

describe('GET /api/vms/:id/shares', () => {
  it('lists each share by the address and access level only — no account id, display name or pending flag', async () => {
    const res = await fetch(`${base}/vms/vm1/shares`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: 's1', email: 'exists@example.com', role: 'operator', createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'p1', email: 'later@example.com', role: 'viewer', createdAt: '2026-10-02T00:00:00.000Z' },
    ]);
  });
});
