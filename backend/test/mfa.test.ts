import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    passkey: { count: vi.fn() },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import { isMfaSetupRequired, hasMfaMethod } from '../src/services/mfa.service.js';

const findUser = vi.mocked(prisma.user.findUnique);
const passkeyCount = vi.mocked(prisma.passkey.count);

beforeEach(() => vi.clearAllMocks());

describe('isMfaSetupRequired', () => {
  it('is false when the admin did not require 2FA', async () => {
    findUser.mockResolvedValue({ require2fa: false, ssoSubject: null, twoFactorEnabled: false } as never);
    expect(await isMfaSetupRequired('u1')).toBe(false);
  });

  it('is true when required and the user has neither TOTP nor a passkey', async () => {
    findUser.mockResolvedValue({ require2fa: true, ssoSubject: null, twoFactorEnabled: false } as never);
    passkeyCount.mockResolvedValue(0 as never);
    expect(await isMfaSetupRequired('u1')).toBe(true);
  });

  it('is satisfied by TOTP (no passkey query needed)', async () => {
    findUser.mockResolvedValue({ require2fa: true, ssoSubject: null, twoFactorEnabled: true } as never);
    expect(await isMfaSetupRequired('u1')).toBe(false);
    expect(passkeyCount).not.toHaveBeenCalled();
  });

  it('is satisfied by a passkey', async () => {
    findUser.mockResolvedValue({ require2fa: true, ssoSubject: null, twoFactorEnabled: false } as never);
    passkeyCount.mockResolvedValue(2 as never);
    expect(await isMfaSetupRequired('u1')).toBe(false);
  });

  it('exempts SSO-linked users (their IdP handles MFA)', async () => {
    findUser.mockResolvedValue({ require2fa: true, ssoSubject: 'sub-1', twoFactorEnabled: false } as never);
    expect(await isMfaSetupRequired('u1')).toBe(false);
    expect(passkeyCount).not.toHaveBeenCalled();
  });
});

describe('hasMfaMethod', () => {
  it('true when TOTP is enabled', async () => {
    findUser.mockResolvedValue({ twoFactorEnabled: true } as never);
    passkeyCount.mockResolvedValue(0 as never);
    expect(await hasMfaMethod('u1')).toBe(true);
  });

  it('true when a passkey exists', async () => {
    findUser.mockResolvedValue({ twoFactorEnabled: false } as never);
    passkeyCount.mockResolvedValue(1 as never);
    expect(await hasMfaMethod('u1')).toBe(true);
  });

  it('false with no method', async () => {
    findUser.mockResolvedValue({ twoFactorEnabled: false } as never);
    passkeyCount.mockResolvedValue(0 as never);
    expect(await hasMfaMethod('u1')).toBe(false);
  });
});
