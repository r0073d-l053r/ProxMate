import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authenticator } from 'otplib';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { update: vi.fn(), findUnique: vi.fn() },
    twoFactorRecoveryCode: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
// Make the encrypted-secret round-trip an identity so the test secret is usable.
vi.mock('../src/lib/crypto.js', () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));
vi.mock('../src/services/account-lockout.service.js', () => ({
  reserveSecondFactorAttempt: vi.fn(async () => true),
  registerFailedSecondFactor: vi.fn(async () => false),
  clearFailedSecondFactor: vi.fn(async () => undefined),
}));

import { prisma } from '../src/lib/prisma.js';
import { beginSetup, enable, disable, verifyTotp, verifyRecoveryCode } from '../src/services/twofactor.service.js';
import * as lockout from '../src/services/account-lockout.service.js';

const findUser = vi.mocked(prisma.user.findUnique);

beforeEach(() => vi.clearAllMocks());

describe('2FA (TOTP)', () => {
  it('beginSetup stores a provisional secret and returns a QR', async () => {
    findUser.mockResolvedValue({ id: 'u1', twoFactorEnabled: false, twoFactorSecret: null } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    const { secret, otpauthUrl, qrDataUrl } = await beginSetup('u1', 'a@b.c');
    expect(secret).toBeTruthy();
    expect(otpauthUrl).toContain('otpauth://totp/');
    expect(qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('enable rejects a wrong code, accepts a valid one, and issues 10 recovery codes', async () => {
    const secret = authenticator.generateSecret();
    findUser.mockResolvedValue({ id: 'u1', twoFactorSecret: secret, twoFactorEnabled: false } as never);
    await expect(enable('u1', '000000')).rejects.toThrow(/incorrect/i);

    const { recoveryCodes } = await enable('u1', authenticator.generate(secret));
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes[0]).toMatch(/^[a-f0-9]{5}-[a-f0-9]{5}$/);
    expect(prisma.twoFactorRecoveryCode.createMany).toHaveBeenCalled();
  });

  it('verifyTotp checks the code against an enabled secret', async () => {
    const secret = authenticator.generateSecret();
    findUser.mockResolvedValue({ id: 'u1', twoFactorEnabled: true, twoFactorSecret: secret } as never);
    expect(await verifyTotp('u1', authenticator.generate(secret))).toBe(true);
    expect(await verifyTotp('u1', '000000')).toBe(false);
  });

  it('verifyTotp is false when 2FA is not enabled', async () => {
    findUser.mockResolvedValue({ id: 'u1', twoFactorEnabled: false, twoFactorSecret: null } as never);
    expect(await verifyTotp('u1', '123456')).toBe(false);
  });

  it('verifyRecoveryCode consumes a matching unused code, rejects unknown', async () => {
    vi.mocked(prisma.twoFactorRecoveryCode.findFirst).mockResolvedValue({ id: 'rc1' } as never);
    vi.mocked(prisma.twoFactorRecoveryCode.updateMany).mockResolvedValue({ count: 1 } as never);
    expect(await verifyRecoveryCode('u1', 'abcde-fghij')).toBe(true);
    expect(prisma.twoFactorRecoveryCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'rc1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });

    vi.mocked(prisma.twoFactorRecoveryCode.findFirst).mockResolvedValue(null);
    expect(await verifyRecoveryCode('u1', 'nope')).toBe(false);
  });

  it('a recovery code presented twice at the same moment is accepted once', async () => {
    vi.mocked(prisma.twoFactorRecoveryCode.findFirst).mockResolvedValue({ id: 'rc1' } as never);
    let claimed = false;
    vi.mocked(prisma.twoFactorRecoveryCode.updateMany).mockImplementation((async () => {
      await Promise.resolve();
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    }) as never);
    const results = await Promise.all([verifyRecoveryCode('u1', 'abcde-fghij'), verifyRecoveryCode('u1', 'abcde-fghij')]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('re-running 2FA setup while 2FA is on', () => {
  const active = authenticator.generateSecret();
  const enabledUser = () =>
    ({ id: 'u1', twoFactorEnabled: true, twoFactorSecret: active, twoFactorPendingSecret: null }) as never;

  it('refuses without a current code and leaves the active factor untouched', async () => {
    findUser.mockResolvedValue(enabledUser());
    vi.mocked(prisma.twoFactorRecoveryCode.findFirst).mockResolvedValue(null);
    await expect(beginSetup('u1', 'a@b.c')).rejects.toThrow(/current code/i);
    await expect(beginSetup('u1', 'a@b.c', '000000')).rejects.toThrow(/current code/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('with a current code, stages the new secret without disabling the active one', async () => {
    findUser.mockResolvedValue(enabledUser());
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    const { secret } = await beginSetup('u1', 'a@b.c', authenticator.generate(active));
    const data = vi.mocked(prisma.user.update).mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toEqual({ twoFactorPendingSecret: secret });
    expect(data).not.toHaveProperty('twoFactorEnabled');
    expect(data).not.toHaveProperty('twoFactorSecret');
  });

  it('enable confirms the staged secret and only then replaces the active one', async () => {
    const next = authenticator.generateSecret();
    findUser.mockResolvedValue({
      id: 'u1',
      twoFactorEnabled: true,
      twoFactorSecret: active,
      twoFactorPendingSecret: next,
    } as never);
    // A code from the OLD authenticator does not confirm the new one.
    await expect(enable('u1', authenticator.generate(active))).rejects.toThrow(/incorrect/i);
    await enable('u1', authenticator.generate(next));
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { twoFactorEnabled: true, twoFactorSecret: next, twoFactorPendingSecret: null },
    });
  });

  it('a first-time setup needs no code and still enables on confirmation', async () => {
    findUser.mockResolvedValue({ id: 'u1', twoFactorEnabled: false, twoFactorSecret: null, twoFactorPendingSecret: null } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    const { secret } = await beginSetup('u1', 'a@b.c');
    findUser.mockResolvedValue({ id: 'u1', twoFactorEnabled: false, twoFactorSecret: null, twoFactorPendingSecret: secret } as never);
    const { recoveryCodes } = await enable('u1', authenticator.generate(secret));
    expect(recoveryCodes).toHaveLength(10);
  });
});

describe('codes that confirm a 2FA change count toward the account lockout', () => {
  const active = authenticator.generateSecret();
  const enabledUser = { id: 'u1', email: 'a@b.c', twoFactorEnabled: true, twoFactorSecret: active, twoFactorPendingSecret: null };

  beforeEach(() => {
    findUser.mockResolvedValue(enabledUser as never);
    vi.mocked(prisma.twoFactorRecoveryCode.findFirst).mockResolvedValue(null);
    vi.mocked(lockout.reserveSecondFactorAttempt).mockResolvedValue(true);
  });

  it('a wrong code on disable is counted', async () => {
    await expect(disable('u1', '000000')).rejects.toThrow(/incorrect/i);
    expect(lockout.reserveSecondFactorAttempt).toHaveBeenCalledOnce();
    expect(lockout.registerFailedSecondFactor).toHaveBeenCalledOnce();
  });

  it('a wrong current code on a new setup is counted', async () => {
    await expect(beginSetup('u1', 'a@b.c', '000000')).rejects.toThrow(/current code/i);
    expect(lockout.registerFailedSecondFactor).toHaveBeenCalledOnce();
  });

  it('while the account is locked, no code is checked at all', async () => {
    vi.mocked(lockout.reserveSecondFactorAttempt).mockResolvedValue(false);
    await expect(disable('u1', authenticator.generate(active))).rejects.toThrow(/too many/i);
    await expect(beginSetup('u1', 'a@b.c', authenticator.generate(active))).rejects.toThrow(/too many/i);
    expect(prisma.twoFactorRecoveryCode.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('a correct code clears the count', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    await disable('u1', authenticator.generate(active));
    expect(lockout.clearFailedSecondFactor).toHaveBeenCalledOnce();
    expect(lockout.registerFailedSecondFactor).not.toHaveBeenCalled();
  });
});
