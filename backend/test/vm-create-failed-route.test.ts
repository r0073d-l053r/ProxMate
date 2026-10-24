import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A create that failed after answering removed its row: GET /vms/:id tells its owner
// (or an admin) why. A machine still being created can't be deleted while its
// operation runs in this process.

let actor = { id: 'u1', role: 'user', email: 'u1@example.com' };
vi.mock('../src/lib/prisma.js', () => ({ prisma: { virtualMachine: { findUnique: vi.fn() } } }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = actor;
    next();
  },
  allowExpiredAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/middleware/mfa.js', () => ({
  enforceMfaSetup: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/services/vm.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/vm.service.js')>()),
  resolveVmAccess: vi.fn(async () => null),
  getOwnedVm: vi.fn(async () => null),
}));

import vmRouter from '../src/routes/vm.routes.js';
import { prisma } from '../src/lib/prisma.js';
import { recordCreateFailure, resetCreateFailures } from '../src/lib/create-failures.js';
import { beginInFlight, resetInFlight } from '../src/lib/in-flight.js';
import { STILL_CREATING_MESSAGE } from '../src/services/vm.service.js';

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
  resetCreateFailures();
  resetInFlight();
  actor = { id: 'u1', role: 'user', email: 'u1@example.com' };
});

const get = async (id: string) => {
  const res = await fetch(`${base}/vms/${id}`);
  return { status: res.status, body: (await res.json()) as { error: string; code?: string } };
};

describe('GET /vms/:id for a create that failed', () => {
  it('tells the owner why', async () => {
    recordCreateFailure('vm1', 'u1', "storage 'local-lvm' does not exist");
    expect(await get('vm1')).toEqual({ status: 404, body: { error: "storage 'local-lvm' does not exist", code: 'create_failed' } });
  });

  it('tells an admin why', async () => {
    recordCreateFailure('vm1', 'u1', 'clone failed');
    actor = { id: 'a1', role: 'admin', email: 'a@example.com' };
    expect((await get('vm1')).body.code).toBe('create_failed');
  });

  it('gives anyone else the plain 404', async () => {
    recordCreateFailure('vm1', 'u1', 'clone failed');
    actor = { id: 'u2', role: 'user', email: 'u2@example.com' };
    expect(await get('vm1')).toEqual({ status: 404, body: { error: 'VM not found' } });
  });

  it('answers the plain 404 when nothing failed', async () => {
    expect(await get('nope')).toEqual({ status: 404, body: { error: 'VM not found' } });
  });
});

describe('DELETE /vms/:id while creating', () => {
  const del = (id: string) => fetch(`${base}/vms/${id}`, { method: 'DELETE' });

  it('answers 409 while the create is running in this process', async () => {
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue({ status: 'creating' } as never);
    const done = beginInFlight('vm1');
    const res = await del('vm1');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(STILL_CREATING_MESSAGE);
    done();
  });

  it('lets the delete through once nothing runs the create any more', async () => {
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue({ status: 'creating' } as never);
    // getOwnedVm is mocked to find nothing, so reaching the route answers 404.
    expect((await del('vm1')).status).toBe(404);
  });

  it('lets a delete through for a machine with another operation in flight that is not creating', async () => {
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue({ status: 'running' } as never);
    const done = beginInFlight('vm1');
    expect((await del('vm1')).status).toBe(404);
    done();
  });
});
