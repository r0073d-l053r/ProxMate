import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A `pm_` API token is programmatic access to the API, not a login. It must not
 * reach anything that changes how the account itself is secured: refreshing a
 * session, 2FA, passkeys, the kiosk re-auth check, managing API tokens, or the
 * admin settings that decide how accounts sign in (password reset, SSO, kiosk
 * PIN). Those accept only a browser session.
 */

vi.mock('../src/lib/prisma.js', () => {
  // Stable per-model, per-method mocks so a test can assert nothing was written.
  const models = new Map<string, Record<string, unknown>>();
  const model = (name: string) => {
    if (!models.has(name)) {
      const fns = new Map<string, unknown>();
      models.set(
        name,
        new Proxy({}, {
          get: (_t, m: string) => {
            if (!fns.has(m)) fns.set(m, vi.fn(async () => null));
            return fns.get(m);
          },
        }),
      );
    }
    return models.get(name);
  };
  return { prisma: new Proxy({}, { get: (_t, name: string) => model(name) }) };
});
vi.mock('../src/services/mail.service.js', () => ({
  isMailConfigured: vi.fn(async () => true),
  sendMail: vi.fn(async () => undefined),
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
vi.mock('../src/services/sso.service.js', () => ({
  saveSsoConfig: vi.fn(async () => undefined),
}));
vi.mock('../src/services/mfa.service.js', () => ({ isMfaSetupRequired: vi.fn(async () => false) }));
vi.mock('../src/services/kiosk.service.js', () => ({
  verifyKioskPin: vi.fn(async () => true),
  setKioskPin: vi.fn(async () => undefined),
  isKioskPinSet: vi.fn(async () => false),
  isValidKioskPin: () => true,
}));
vi.mock('../src/services/audit.service.js', () => ({
  recordAudit: vi.fn(async () => undefined),
  listAudit: vi.fn(async () => []),
}));
vi.mock('../src/services/account-lockout.service.js', () => ({}));
vi.mock('../src/services/password-reset.service.js', () => ({
  listResetRequests: vi.fn(async () => []),
  adminResetPassword: vi.fn(async () => undefined),
}));
vi.mock('../src/middleware/rate-limit.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { authLimiter: pass, publicTokenLimiter: pass, kioskExitLimiter: pass };
});

import authRoutes from '../src/routes/auth.routes.js';
import apiTokenRoutes from '../src/routes/api-token.routes.js';
import adminRoutes from '../src/routes/admin.routes.js';
import inviteRoutes from '../src/routes/invite.routes.js';
import { prisma } from '../src/lib/prisma.js';
import * as mailService from '../src/services/mail.service.js';
import * as authService from '../src/services/auth.service.js';
import * as apiTokenService from '../src/services/api-token.service.js';
import * as passwordReset from '../src/services/password-reset.service.js';
import * as ssoService from '../src/services/sso.service.js';
import * as kioskService from '../src/services/kiosk.service.js';
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
  app.use('/api/admin', adminRoutes);
  app.use('/api/invites', inviteRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function call(method: string, path: string, body: unknown, headers: Record<string, string>) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const BROWSER = { cookie: `${SESSION_COOKIE}=browser-jwt`, 'x-csrf-token': 'csrf' };

/** Behind requireAuth, which admits a pm_ Bearer token; requireSession must refuse it. */
const SESSION_ONLY: Array<[string, string, unknown?]> = [
  ['POST', '/auth/session/refresh'],
  ['POST', '/auth/kiosk-exit', { method: 'password', value: 'guess' }],
  ['POST', '/auth/kiosk-exit/passkey-options'],
  ['POST', '/auth/kiosk-exit/passkey-verify', {}],
  ['POST', '/auth/2fa/disable', { code: '123456' }],
  ['GET', '/auth/2fa/status'],
  ['GET', '/auth/passkeys'],
  ['DELETE', '/auth/passkeys/pk1'],
  ['GET', '/api-tokens'],
  ['POST', '/api-tokens', { name: 'more' }],
  ['DELETE', '/api-tokens/t1'],
  ['POST', '/admin/users/u2/reset-password', { password: 'newpassword' }],
  ['PUT', '/admin/settings/sso', { issuer: 'https://idp.example', clientId: 'x' }],
  ['PUT', '/admin/settings/kiosk', { pin: '' }],
  // Invite links create accounts, so they are not obtainable with an API token.
  ['GET', '/invites'],
  ['POST', '/invites', { maxCpu: 1, maxRam: 512, maxStorage: 10, email: 'x@y.z' }],
  ['POST', '/invites/inv1/send', { email: 'x@y.z' }],
];

/** Behind requireAuthOrEnrollment (a session or a scoped enrollment token). */
const ENROLLMENT: Array<[string, string, unknown?]> = [
  ['POST', '/auth/2fa/setup'],
  ['POST', '/auth/2fa/enable', { code: '123456' }],
  ['POST', '/auth/passkeys/register/options'],
  ['POST', '/auth/passkeys/register/verify', {}],
];

describe('API tokens cannot reach account-security endpoints', () => {
  it.each(SESSION_ONLY)('%s %s answers a pm_ Bearer token with 403', async (method, path, body) => {
    const res = await call(method, path, body, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/API tokens cannot/);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(authService.createSession).not.toHaveBeenCalled();
    expect(passwordReset.adminResetPassword).not.toHaveBeenCalled();
    expect(ssoService.saveSsoConfig).not.toHaveBeenCalled();
    expect(kioskService.setKioskPin).not.toHaveBeenCalled();
    expect(prisma.inviteToken.findMany).not.toHaveBeenCalled();
    expect(prisma.inviteToken.findUnique).not.toHaveBeenCalled();
    expect(prisma.inviteToken.create).not.toHaveBeenCalled();
    expect(prisma.inviteToken.updateMany).not.toHaveBeenCalled();
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it.each(ENROLLMENT)('%s %s refuses a pm_ Bearer token', async (method, path, body) => {
    // A pm_ string is neither a session JWT nor an enrollment token.
    const res = await call(method, path, body, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(401);
  });

  it.each(ENROLLMENT)('%s %s: requireSession refuses a pm_ token even if it resolved as a session', async (method, path, body) => {
    // requireSession judges the token's kind, not whether some earlier check
    // accepted it, so these routes stay closed to API tokens on their own.
    vi.mocked(authService.verifySession).mockImplementation(async (t: string) =>
      (t === TOKEN ? { user: ADMIN, csrfToken: 'csrf' } : null) as never,
    );
    const res = await call(method, path, body, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/API tokens cannot/);
  });

  it('still refreshes a browser session', async () => {
    const res = await call('POST', '/auth/session/refresh', undefined, BROWSER);
    expect(res.status).toBe(200);
    expect(authService.createSession).toHaveBeenCalledWith(ADMIN.id);
  });

  it('still lets an admin browser session change sign-in settings', async () => {
    expect((await call('PUT', '/admin/settings/kiosk', { pin: '' }, BROWSER)).status).toBe(200);
    expect(kioskService.setKioskPin).toHaveBeenCalledWith('');
    // The prisma stub has no such user: reaching the handler is what matters.
    expect((await call('POST', '/admin/users/u2/reset-password', { password: 'newpassword' }, BROWSER)).status).toBe(404);
  });

  it('still lets a pm_ token read its own identity', async () => {
    const res = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
