import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Required 2FA applies to the local password login whether or not the account
 * is also linked to an SSO identity. The IdP's second factor only covers sign-ins
 * that go through the IdP; a password login never does.
 */

const row = {
  id: 'u1',
  email: 'bob@corp.example',
  role: 'user',
  displayName: 'Bob',
  passwordHash: 'hash',
  ssoSubject: 'idp-sub-1' as string | null,
  require2fa: true,
  twoFactorEnabled: false,
  failedLoginAttempts: 0,
  twoFactorFailedAttempts: 0,
  lockedUntil: null as Date | null,
  accessExpiresAt: null,
};
let passkeys = 0;

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async (args: { select?: Record<string, boolean> }) => {
        if (!args.select) return { ...row };
        return Object.fromEntries(Object.keys(args.select).map((k) => [k, (row as Record<string, unknown>)[k]]));
      }),
      update: vi.fn(async () => ({ ...row })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    passkey: { count: vi.fn(async () => passkeys) },
  },
}));
vi.mock('../src/services/auth.service.js', () => ({
  hashPassword: vi.fn(),
  verifyPasswordSafe: vi.fn(async () => true),
  createSession: vi.fn(async () => ({ token: 'jwt', csrfToken: 'csrf', expiresAt: new Date(Date.now() + 86_400_000) })),
  retireSessionWithGrace: vi.fn(),
  signChallenge: vi.fn(async () => 'challenge'),
  verifyChallenge: vi.fn(),
  recordChallengeFailure: vi.fn(),
  consumeChallenge: vi.fn(),
  signEnrollment: vi.fn(async () => 'enroll-token'),
  verifyEnrollment: vi.fn(),
  verifySession: vi.fn(),
}));
vi.mock('../src/services/twofactor.service.js', () => ({}));
vi.mock('../src/services/passkey.service.js', () => ({}));
vi.mock('../src/services/sso.service.js', () => ({}));
vi.mock('../src/services/kiosk.service.js', () => ({}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/password-reset.service.js', () => ({}));
vi.mock('../src/middleware/rate-limit.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { authLimiter: pass, publicTokenLimiter: pass, kioskExitLimiter: pass };
});

import authRoutes from '../src/routes/auth.routes.js';
import * as authService from '../src/services/auth.service.js';

let server: http.Server | undefined;
let base = '';

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(row, { ssoSubject: 'idp-sub-1', require2fa: true, twoFactorEnabled: false });
  passkeys = 0;
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

const login = () =>
  fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: row.email, password: 'right' }),
  });

describe('POST /auth/login for a require2fa account that is SSO-linked', () => {
  it('refuses a password-only session when the only factor is a passkey', async () => {
    passkeys = 1;
    const res = await login();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'passkey_required' });
    expect(authService.createSession).not.toHaveBeenCalled();
  });

  it('sends a user with no factor yet to enrollment instead of issuing a session', async () => {
    const res = await login();
    expect(await res.json()).toMatchObject({ mfaEnrollmentRequired: true, enrollmentToken: 'enroll-token' });
    expect(authService.createSession).not.toHaveBeenCalled();
  });

  it('still asks for the TOTP code when TOTP is enabled', async () => {
    row.twoFactorEnabled = true;
    const res = await login();
    expect(await res.json()).toMatchObject({ twoFactorRequired: true });
    expect(authService.createSession).not.toHaveBeenCalled();
  });
});
