import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Deleting an account cascades its VM rows, so it must never leave guests behind:
// it is refused (nothing destroyed, account kept) while any machine's guest can't
// be deleted with it, and the account goes only once every guest is gone.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(), delete: vi.fn(async () => ({ op: 'user.delete' })) },
    inviteToken: { deleteMany: vi.fn(async () => ({ op: 'invite.deleteMany' })) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'admin', role: 'admin' };
    next();
  },
  requireSession: (_req: unknown, _res: unknown, next: () => void) => next(),
  allowExpiredAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/middleware/mfa.js', () => ({
  enforceMfaSetup: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/vm.service.js', () => ({
  destroyVm: vi.fn(async () => undefined),
  destroyBlocker: vi.fn(async () => null),
}));

import userRouter from '../src/routes/user.routes.js';
import { prisma } from '../src/lib/prisma.js';
import { destroyVm, destroyBlocker } from '../src/services/vm.service.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/users', userRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const VMS = [
  { id: 'v1', name: 'web', proxmoxVmId: 101 },
  { id: 'v2', name: 'old', proxmoxVmId: 102 },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1', vms: VMS } as never);
  vi.mocked(destroyBlocker).mockResolvedValue(null);
  vi.mocked(destroyVm).mockResolvedValue(undefined);
});

const del = () => fetch(`${base}/users/u1`, { method: 'DELETE' });

describe('DELETE /api/users/:id', () => {
  it('destroys every machine, then deletes the account', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(destroyVm).toHaveBeenCalledTimes(2);
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });

  it("revokes the account's unredeemed invites in the same transaction as the delete", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(prisma.inviteToken.deleteMany).toHaveBeenCalledWith({ where: { createdById: 'u1', usedById: null } });
    const ops = vi.mocked(prisma.$transaction).mock.calls[0]?.[0] as unknown as Array<Promise<{ op: string }>>;
    expect((await Promise.all(ops)).map((o) => o.op)).toEqual(['invite.deleteMany', 'user.delete']);
  });

  it('refuses up front, destroying nothing, when a machine\'s guest predates ownership tags', async () => {
    vi.mocked(destroyBlocker).mockImplementation(async (vm) =>
      (vm as { id: string }).id === 'v2' ? "its guest predates ProxMate's ownership tags" : null,
    );
    const res = await del();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { vms: Array<{ id: string }> };
    expect(body.vms.map((v) => v.id)).toEqual(['v2']);
    expect(destroyVm).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('keeps the account when a guest fails to destroy', async () => {
    vi.mocked(destroyVm).mockImplementation(async (vm) => {
      if ((vm as { id: string }).id === 'v1') throw new Error('VM is locked (backup)');
    });
    const res = await del();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { vms: Array<{ id: string; reason: string }> };
    expect(body.vms).toEqual([expect.objectContaining({ id: 'v1', reason: 'VM is locked (backup)' })]);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });
});
