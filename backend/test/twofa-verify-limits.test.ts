import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Second-factor guessing is limited per account and per login challenge:
 * - a challenge stops working after a few wrong codes and is single-use once it
 *   has produced a session;
 * - wrong codes count against the account (and lock it at the threshold), and a
 *   correct password does not wipe that count;
 * - a locked account cannot finish a 2FA login even with a correct code.
 */

const row = {
  id: 'u1',
  email: 'bob@corp.example',
  role: 'user',
  displayName: 'Bob',
  passwordHash: 'hash',
  ssoSubject: null as string | null,
  require2fa: false,
  twoFactorEnabled: true,
  failedLoginAttempts: 0,
  twoFactorFailedAttempts: 0,
  lockedUntil: null as Date | null,
  accessExpiresAt: null,
};

type Data = Record<string, unknown>;
function applyData(data: Data) {
  for (const [k, v] of Object.entries(data)) {
    const r = row as unknown as Record<string, unknown>;
    r[k] = v && typeof v === 'object' && 'increment' in v ? (r[k] as number) + (v as { increment: number }).increment : v;
  }
}

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({ ...row })),
      findMany: vi.fn(async () => []),
      update: vi.fn(async (args: { data: Data }) => {
        applyData(args.data);
        return { ...row };
      }),
      updateMany: vi.fn(async (args: { where: Record<string, { gte: number } | string>; data: Data }) => {
        for (const [k, cond] of Object.entries(args.where)) {
          if (k === 'id') continue;
          const v = (row as unknown as Record<string, number>)[k]!;
          if (typeof cond === 'object' && v < cond.gte) return { count: 0 };
        }
        applyData(args.data);
        return { count: 1 };
      }),
    },
  },
}));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (k: string) => (k === 'jwt_secret' ? 'test-secret-2fa-limits' : null)),
}));
vi.mock('../src/services/auth.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/auth.service.js')>();
  return {
    ...actual,
    verifyPasswordSafe: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ token: 'jwt', csrfToken: 'csrf', expiresAt: new Date(Date.now() + 86_400_000) })),
  };
});
vi.mock('../src/services/twofactor.service.js', () => ({
  verifyTotp: vi.fn(async () => false),
  verifyRecoveryCode: vi.fn(async () => false),
}));
vi.mock('../src/services/passkey.service.js', () => ({}));
vi.mock('../src/services/sso.service.js', () => ({}));
vi.mock('../src/services/mfa.service.js', () => ({ isMfaSetupRequired: vi.fn(async () => false) }));
vi.mock('../src/services/kiosk.service.js', () => ({}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/mail.service.js', () => ({ getMailConfig: vi.fn(async () => null), sendMail: vi.fn() }));
vi.mock('../src/services/notify.service.js', () => ({ notifyWebhook: vi.fn(async () => undefined) }));
vi.mock('../src/services/password-reset.service.js', () => ({}));
vi.mock('../src/middleware/rate-limit.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { authLimiter: pass, publicTokenLimiter: pass, kioskExitLimiter: pass };
});

import authRoutes from '../src/routes/auth.routes.js';
import * as twofa from '../src/services/twofactor.service.js';

const verifyTotp = vi.mocked(twofa.verifyTotp);

let server: http.Server | undefined;
let base = '';

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(row, { failedLoginAttempts: 0, twoFactorFailedAttempts: 0, lockedUntil: null });
  verifyTotp.mockResolvedValue(false);
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

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function login(): Promise<string> {
  const res = await post('/login', { email: row.email, password: 'right' });
  const body = (await res.json()) as { challenge?: string };
  expect(body.challenge).toBeTruthy();
  return body.challenge!;
}

describe('POST /auth/2fa/verify attempt limits', () => {
  it('retires a challenge after a few wrong codes', async () => {
    const challenge = await login();
    for (let i = 0; i < 5; i++) {
      expect((await post('/2fa/verify', { challenge, code: '000000' })).status).toBe(401);
    }
    verifyTotp.mockResolvedValue(true);
    expect((await post('/2fa/verify', { challenge, code: '123456' })).status).toBe(401);
  });

  it('accepts a challenge only once', async () => {
    const challenge = await login();
    verifyTotp.mockResolvedValue(true);
    expect((await post('/2fa/verify', { challenge, code: '123456' })).status).toBe(200);
    expect((await post('/2fa/verify', { challenge, code: '123456' })).status).toBe(401);
  });

  it('counts wrong codes against the account across fresh challenges, and a correct password does not reset them', async () => {
    for (let i = 0; i < 3; i++) {
      row.failedLoginAttempts = 1; // so the correct password below really runs its reset
      const challenge = await login();
      await post('/2fa/verify', { challenge, code: '000000' });
      await post('/2fa/verify', { challenge, code: '000000' });
    }
    expect(row.twoFactorFailedAttempts).toBe(6);
  });

  it('locks the account at the threshold, after which even a correct code is refused', async () => {
    for (let i = 0; i < 5; i++) {
      const challenge = await login();
      await post('/2fa/verify', { challenge, code: '000000' });
      await post('/2fa/verify', { challenge, code: '000000' });
    }
    expect(row.lockedUntil).not.toBeNull();
    // Fresh challenges are no longer issued, and one minted earlier no longer works.
    expect((await post('/login', { email: row.email, password: 'right' })).status).toBe(401);
    row.lockedUntil = null;
    const challenge = await login();
    row.lockedUntil = new Date(Date.now() + 60_000);
    verifyTotp.mockResolvedValue(true);
    expect((await post('/2fa/verify', { challenge, code: '123456' })).status).toBe(401);
  });

  it('clears the second-factor failure count after a successful 2FA login', async () => {
    row.twoFactorFailedAttempts = 4;
    const challenge = await login();
    verifyTotp.mockResolvedValue(true);
    expect((await post('/2fa/verify', { challenge, code: '123456' })).status).toBe(200);
    expect(row.twoFactorFailedAttempts).toBe(0);
  });
});
