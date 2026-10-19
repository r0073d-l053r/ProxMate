import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Share creation is throttled per signed-in user, so one tenant cannot try
// address after address.

const who = vi.hoisted(() => {
  process.env['SHARE_RATE_LIMIT_MAX'] = '3';
  return { id: 'u1' };
});

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => null) },
    vmShare: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    pendingVmShare: {
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      upsert: vi.fn(async () => ({ id: 'p1', vmId: 'vm1', email: 'x@example.com', role: 'viewer', createdAt: new Date() })),
    },
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: who.id, role: 'user' };
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
  getOwnedVm: vi.fn(async () => ({ id: 'vm1', userId: who.id, name: 'web' })),
}));

import vmRouter from '../src/routes/vm.routes.js';

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

const share = (n: number) =>
  fetch(`${base}/vms/vm1/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `p${n}@example.com`, role: 'viewer' }),
  });

describe('share throttle', () => {
  it('refuses once a user exceeds the limit, without affecting another user', async () => {
    for (let i = 0; i < 3; i++) expect((await share(i)).status).toBe(202);
    expect((await share(3)).status).toBe(429);
    who.id = 'u2';
    expect((await share(4)).status).toBe(202);
  });
});
