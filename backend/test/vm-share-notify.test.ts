import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Sharing a VM with an existing account emails the recipient; changing their level
// emails them again. A share to an address with no account sends nothing, and the
// answer to the request is the same either way — the email goes out only after the
// response, so neither its content nor its timing depends on whether an account exists.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    vmShare: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      upsert: vi.fn(async (a: { create: { role: string } }) => ({
        id: 's1',
        role: a.create.role,
        createdAt: new Date(),
        user: { email: 'exists@example.com' },
      })),
    },
    pendingVmShare: {
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      upsert: vi.fn(async () => ({ id: 'p1', vmId: 'vm1', email: 'nobody@example.com', role: 'viewer', createdAt: new Date() })),
      delete: vi.fn(async () => ({})),
    },
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', role: 'user', email: 'owner@example.com', displayName: 'Owen Owner' };
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
  getOwnedVm: vi.fn(async () => ({ id: 'vm1', userId: 'u1', name: 'web' })),
}));

import vmRouter from '../src/routes/vm.routes.js';
import { prisma } from '../src/lib/prisma.js';
import { getMailConfig, sendMail } from '../src/services/mail.service.js';
import { resetShareNoticeWindow } from '../src/services/activity-mail.service.js';

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
  resetShareNoticeWindow();
  vi.mocked(getMailConfig).mockResolvedValue({ host: 'smtp' } as never);
});

const share = (email: string, role = 'viewer') =>
  fetch(`${base}/vms/vm1/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, role }),
  });

/** Let deferred (setImmediate) work and the promises it starts finish. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const existing = { id: 'u2', email: 'exists@example.com', displayName: 'Exists', activityEmailOptOut: false };

describe('share notifications', () => {
  it('sends at most one email per recipient and VM in 24 h — later level flips are folded', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(existing as never);
    await share('exists@example.com', 'viewer');
    await settle();
    vi.mocked(prisma.vmShare.findFirst).mockResolvedValue({ id: 's1', role: 'viewer' } as never);
    for (const role of ['manager', 'viewer', 'operator']) {
      vi.mocked(prisma.vmShare.findFirst).mockResolvedValue({ id: 's1', role: role === 'manager' ? 'viewer' : 'manager' } as never);
      expect((await share('exists@example.com', role)).status).toBe(202);
    }
    await settle();
    expect(sendMail).toHaveBeenCalledTimes(1);
    vi.mocked(prisma.vmShare.findFirst).mockResolvedValue(null);
  });

  it('emails an existing account when a VM is shared with it', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(existing as never);
    const res = await share('exists@example.com', 'operator');
    expect(res.status).toBe(202);
    await settle();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMail).mock.calls[0]![0]).toMatchObject({
      to: 'exists@example.com',
      subject: '[ProxMate] "web" was shared with you',
    });
    expect(vi.mocked(sendMail).mock.calls[0]![0].text).toContain(
      'Owen Owner (owner@example.com) shared "web" with you as Operator.',
    );
  });

  it('emails a level change, and not a re-save at the same level', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.vmShare.findFirst).mockResolvedValue({ id: 's1', role: 'viewer' } as never);
    await share('exists@example.com', 'manager');
    await settle();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMail).mock.calls[0]![0].text).toContain('from Viewer to Manager');

    vi.mocked(sendMail).mockClear();
    vi.mocked(prisma.vmShare.findFirst).mockResolvedValue({ id: 's1', role: 'manager' } as never);
    await share('exists@example.com', 'manager');
    await settle();
    expect(sendMail).not.toHaveBeenCalled();
    vi.mocked(prisma.vmShare.findFirst).mockResolvedValue(null);
  });

  it('sends no email for a pending share, and answers exactly as for an existing account', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(existing as never);
    const hit = await share('exists@example.com');
    await settle();
    expect(sendMail).toHaveBeenCalledTimes(1);

    vi.mocked(sendMail).mockClear();
    vi.mocked(getMailConfig).mockClear();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const miss = await share('nobody@example.com');
    await settle();

    expect(miss.status).toBe(hit.status);
    expect(await miss.json()).toEqual(await hit.json());
    expect([...miss.headers.keys()].sort()).toEqual([...hit.headers.keys()].sort());
    expect(prisma.pendingVmShare.upsert).toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    // The mail path isn't even entered for a pending share.
    expect(getMailConfig).not.toHaveBeenCalled();
  });

  it('answers before any mail work happens, so a slow mail server cannot delay or change the response', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(existing as never);
    // A mail server that never answers.
    vi.mocked(getMailConfig).mockImplementation(() => new Promise(() => undefined));
    const res = await share('exists@example.com');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      message: 'Shared. Someone without a ProxMate account yet gets access once they register with that address through an invite sent to it.',
    });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('a failing send never surfaces in the response', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(existing as never);
    vi.mocked(sendMail).mockRejectedValueOnce(new Error('550 mailbox unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await share('exists@example.com');
    expect(res.status).toBe(202);
    await settle();
    expect(warn).toHaveBeenCalledWith('[activity-mail] share email failed:', expect.any(Error));
    warn.mockRestore();
  });
});
