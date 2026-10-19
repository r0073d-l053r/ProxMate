import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Leaving kiosk mode re-checks a credential inside a live session. A rejected
 * PIN, password or passkey answers 403 with `code: 'reauth_failed'`, so that a
 * 401 from the API keeps exactly one meaning: the session itself is gone.
 */

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { user: { findUnique: vi.fn(async () => ({ id: 'u1', passwordHash: 'hash' })) } },
}));
vi.mock('../src/services/auth.service.js', () => ({
  verifyPasswordSafe: vi.fn(async () => false),
  verifySession: vi.fn(async () => ({
    user: { id: 'u1', email: 'admin@corp.example', role: 'admin', displayName: 'Admin' },
    csrfToken: 'csrf',
    accessExpired: false,
    accessExpiresAt: null,
  })),
}));
vi.mock('../src/services/passkey.service.js', () => ({
  authenticationOptions: vi.fn(async () => ({ challenge: 'c' })),
  verifyAuthentication: vi.fn(async () => 'someone-else'),
}));
vi.mock('../src/services/kiosk.service.js', () => ({ verifyKioskPin: vi.fn(async () => false) }));
vi.mock('../src/services/twofactor.service.js', () => ({}));
vi.mock('../src/services/sso.service.js', () => ({}));
vi.mock('../src/services/mfa.service.js', () => ({ isMfaSetupRequired: vi.fn(async () => false) }));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/account-lockout.service.js', () => ({}));
vi.mock('../src/services/password-reset.service.js', () => ({}));
vi.mock('../src/middleware/rate-limit.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { authLimiter: pass, publicTokenLimiter: pass, kioskExitLimiter: pass };
});

import authRoutes from '../src/routes/auth.routes.js';
import * as passkeys from '../src/services/passkey.service.js';
import * as kiosk from '../src/services/kiosk.service.js';

let server: http.Server | undefined;
let base = '';

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(kiosk.verifyKioskPin).mockResolvedValue(false);
  vi.mocked(passkeys.verifyAuthentication).mockResolvedValue('someone-else');
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

function post(path: string, body: unknown, cookie = 'proxmate_session=jwt') {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': 'csrf' },
    body: JSON.stringify(body),
  });
}

async function passkeyHandle(): Promise<string> {
  const res = await post('/kiosk-exit/passkey-options', {});
  return /proxmate_webauthn=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

describe('kiosk exit: a rejected credential is 403 reauth_failed, not 401', () => {
  it('wrong PIN', async () => {
    const res = await post('/kiosk-exit', { method: 'pin', value: '0000' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'reauth_failed' });
  });

  it('wrong password', async () => {
    const res = await post('/kiosk-exit', { method: 'password', value: 'nope' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'reauth_failed' });
  });

  it("a passkey that is not this admin's", async () => {
    const handle = await passkeyHandle();
    const res = await post('/kiosk-exit/passkey-verify', {}, `proxmate_session=jwt; proxmate_webauthn=${handle}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'reauth_failed' });
  });

  it('a passkey assertion that fails verification', async () => {
    vi.mocked(passkeys.verifyAuthentication).mockRejectedValue(new Error('Passkey authentication failed.'));
    const handle = await passkeyHandle();
    const res = await post('/kiosk-exit/passkey-verify', {}, `proxmate_session=jwt; proxmate_webauthn=${handle}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'reauth_failed' });
  });

  it('a correct PIN unlocks', async () => {
    vi.mocked(kiosk.verifyKioskPin).mockResolvedValue(true);
    expect((await post('/kiosk-exit', { method: 'pin', value: '1234' })).status).toBe(200);
  });

  it('a missing session is still 401', async () => {
    expect((await post('/kiosk-exit', { method: 'pin', value: '0000' }, '')).status).toBe(401);
  });
});
