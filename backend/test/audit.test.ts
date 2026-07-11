import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    auditLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import { recordAudit, listAudit, listAuditForTarget } from '../src/services/audit.service.js';

const create = vi.mocked(prisma.auditLog.create);
const findMany = vi.mocked(prisma.auditLog.findMany);
const count = vi.mocked(prisma.auditLog.count);
const userFindMany = vi.mocked(prisma.user.findMany);

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({} as never);
  userFindMany.mockResolvedValue([] as never);
});

describe('recordAudit', () => {
  it('writes an entry with actor, target, detail, and client IP', async () => {
    await recordAudit({
      action: 'vm.create',
      actor: { id: 'u1', email: 'a@b.c' },
      targetType: 'vm',
      targetId: 'vm1',
      detail: 'web',
      req: { ip: '203.0.113.5' } as never,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].data).toMatchObject({
      userId: 'u1',
      actorEmail: 'a@b.c',
      action: 'vm.create',
      targetType: 'vm',
      targetId: 'vm1',
      detail: 'web',
      ip: '203.0.113.5',
    });
  });

  it('prefers the real-client header (CF-Connecting-IP) over the proxy socket req.ip', async () => {
    // Behind Cloudflare Tunnel, req.ip is the tunnel for every request — the real
    // client is in CF-Connecting-IP. Without this, the audit log shows one IP for all.
    await recordAudit({
      action: 'auth.login',
      actor: { id: 'u1' },
      req: { ip: '127.0.0.1', headers: { 'cf-connecting-ip': '198.51.100.9' } } as never,
    });
    expect(create.mock.calls[0]![0].data.ip).toBe('198.51.100.9');
  });

  it('takes the first hop of a comma-listed forwarded header', async () => {
    await recordAudit({
      action: 'auth.login',
      actor: { id: 'u1' },
      req: { ip: '127.0.0.1', headers: { 'cf-connecting-ip': '198.51.100.9, 10.0.0.1' } } as never,
    });
    expect(create.mock.calls[0]![0].data.ip).toBe('198.51.100.9');
  });

  it('falls back to req.ip when no real-client header is present', async () => {
    await recordAudit({
      action: 'auth.login',
      actor: { id: 'u1' },
      req: { ip: '203.0.113.5', headers: {} } as never,
    });
    expect(create.mock.calls[0]![0].data.ip).toBe('203.0.113.5');
  });

  it('records anonymous actions with null actor (e.g. failed login)', async () => {
    await recordAudit({ action: 'auth.login_failed', targetType: 'email', targetId: 'x@y.z' });
    const data = create.mock.calls[0]![0].data;
    expect(data.userId).toBeNull();
    expect(data.actorEmail).toBeNull();
    expect(data.action).toBe('auth.login_failed');
    expect(data.ip).toBeNull();
  });

  it('never throws when the DB write fails (best-effort, must not break the action)', async () => {
    create.mockRejectedValue(new Error('db down'));
    await expect(recordAudit({ action: 'vm.delete', actor: { id: 'u1' } })).resolves.toBeUndefined();
  });
});

describe('listAudit', () => {
  it('clamps limit to [1,500] and offset to >=0, newest first', async () => {
    findMany.mockResolvedValue([{ id: 'a1' }] as never);
    count.mockResolvedValue(1 as never);
    const r = await listAudit({ limit: 9999, offset: -5 });
    expect(r.limit).toBe(500);
    expect(r.offset).toBe(0);
    expect(findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' }, take: 500, skip: 0 });
    expect(r.total).toBe(1);
    expect(r.items).toHaveLength(1);
  });

  it('defaults to the 100 newest entries', async () => {
    findMany.mockResolvedValue([] as never);
    count.mockResolvedValue(0 as never);
    const r = await listAudit();
    expect(r.limit).toBe(100);
    expect(findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' }, take: 100, skip: 0 });
  });
});

describe('listAuditForTarget (per-VM activity feed)', () => {
  it('filters by targetType + targetId, newest first, default 20', async () => {
    findMany.mockResolvedValue([{ id: 'a1' }] as never);
    const items = await listAuditForTarget('vm', 'vm1');
    expect(findMany).toHaveBeenCalledWith({
      where: { targetType: 'vm', targetId: 'vm1' },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    expect(items).toHaveLength(1);
  });

  it('clamps the limit to [1,100]', async () => {
    findMany.mockResolvedValue([] as never);
    await listAuditForTarget('vm', 'vm1', 9999);
    expect(findMany.mock.calls[0]![0].take).toBe(100);
  });
});

describe('listAuditForTarget — admin actions hidden from tenant feeds (owner decision 2026-07-11)', () => {
  it('excludes rows by admins OTHER than the VM owner, keeping system (null-actor) rows', async () => {
    userFindMany.mockResolvedValue([{ id: 'admin1' }, { id: 'admin2' }] as never);
    findMany.mockResolvedValue([] as never);
    await listAuditForTarget('vm', 'vm1', 20, { hideActionsByAdminsExcept: 'owner1' });
    expect(userFindMany).toHaveBeenCalledWith({ where: { role: 'admin' }, select: { id: true } });
    expect(findMany.mock.calls[0]![0].where).toEqual({
      targetType: 'vm',
      targetId: 'vm1',
      OR: [{ userId: null }, { userId: { notIn: ['admin1', 'admin2'] } }],
    });
  });

  it("an admin who IS the VM's owner keeps their own actions visible", async () => {
    userFindMany.mockResolvedValue([{ id: 'admin1' }, { id: 'admin2' }] as never);
    findMany.mockResolvedValue([] as never);
    await listAuditForTarget('vm', 'vm1', 20, { hideActionsByAdminsExcept: 'admin1' });
    expect(findMany.mock.calls[0]![0].where).toEqual({
      targetType: 'vm',
      targetId: 'vm1',
      OR: [{ userId: null }, { userId: { notIn: ['admin2'] } }],
    });
  });

  it('adds no clause when there is nothing to hide (sole admin owns the VM)', async () => {
    userFindMany.mockResolvedValue([{ id: 'admin1' }] as never);
    findMany.mockResolvedValue([] as never);
    await listAuditForTarget('vm', 'vm1', 20, { hideActionsByAdminsExcept: 'admin1' });
    expect(findMany.mock.calls[0]![0].where).toEqual({ targetType: 'vm', targetId: 'vm1' });
  });

  it('without the option, no user lookup happens (admin/unfiltered path)', async () => {
    findMany.mockResolvedValue([] as never);
    await listAuditForTarget('vm', 'vm1', 20);
    expect(userFindMany).not.toHaveBeenCalled();
  });
});
