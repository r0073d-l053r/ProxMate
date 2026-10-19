import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An invite's `email` is what registration binds the account to, so it may only
 * name an address the current link was actually delivered to. Sending the invite
 * to a new address issues a new link (the old one stops working), and a failed
 * send binds nothing.
 */

type Invite = Record<string, unknown> & { id: string; token: string; email: string | null; usedById: string | null };
const store = vi.hoisted(() => ({ invites: [] as Invite[], users: [] as Array<Record<string, unknown>>, seq: 0 }));

vi.mock('../src/lib/prisma.js', () => {
  const match = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  return {
    prisma: {
      inviteToken: {
        findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => store.invites.find((i) => match(i, where)) ?? null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `inv${++store.seq}`, usedById: null, ...data } as Invite;
          store.invites.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const row = store.invites.find((i) => match(i, where))!;
          Object.assign(row, data);
          return row;
        }),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const rows = store.invites.filter((i) => match(i, where));
          rows.forEach((r) => Object.assign(r, data));
          return { count: rows.length };
        }),
      },
      user: {
        findUnique: vi.fn(async ({ where }: { where: { email?: string } }) => store.users.find((u) => u.email === where.email) ?? null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `u${++store.seq}`, role: 'user', ...data };
          store.users.push(row);
          return row;
        }),
        delete: vi.fn(),
      },
    },
  };
});
vi.mock('../src/middleware/auth.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'admin1', email: 'admin@x.y', role: 'admin', displayName: 'Admin' };
      next();
    },
    requireSession: pass,
    allowExpiredAccess: pass,
  };
});
const sent = vi.hoisted(() => ({ mails: [] as Array<{ to: string; html?: string; text?: string }>, fail: false }));
vi.mock('../src/services/mail.service.js', () => ({
  isMailConfigured: vi.fn(async () => true),
  sendMail: vi.fn(async (m: { to: string; html?: string; text?: string }) => {
    if (sent.fail) throw new Error('SMTP down');
    sent.mails.push(m);
  }),
}));
vi.mock('../src/services/auth.service.js', () => ({
  hashPassword: vi.fn(async () => 'hash'),
  verifyPasswordSafe: vi.fn(),
  createSession: vi.fn(async () => ({ token: 'jwt', csrfToken: 'csrf', expiresAt: new Date(Date.now() + 86_400_000) })),
  retireSessionWithGrace: vi.fn(),
  signChallenge: vi.fn(),
  verifyChallenge: vi.fn(),
  signEnrollment: vi.fn(),
  verifyEnrollment: vi.fn(),
  verifySession: vi.fn(),
}));
vi.mock('../src/services/twofactor.service.js', () => ({}));
vi.mock('../src/services/passkey.service.js', () => ({}));
vi.mock('../src/services/sso.service.js', () => ({}));
vi.mock('../src/services/mfa.service.js', () => ({ isMfaSetupRequired: vi.fn(async () => false) }));
vi.mock('../src/services/kiosk.service.js', () => ({}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/account-lockout.service.js', () => ({}));
vi.mock('../src/services/password-reset.service.js', () => ({}));
vi.mock('../src/middleware/rate-limit.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { authLimiter: pass, publicTokenLimiter: pass, kioskExitLimiter: pass };
});

import authRoutes from '../src/routes/auth.routes.js';
import inviteRoutes from '../src/routes/invite.routes.js';

let server: http.Server | undefined;
let base = '';

function seedInvite(email: string | null): Invite {
  const row: Invite = {
    id: `inv${++store.seq}`,
    token: 'old-token',
    createdById: 'admin1',
    label: null,
    email,
    maxCpu: 2,
    maxRam: 2048,
    maxStorage: 20,
    require2fa: false,
    accessDuration: null,
    usedById: null,
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  store.invites.push(row);
  return row;
}

beforeEach(async () => {
  store.invites = [];
  store.users = [];
  sent.mails = [];
  sent.fail = false;
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/invites', inviteRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const register = (inviteToken: string, email: string) =>
  post('/auth/register', { email, password: 'longenough', displayName: 'Someone', inviteToken });

describe('sending an invite to an address', () => {
  it('issues a new link when the address changes, so the old link cannot claim that address', async () => {
    const inv = seedInvite(null);
    const res = await post(`/invites/${inv.id}/send`, { email: 'alice@corp.example' });
    expect((await res.json()).ok).toBe(true);

    expect(inv.email).toBe('alice@corp.example');
    expect(inv.token).not.toBe('old-token');
    expect(sent.mails[0]!.html ?? sent.mails[0]!.text).toContain(inv.token);
    expect(JSON.stringify(sent.mails[0])).not.toContain('old-token');

    const stale = await register('old-token', 'alice@corp.example');
    expect(stale.status).toBe(400);
    expect(store.users).toHaveLength(0);

    const fresh = await register(inv.token, 'alice@corp.example');
    expect(fresh.status).toBe(201);
    expect(store.users[0]).toMatchObject({ email: 'alice@corp.example', emailBound: true });
  });

  it('also rotates when re-addressing an invite that was already sent elsewhere', async () => {
    const inv = seedInvite('bob@corp.example');
    await post(`/invites/${inv.id}/send`, { email: 'alice@corp.example' });
    expect(inv.token).not.toBe('old-token');
    expect(inv.email).toBe('alice@corp.example');
  });

  it('keeps the link when resending to the same address', async () => {
    const inv = seedInvite('alice@corp.example');
    await post(`/invites/${inv.id}/send`, { email: 'Alice@corp.example' });
    expect(inv.token).toBe('old-token');
    expect(JSON.stringify(sent.mails[0])).toContain('old-token');
  });

  it('reports a neutral error when the invite changed while the mail was going out', async () => {
    const inv = seedInvite(null);
    const { sendMail } = await import('../src/services/mail.service.js');
    vi.mocked(sendMail).mockImplementationOnce(async () => {
      inv.usedById = 'someone';
    });
    const body = await (await post(`/invites/${inv.id}/send`, { email: 'alice@corp.example' })).json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('The invite changed while sending — the emailed link will not work; reload and try again.');
    expect(inv.email).toBeNull();
    expect(inv.token).toBe('old-token');
  });

  it('changes nothing when the send fails', async () => {
    const inv = seedInvite(null);
    sent.fail = true;
    const res = await post(`/invites/${inv.id}/send`, { email: 'alice@corp.example' });
    expect((await res.json()).ok).toBe(false);
    expect(inv.token).toBe('old-token');
    expect(inv.email).toBeNull();
  });

  it('binds no address to a new invite whose email could not be sent', async () => {
    sent.fail = true;
    const res = await post('/invites', { maxCpu: 1, maxRam: 512, maxStorage: 10, email: 'alice@corp.example' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.emailed).toBe(false);
    expect(store.invites[0]!.email).toBeNull();
  });

  it('binds the address once a new invite has been emailed', async () => {
    const res = await post('/invites', { maxCpu: 1, maxRam: 512, maxStorage: 10, email: 'alice@corp.example' });
    const body = await res.json();
    expect(body.emailed).toBe(true);
    expect(body.email).toBe('alice@corp.example');
    expect(store.invites[0]!.email).toBe('alice@corp.example');
  });
});
