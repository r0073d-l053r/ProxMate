import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    passwordResetToken: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    passwordResetRequest: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    session: { deleteMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock('../src/services/mail.service.js', () => ({ isMailConfigured: vi.fn(), sendMail: vi.fn() }));
vi.mock('../src/services/auth.service.js', () => ({ hashPassword: vi.fn(async () => 'HASH') }));

import { prisma } from '../src/lib/prisma.js';
import * as mail from '../src/services/mail.service.js';
import { requestReset, resetWithToken } from '../src/services/password-reset.service.js';

const findUser = vi.mocked(prisma.user.findUnique);
const tokenCreate = vi.mocked(prisma.passwordResetToken.create);
const tokenFind = vi.mocked(prisma.passwordResetToken.findUnique);
const reqFind = vi.mocked(prisma.passwordResetRequest.findFirst);
const reqCreate = vi.mocked(prisma.passwordResetRequest.create);
const isMailConfigured = vi.mocked(mail.isMailConfigured);
const sendMail = vi.mocked(mail.sendMail);

beforeEach(() => vi.clearAllMocks());

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
    expect(prisma.passwordResetToken.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { usedAt: expect.any(Date) } });
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });
});
