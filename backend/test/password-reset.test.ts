import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    passwordResetToken: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    passwordResetRequest: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    session: { deleteMany: vi.fn() },
    apiToken: { deleteMany: vi.fn() },
    passkey: { deleteMany: vi.fn(), findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock('../src/services/mail.service.js', () => ({ isMailConfigured: vi.fn(), sendMail: vi.fn() }));
vi.mock('../src/services/auth.service.js', () => ({ hashPassword: vi.fn(async () => 'HASH') }));

import { prisma } from '../src/lib/prisma.js';
import * as mail from '../src/services/mail.service.js';
import { requestReset, resetWithToken, adminResetPassword } from '../src/services/password-reset.service.js';

const findUser = vi.mocked(prisma.user.findUnique);
const tokenCreate = vi.mocked(prisma.passwordResetToken.create);
const tokenFind = vi.mocked(prisma.passwordResetToken.findUnique);
const reqFind = vi.mocked(prisma.passwordResetRequest.findFirst);
const reqCreate = vi.mocked(prisma.passwordResetRequest.create);
const isMailConfigured = vi.mocked(mail.isMailConfigured);
const sendMail = vi.mocked(mail.sendMail);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.passwordResetToken.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe('requestReset (anti-enumeration)', () => {
  it('emails a reset link when SMTP is on and the user exists', async () => {
    findUser.mockResolvedValue({ id: 'u1', email: 'a@b.c' } as never);
    isMailConfigured.mockResolvedValue(true);
    tokenCreate.mockResolvedValue({} as never);
    sendMail.mockResolvedValue();
    const r = await requestReset('a@b.c', 'https://app');
    expect(r.method).toBe('email');
    expect(tokenCreate).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledOnce();
    expect(reqCreate).not.toHaveBeenCalled();
  });

  it('files an admin request when SMTP is off and the user exists', async () => {
    findUser.mockResolvedValue({ id: 'u1', email: 'a@b.c' } as never);
    isMailConfigured.mockResolvedValue(false);
    reqFind.mockResolvedValue(null);
    reqCreate.mockResolvedValue({} as never);
    const r = await requestReset('a@b.c', 'https://app');
    expect(r.method).toBe('admin');
    expect(reqCreate).toHaveBeenCalledOnce();
    expect(tokenCreate).not.toHaveBeenCalled();
  });

  it('returns the same method for an unknown email (no token, no request, no leak)', async () => {
    findUser.mockResolvedValue(null);
    isMailConfigured.mockResolvedValue(true);
    const r = await requestReset('nobody@x.y', 'https://app');
    expect(r.method).toBe('email'); // identical to the existing-user case
    expect(tokenCreate).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('dedupes a pending admin request', async () => {
    findUser.mockResolvedValue({ id: 'u1', email: 'a@b.c' } as never);
    isMailConfigured.mockResolvedValue(false);
    reqFind.mockResolvedValue({ id: 'r1' } as never);
    await requestReset('a@b.c', 'https://app');
    expect(reqCreate).not.toHaveBeenCalled();
  });
});

describe('resetWithToken', () => {
  it('rejects unknown / expired / already-used tokens', async () => {
    tokenFind.mockResolvedValue(null);
    await expect(resetWithToken('bad', 'newpassword1')).rejects.toThrow(/invalid or has expired/i);

    tokenFind.mockResolvedValue({ id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() - 1000) } as never);
    await expect(resetWithToken('expired', 'newpassword1')).rejects.toThrow(/invalid or has expired/i);

    tokenFind.mockResolvedValue({ id: 't1', userId: 'u1', usedAt: new Date(), expiresAt: new Date(Date.now() + 1000) } as never);
    await expect(resetWithToken('used', 'newpassword1')).rejects.toThrow(/invalid or has expired/i);
  });

  it('updates the password, marks the token used, and clears all sessions', async () => {
    tokenFind.mockResolvedValue({ id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() + 60_000) } as never);
    findUser.mockResolvedValue({ id: 'u1', email: 'a@b.c' } as never);
    const res = await resetWithToken('good', 'newpassword1');
    expect(res.id).toBe('u1');
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { passwordHash: 'HASH' } });
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });
});

describe('reset links are single-use under concurrency', () => {
  it('two resets presenting the same link at the same moment: only one sets a password', async () => {
    tokenFind.mockResolvedValue({ id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() + 60_000) } as never);
    findUser.mockResolvedValue({ id: 'u1', email: 'a@b.c' } as never);
    let claimed = false;
    vi.mocked(prisma.passwordResetToken.updateMany).mockImplementation((async (args: { where: { id?: string } }) => {
      await Promise.resolve();
      if (!args.where.id) return { count: 0 }; // the "void other links" sweep
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    }) as never);
    const results = await Promise.allSettled([
      resetWithToken('good', 'first-password'),
      resetWithToken('good', 'second-password'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });
});

describe('a password reset signs the account out everywhere', () => {
  it('self-service reset revokes API tokens and other outstanding reset links, but keeps passkeys', async () => {
    tokenFind.mockResolvedValue({ id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() + 60_000) } as never);
    findUser.mockResolvedValue({ id: 'u1', email: 'a@b.c' } as never);
    await resetWithToken('good', 'newpassword1');
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.apiToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(prisma.passkey.deleteMany).not.toHaveBeenCalled();
  });

  it('admin reset revokes sessions, API tokens and outstanding reset links, but keeps passkeys', async () => {
    await adminResetPassword('u1', 'newpassword1');
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.apiToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(prisma.passkey.deleteMany).not.toHaveBeenCalled();
  });
});

describe('passkeys after a reset', () => {
  it('self-service reset reports the passkeys that can still sign in', async () => {
    tokenFind.mockResolvedValue({ id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() + 60_000) } as never);
    findUser.mockResolvedValue({ id: 'u1', email: 'a@b.c' } as never);
    vi.mocked(prisma.passkey.findMany).mockResolvedValue([{ name: 'MacBook' }, { name: 'YubiKey' }] as never);
    const res = await resetWithToken('good', 'newpassword1');
    expect(res.remainingPasskeys).toEqual(['MacBook', 'YubiKey']);
  });

  it('admin reset can also remove passkeys when asked, and keeps them by default', async () => {
    await adminResetPassword('u1', 'newpassword1');
    expect(prisma.passkey.deleteMany).not.toHaveBeenCalled();
    await adminResetPassword('u1', 'newpassword1', { removePasskeys: true });
    expect(prisma.passkey.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });
});
