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

const row = vi.hoisted(() => ({
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
}));

vi.mock('../src/lib/prisma.js', async () => {
  const { fakeUserWrites } = await import('./fake-user-row.js');
  const fake = fakeUserWrites(row);
  return {
    prisma: {
      user: {
        findUnique: vi.fn(fake.findUnique),
        findMany: vi.fn(async () => []),
        update: vi.fn(fake.update),
        updateMany: vi.fn(fake.updateMany),
      },
    },
  };
});
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
import * as authService from '../src/services/auth.service.js';

const verifyTotp = vi.mocked(twofa.verifyTotp);
const verifyPasswordSafe = vi.mocked(authService.verifyPasswordSafe);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: http.Server | undefined;
let base = '';

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(row, { failedLoginAttempts: 0, twoFactorFailedAttempts: 0, lockedUntil: null });
  verifyTotp.mockResolvedValue(false);
  verifyPasswordSafe.mockResolvedValue(true);
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

describe('parallel bursts are capped before anything is verified', () => {
  it('evaluates at most 10 of 40 parallel wrong passwords', async () => {
    // A slow check, so every request in the burst is in flight at once.
    verifyPasswordSafe.mockImplementation(async (_pw: string, hash: string | null | undefined) => {
      await delay(20);
      return hash ? false : false;
    });
    await Promise.all(Array.from({ length: 40 }, () => post('/login', { email: row.email, password: 'wrong' })));
    const realChecks = verifyPasswordSafe.mock.calls.filter(([, hash]) => hash === 'hash');
    expect(realChecks.length).toBeLessThanOrEqual(10);
    expect(row.lockedUntil).not.toBeNull();
  });

  it('evaluates at most 5 of 16 parallel wrong codes on one challenge', async () => {
    const challenge = await login();
    verifyTotp.mockImplementation(async () => {
      await delay(20);
      return false;
    });
    await Promise.all(Array.from({ length: 16 }, () => post('/2fa/verify', { challenge, code: '000000' })));
    expect(verifyTotp.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('evaluates at most 10 parallel wrong codes per account across fresh challenges', async () => {
    const challenges: string[] = [];
    for (let i = 0; i < 20; i++) challenges.push(await login());
    verifyTotp.mockImplementation(async () => {
      await delay(20);
      return false;
    });
    await Promise.all(challenges.map((challenge) => post('/2fa/verify', { challenge, code: '000000' })));
    expect(verifyTotp.mock.calls.length).toBeLessThanOrEqual(10);
    expect(row.lockedUntil).not.toBeNull();
  });

  it('checks one code at a time per challenge, so a racing request cannot spend a recovery code', async () => {
    const challenge = await login();
    const recovery = vi.mocked(twofa.verifyRecoveryCode);
    verifyTotp.mockImplementation(async (_userId: string, code: string) => {
      await delay(20);
      return code === '123456';
    });
    const [a, b] = await Promise.all([
      post('/2fa/verify', { challenge, code: '123456' }),
      post('/2fa/verify', { challenge, code: 'abcde-fghij' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(recovery).not.toHaveBeenCalled();
  });
});

describe('a correct password does not lift or refresh a 2FA lockout', () => {
  it('a lock applied while a password login is in flight still holds, and no challenge is issued', async () => {
    const challenges: string[] = [];
    for (let i = 0; i < 11; i++) challenges.push(await login());

    // A slow, CORRECT password check is in flight while ten wrong codes lock the account.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    verifyPasswordSafe.mockImplementationOnce(async () => {
      await gate;
      return true;
    });
    const inFlight = post('/login', { email: row.email, password: 'right' });
    await delay(20);
    for (const challenge of challenges.slice(0, 10)) await post('/2fa/verify', { challenge, code: '000000' });
    expect(row.lockedUntil).not.toBeNull();
    release();

    const res = await inFlight;
    expect(res.status).toBe(401);
    expect(((await res.json()) as { challenge?: string }).challenge).toBeUndefined();
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // The 11th code is never checked, even a correct one on a challenge from before the lock.
    verifyTotp.mockClear();
    verifyTotp.mockResolvedValue(true);
    expect((await post('/2fa/verify', { challenge: challenges[10], code: '123456' })).status).toBe(401);
    expect(verifyTotp).not.toHaveBeenCalled();
  });

  it('locking keeps the spent code allowance spent, and a correct password cannot reset it', async () => {
    for (let i = 0; i < 5; i++) {
      const challenge = await login();
      await post('/2fa/verify', { challenge, code: '000000' });
      await post('/2fa/verify', { challenge, code: '000000' });
    }
    expect(row.lockedUntil).not.toBeNull();
    // While the lock holds, password logins are refused and the code allowance stays spent.
    expect((await post('/login', { email: row.email, password: 'right' })).status).toBe(401);
    expect(row.twoFactorFailedAttempts).toBeGreaterThanOrEqual(10);
  });
});
