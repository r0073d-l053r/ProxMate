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
      count: vi.fn(),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
// Make the encrypted-secret round-trip an identity so the test secret is usable.
vi.mock('../src/lib/crypto.js', () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));

import { prisma } from '../src/lib/prisma.js';
import { beginSetup, enable, verifyTotp, verifyRecoveryCode } from '../src/services/twofactor.service.js';

const findUser = vi.mocked(prisma.user.findUnique);

beforeEach(() => vi.clearAllMocks());

describe('2FA (TOTP)', () => {
  it('beginSetup stores a provisional secret and returns a QR', async () => {
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
    vi.mocked(prisma.twoFactorRecoveryCode.update).mockResolvedValue({} as never);
    expect(await verifyRecoveryCode('u1', 'abcde-fghij')).toBe(true);
    expect(prisma.twoFactorRecoveryCode.update).toHaveBeenCalledWith({
      where: { id: 'rc1' },
      data: { usedAt: expect.any(Date) },
    });

    vi.mocked(prisma.twoFactorRecoveryCode.findFirst).mockResolvedValue(null);
    expect(await verifyRecoveryCode('u1', 'nope')).toBe(false);
  });
});
