import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * End to end through completeLogin: the ID token's `email_verified` is read
 * strictly. Only the JSON boolean `true` lets SSO link to an existing account by
 * email; a missing claim or the string "true" does not.
 */

const idClaims = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({})),
  authorizationCodeGrant: vi.fn(async () => ({ claims: () => idClaims.value })),
}));
vi.mock('../src/services/config.service.js', () => {
  const cfg: Record<string, string> = {
    sso_issuer: 'https://idp.example',
    sso_client_id: 'proxmate',
    sso_client_secret: 'secret',
    sso_enabled: 'true',
  };
  return { getConfig: vi.fn(async (k: string) => cfg[k] ?? null), setConfig: vi.fn() };
});
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() } },
}));
vi.mock('../src/services/auth.service.js', () => ({ hashPassword: async (s: string) => `hashed:${s}` }));

import { prisma } from '../src/lib/prisma.js';
import { completeLogin } from '../src/services/sso.service.js';

const LOCAL = { id: 'u1', email: 'jo@b.c', role: 'user', ssoSubject: null, emailBound: true };
const COOKIE = JSON.stringify({ state: 's', nonce: 'n', codeVerifier: 'v' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockImplementation((async (args: { where: { email?: string } }) =>
    args.where.email === 'jo@b.c' ? LOCAL : null) as never);
  vi.mocked(prisma.user.update).mockImplementation((async (args: { data: object }) => ({ ...LOCAL, ...args.data })) as never);
});

const login = () => completeLogin('https://proxmate.example/api/auth/sso/callback?code=c&state=s', COOKIE);

describe('completeLogin maps email_verified strictly', () => {
  it('does not link when the claim is missing', async () => {
    idClaims.value = { sub: 'sub-1', email: 'jo@b.c' };
    await expect(login()).rejects.toThrow(/sign in with your password/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('does not link when the claim is the string "true"', async () => {
    idClaims.value = { sub: 'sub-1', email: 'jo@b.c', email_verified: 'true' };
    await expect(login()).rejects.toThrow(/sign in with your password/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('links when the claim is boolean true', async () => {
    idClaims.value = { sub: 'sub-1', email: 'jo@b.c', email_verified: true };
    const user = await login();
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { ssoSubject: 'sub-1' } });
    expect(user.ssoSubject).toBe('sub-1');
  });
});
