import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A `pm_` API token is programmatic access to the API, not a login. It must not
 * reach anything that changes how the account itself is secured: refreshing a
 * session, 2FA, passkeys, the kiosk re-auth check, or managing API tokens. Those
 * accept only a browser session.
 */

vi.mock('../src/lib/prisma.js', () => ({
  prisma: new Proxy({}, { get: () => new Proxy({}, { get: () => vi.fn(async () => null) }) }),
}));
vi.mock('../src/services/auth.service.js', () => ({
  hashPassword: vi.fn(),
  verifyPasswordSafe: vi.fn(async () => true),
  createSession: vi.fn(async () => ({ token: 'new-jwt', csrfToken: 'new-csrf', expiresAt: new Date(Date.now() + 86_400_000) })),
  retireSessionWithGrace: vi.fn(async () => undefined),
  signChallenge: vi.fn(),
  verifyChallenge: vi.fn(),
  signEnrollment: vi.fn(),
  verifyEnrollment: vi.fn(async () => null),
  verifySession: vi.fn(),
}));
vi.mock('../src/services/api-token.service.js', () => ({
  isApiToken: (t?: string) => !!t?.startsWith('pm_'),
  verifyApiToken: vi.fn(),
  createApiToken: vi.fn(async () => ({ id: 't2', token: 'pm_new' })),
  listApiTokens: vi.fn(async () => []),
  revokeApiToken: vi.fn(async () => true),
}));
vi.mock('../src/services/twofactor.service.js', () => ({
  setup: vi.fn(async () => ({ secret: 's', otpauthUrl: 'otpauth://x', qr: 'q' })),
  enable: vi.fn(async () => ({ recoveryCodes: [] })),
  disable: vi.fn(async () => undefined),
  status: vi.fn(async () => ({ enabled: false })),
  getStatus: vi.fn(async () => ({ enabled: false })),
}));
vi.mock('../src/services/passkey.service.js', () => ({
  registrationOptions: vi.fn(async () => ({ challenge: 'c' })),
  verifyRegistration: vi.fn(async () => ({ id: 'pk' })),
  authenticationOptions: vi.fn(async () => ({ challenge: 'c' })),
  verifyAuthentication: vi.fn(async () => 'admin1'),
  listPasskeys: vi.fn(async () => []),
  deletePasskey: vi.fn(async () => true),
}));
vi.mock('../src/services/sso.service.js', () => ({}));
vi.mock('../src/services/mfa.service.js', () => ({ isMfaSetupRequired: vi.fn(async () => false) }));
vi.mock('../src/services/kiosk.service.js', () => ({ verifyKioskPin: vi.fn(async () => true) }));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/account-lockout.service.js', () => ({}));
vi.mock('../src/services/password-reset.service.js', () => ({}));
vi.mock('../src/middleware/rate-limit.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { authLimiter: pass, publicTokenLimiter: pass, kioskExitLimiter: pass };
});

import authRoutes from '../src/routes/auth.routes.js';
import apiTokenRoutes from '../src/routes/api-token.routes.js';
import * as authService from '../src/services/auth.service.js';
import * as apiTokenService from '../src/services/api-token.service.js';
import { SESSION_COOKIE } from '../src/lib/cookies.js';

const ADMIN = { id: 'admin1', email: 'a@x.y', role: 'admin', displayName: 'A' };
const TOKEN = 'pm_leakedtoken';

let server: http.Server | undefined;
let base = '';

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(apiTokenService.verifyApiToken).mockImplementation(async (t: string) => (t === TOKEN ? ADMIN : null) as never);
  vi.mocked(authService.verifySession).mockImplementation(async (t: string) =>
    (t === 'browser-jwt' ? { user: ADMIN, csrfToken: 'csrf' } : null) as never,
  );
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/api-tokens', apiTokenRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

const SECURITY_ENDPOINTS: Array<[string, string, unknown?]> = [
  ['POST', '/auth/session/refresh'],
  ['POST', '/auth/kiosk-exit', { method: 'password', value: 'guess' }],
  ['POST', '/auth/kiosk-exit/passkey-options'],
  ['POST', '/auth/kiosk-exit/passkey-verify', {}],
  ['POST', '/auth/2fa/setup'],
  ['POST', '/auth/2fa/enable', { code: '123456' }],
  ['POST', '/auth/2fa/disable', { code: '123456' }],
  ['GET', '/auth/2fa/status'],
  ['POST', '/auth/passkeys/register/options'],
  ['POST', '/auth/passkeys/register/verify', {}],
  ['GET', '/auth/passkeys'],
  ['DELETE', '/auth/passkeys/pk1'],
  ['GET', '/api-tokens'],
  ['POST', '/api-tokens', { name: 'more' }],
  ['DELETE', '/api-tokens/t1'],
];

describe('API tokens cannot reach account-security endpoints', () => {
  it.each(SECURITY_ENDPOINTS)('%s %s refuses a pm_ Bearer token', async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect([401, 403]).toContain(res.status);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(authService.createSession).not.toHaveBeenCalled();
  });

  it('still refreshes a browser session', async () => {
    const res = await fetch(`${base}/auth/session/refresh`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=browser-jwt`, 'x-csrf-token': 'csrf' },
    });
    expect(res.status).toBe(200);
    expect(authService.createSession).toHaveBeenCalledWith(ADMIN.id);
  });

  it('still lets a pm_ token read its own identity', async () => {
    const res = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
