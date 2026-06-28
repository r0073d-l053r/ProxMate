import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { update: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../src/services/mail.service.js', () => ({ getMailConfig: vi.fn(), sendMail: vi.fn() }));

import { prisma } from '../src/lib/prisma.js';
import * as audit from '../src/services/audit.service.js';
import * as mail from '../src/services/mail.service.js';
import {
  isAccountLocked,
  clearFailedLogins,
  registerFailedLogin,
} from '../src/services/account-lockout.service.js';

const update = vi.mocked(prisma.user.update);
const findMany = vi.mocked(prisma.user.findMany);
const recordAudit = vi.mocked(audit.recordAudit);
const getMailConfig = vi.mocked(mail.getMailConfig);
const sendMail = vi.mocked(mail.sendMail);

beforeEach(() => vi.clearAllMocks());

describe('isAccountLocked', () => {
  it('is true only while lockedUntil is in the future', () => {
    expect(isAccountLocked({ lockedUntil: new Date(Date.now() + 60_000) })).toBe(true);
    expect(isAccountLocked({ lockedUntil: new Date(Date.now() - 60_000) })).toBe(false);
    expect(isAccountLocked({ lockedUntil: null })).toBe(false);
  });
});

describe('clearFailedLogins', () => {
  it('resets the counter + lock when there is a streak', async () => {
    await clearFailedLogins({ id: 'u1', email: 'a@b.c', failedLoginAttempts: 3, lockedUntil: null });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  });

  it('is a no-op when already clean (no needless write)', async () => {
    await clearFailedLogins({ id: 'u1', email: 'a@b.c', failedLoginAttempts: 0, lockedUntil: null });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('registerFailedLogin', () => {
  const base = { id: 'u1', email: 'a@b.c', lockedUntil: null };

  it('just increments below the threshold (no lock, no alert)', async () => {
    const locked = await registerFailedLogin({ ...base, failedLoginAttempts: 2 }, '1.2.3.4');
    expect(locked).toBe(false);
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { failedLoginAttempts: 3 } });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('locks the account and audits once the threshold is hit', async () => {
    getMailConfig.mockResolvedValue(null); // SMTP off → no email, still locks + audits
    // Default AUTH_LOCKOUT_MAX is 10, so attempt #10 (from 9) trips the lock.
    const locked = await registerFailedLogin({ ...base, failedLoginAttempts: 9 }, '1.2.3.4');
    expect(locked).toBe(true);
    const call = update.mock.calls[0]![0] as { data: { failedLoginAttempts: number; lockedUntil: Date } };
    expect(call.data.failedLoginAttempts).toBe(0); // reset as we lock
    expect(call.data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.account_locked', targetId: 'u1' }),
    );
  });

  it('emails every admin when SMTP is configured', async () => {
    getMailConfig.mockResolvedValue({ host: 'smtp', port: 587, secure: false, from: 'x@y.z' } as never);
    findMany.mockResolvedValue([{ email: 'admin1@x.y' }, { email: 'admin2@x.y' }] as never);
    sendMail.mockResolvedValue();
    await registerFailedLogin({ ...base, failedLoginAttempts: 9 }, '1.2.3.4');
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin1@x.y', subject: expect.stringContaining('Account locked') }),
    );
  });
});
