import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An invite sent to an address is for that address: registering through it must
 * use the same email, and the resulting account records that its email was
 * bound by the invite (SSO later relies on that before linking by email).
 */

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    inviteToken: { findUnique: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    user: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'new1', role: 'user', ...args.data })),
      delete: vi.fn(),
    },
  },
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
vi.mock('../src/services/vm-share.service.js', () => ({ claimPendingShares: vi.fn(async () => 0) }));
vi.mock('../src/middleware/rate-limit.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { authLimiter: pass, publicTokenLimiter: pass, kioskExitLimiter: pass };
});

import authRoutes from '../src/routes/auth.routes.js';
import { prisma } from '../src/lib/prisma.js';
import { claimPendingShares } from '../src/services/vm-share.service.js';

const findInvite = vi.mocked(prisma.inviteToken.findUnique);
const createUser = vi.mocked(prisma.user.create);

function invite(email: string | null) {
  return {
    id: 'inv1',
    token: 'tok',
    email,
    maxCpu: 2,
    maxRam: 2048,
    maxStorage: 20,
    require2fa: false,
    accessDuration: null,
    usedById: null,
    expiresAt: new Date(Date.now() + 86_400_000),
  };
}

let server: http.Server | undefined;
let base = '';

beforeEach(async () => {
  vi.clearAllMocks();
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/auth`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function register(email: string) {
  return fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'longenough', displayName: 'Someone', inviteToken: 'tok' }),
  });
}

describe('POST /auth/register with an addressed invite', () => {
  it('refuses an email other than the one the invite was sent to', async () => {
    findInvite.mockResolvedValue(invite('alice@corp.example') as never);
    const res = await register('mallory@corp.example');
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('accepts the invited address (case-insensitively) and marks the email as bound', async () => {
    findInvite.mockResolvedValue(invite('Alice@Corp.example') as never);
    const res = await register('alice@corp.EXAMPLE');
    expect(res.status).toBe(201);
    const data = createUser.mock.calls[0]![0].data as { email: string; emailBound: boolean };
    expect(data.email).toBe('alice@corp.example');
    expect(data.emailBound).toBe(true);
  });

  it('lets an unaddressed invite register any email, but does not mark it bound', async () => {
    findInvite.mockResolvedValue(invite(null) as never);
    const res = await register('bob@corp.example');
    expect(res.status).toBe(201);
    const data = createUser.mock.calls[0]![0].data as { emailBound: boolean };
    expect(data.emailBound).toBe(false);
  });

  it('hands the new account to the pending-share claim once the invite is redeemed', async () => {
    findInvite.mockResolvedValue(invite('alice@corp.example') as never);
    await register('alice@corp.example');
    expect(claimPendingShares).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new1', email: 'alice@corp.example', emailBound: true }),
    );
  });

  it('does not claim pending shares when the invite was already used by someone else', async () => {
    findInvite.mockResolvedValue(invite('alice@corp.example') as never);
    vi.mocked(prisma.inviteToken.updateMany).mockResolvedValueOnce({ count: 0 } as never);
    const res = await register('alice@corp.example');
    expect(res.status).toBe(400);
    expect(claimPendingShares).not.toHaveBeenCalled();
  });

  it('shows the invited address on the invite lookup so the form can lock it', async () => {
    findInvite.mockResolvedValue(invite('alice@corp.example') as never);
    const res = await fetch(`${base}/invite/tok`);
    expect(await res.json()).toMatchObject({ valid: true, email: 'alice@corp.example' });
  });
});
