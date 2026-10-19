import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
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
const updateMany = vi.mocked(prisma.user.updateMany);
const findMany = vi.mocked(prisma.user.findMany);
const recordAudit = vi.mocked(audit.recordAudit);
const getMailConfig = vi.mocked(mail.getMailConfig);
const sendMail = vi.mocked(mail.sendMail);

/**
 * An in-memory stand-in for one User row whose writes behave like the database:
 * `{ increment }` is applied atomically to the CURRENT stored value, and the
 * conditional `updateMany` only matches while its `where` still holds. Each call
 * yields first, so concurrent callers interleave the way parallel requests do.
 */
function fakeRow(initial: number) {
  const row = { failedLoginAttempts: initial, lockedUntil: null as Date | null };
  update.mockImplementation((async (args: { data: { failedLoginAttempts: number | { increment: number } } }) => {
    await Promise.resolve();
    const v = args.data.failedLoginAttempts;
    row.failedLoginAttempts = typeof v === 'number' ? v : row.failedLoginAttempts + v.increment;
    return { failedLoginAttempts: row.failedLoginAttempts };
  }) as never);
  updateMany.mockImplementation((async (args: {
    where: { failedLoginAttempts?: { gte: number } };
    data: { failedLoginAttempts: number; lockedUntil: Date };
  }) => {
    await Promise.resolve();
    const min = args.where.failedLoginAttempts?.gte ?? 0;
    if (row.failedLoginAttempts < min) return { count: 0 };
    Object.assign(row, args.data);
    return { count: 1 };
  }) as never);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeRow(0);
});

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

  it('increments the stored counter atomically below the threshold (no lock, no alert)', async () => {
    const row = fakeRow(2);
    const locked = await registerFailedLogin({ ...base, failedLoginAttempts: 2 }, '1.2.3.4');
    expect(locked).toBe(false);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1' }, data: { failedLoginAttempts: { increment: 1 } } }),
    );
    expect(row.failedLoginAttempts).toBe(3);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('locks the account and audits once the threshold is hit', async () => {
    getMailConfig.mockResolvedValue(null); // SMTP off → no email, still locks + audits
    // Default AUTH_LOCKOUT_MAX is 10, so attempt #10 (from 9) trips the lock.
    const row = fakeRow(9);
    const locked = await registerFailedLogin({ ...base, failedLoginAttempts: 9 }, '1.2.3.4');
    expect(locked).toBe(true);
    expect(row.failedLoginAttempts).toBe(0); // reset as we lock
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.account_locked', targetId: 'u1' }),
    );
  });

  it('counts every one of a burst of concurrent failures and locks exactly once', async () => {
    getMailConfig.mockResolvedValue(null);
    const row = fakeRow(0);
    // Every request in the burst read the row before any of them wrote, so each
    // holds the same stale snapshot (failedLoginAttempts: 0).
    const stale = { ...base, failedLoginAttempts: 0 };
    const results = await Promise.all(Array.from({ length: 12 }, () => registerFailedLogin(stale, '1.2.3.4')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(row.lockedUntil).not.toBeNull();
    expect(recordAudit.mock.calls.filter(([a]) => a.action === 'auth.account_locked')).toHaveLength(1);
  });

  it('emails every admin when SMTP is configured', async () => {
    getMailConfig.mockResolvedValue({ host: 'smtp', port: 587, secure: false, from: 'x@y.z' } as never);
    findMany.mockResolvedValue([{ email: 'admin1@x.y' }, { email: 'admin2@x.y' }] as never);
    sendMail.mockResolvedValue();
    fakeRow(9);
    await registerFailedLogin({ ...base, failedLoginAttempts: 9 }, '1.2.3.4');
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin1@x.y', subject: expect.stringContaining('Account locked') }),
    );
  });
});
