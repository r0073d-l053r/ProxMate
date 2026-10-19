import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The WebAuthn challenge a ceremony is verified against is the one the server
 * issued for that ceremony: remembered server-side, short-lived, single-use and
 * tied to its purpose. Whatever the browser sends back in the cookie is only a
 * handle to look it up, never the challenge itself.
 */

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        id: 'u1',
        email: 'bob@corp.example',
        role: 'admin',
        displayName: 'Bob',
        accessExpiresAt: null,
      })),
    },
  },
}));
vi.mock('../src/services/auth.service.js', () => ({
  createSession: vi.fn(async () => ({ token: 'jwt', csrfToken: 'csrf', expiresAt: new Date(Date.now() + 86_400_000) })),
  verifySession: vi.fn(async () => ({
    user: { id: 'u1', email: 'bob@corp.example', role: 'admin', displayName: 'Bob' },
    csrfToken: 'csrf',
    accessExpired: false,
    accessExpiresAt: null,
  })),
}));
let issued = 0;
vi.mock('../src/services/passkey.service.js', () => ({
  authenticationOptions: vi.fn(async () => ({ challenge: `auth-challenge-${++issued}` })),
  registrationOptions: vi.fn(async () => ({ challenge: `reg-challenge-${++issued}` })),
  verifyAuthentication: vi.fn(async () => 'u1'),
  verifyRegistration: vi.fn(async () => undefined),
}));
vi.mock('../src/services/twofactor.service.js', () => ({}));
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
import * as passkeys from '../src/services/passkey.service.js';

const verifyAuthentication = vi.mocked(passkeys.verifyAuthentication);
const verifyRegistration = vi.mocked(passkeys.verifyRegistration);

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

/** POST, sending the given WebAuthn cookie (plus a session for the authed routes). */
function post(path: string, webauthn?: string, body: unknown = { id: 'cred' }) {
  const cookies = ['proxmate_session=jwt', ...(webauthn ? [`proxmate_webauthn=${webauthn}`] : [])];
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookies.join('; '), 'x-csrf-token': 'csrf' },
    body: JSON.stringify(body),
  });
}

/** Ask for options and return the cookie value the server set, plus the challenge it issued. */
async function options(path: string): Promise<{ cookie: string; challenge: string }> {
  const res = await post(path);
  expect(res.status).toBe(200);
  const { challenge } = (await res.json()) as { challenge: string };
  const set = res.headers.get('set-cookie') ?? '';
  const cookie = /proxmate_webauthn=([^;]*)/.exec(set)?.[1] ?? '';
  return { cookie: decodeURIComponent(cookie), challenge };
}

describe('WebAuthn challenges are held server-side', () => {
  it('does not hand the challenge itself to the browser as the cookie value', async () => {
    const { cookie, challenge } = await options('/passkeys/auth/options');
    expect(cookie).toBeTruthy();
    expect(cookie).not.toBe(challenge);
  });

  it('verifies against the issued challenge, and refuses a challenge the client picked', async () => {
    const res = await post('/passkeys/auth/verify', 'challenge-picked-by-client');
    expect(res.status).toBe(400);
    expect(verifyAuthentication).not.toHaveBeenCalled();

    const { cookie, challenge } = await options('/passkeys/auth/options');
    expect((await post('/passkeys/auth/verify', cookie)).status).toBe(200);
    expect(verifyAuthentication).toHaveBeenCalledWith(expect.anything(), challenge);
  });

  it('accepts each issued challenge once', async () => {
    const { cookie } = await options('/passkeys/auth/options');
    expect((await post('/passkeys/auth/verify', cookie)).status).toBe(200);
    expect((await post('/passkeys/auth/verify', cookie)).status).toBe(400);
    expect(verifyAuthentication).toHaveBeenCalledTimes(1);
  });

  it('does not accept a challenge issued for a different ceremony', async () => {
    const reg = await options('/passkeys/register/options');
    expect((await post('/passkeys/auth/verify', reg.cookie)).status).toBe(400);
    const login = await options('/passkeys/auth/options');
    expect((await post('/passkeys/register/verify', login.cookie, { response: {} })).status).toBe(400);
    expect((await post('/kiosk-exit/passkey-verify', login.cookie)).status).toBe(400);
    expect(verifyAuthentication).not.toHaveBeenCalled();
    expect(verifyRegistration).not.toHaveBeenCalled();
  });

  it('runs registration and kiosk unlock against their own issued challenges', async () => {
    const reg = await options('/passkeys/register/options');
    expect((await post('/passkeys/register/verify', reg.cookie, { response: {} })).status).toBe(200);
    expect(verifyRegistration).toHaveBeenCalledWith('u1', {}, reg.challenge, 'Passkey');

    const kiosk = await options('/kiosk-exit/passkey-options');
    expect((await post('/kiosk-exit/passkey-verify', kiosk.cookie)).status).toBe(200);
    expect(verifyAuthentication).toHaveBeenCalledWith(expect.anything(), kiosk.challenge);
  });
});
