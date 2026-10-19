import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeUserWrites } from './fake-user-row.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../src/services/mail.service.js', () => ({ getMailConfig: vi.fn(), sendMail: vi.fn() }));
vi.mock('../src/services/notify.service.js', () => ({ notifyWebhook: vi.fn(async () => undefined) }));

import { prisma } from '../src/lib/prisma.js';
import * as audit from '../src/services/audit.service.js';
import * as mail from '../src/services/mail.service.js';
import {
  isAccountLocked,
  clearFailedLogins,
  reserveLoginAttempt,
  registerFailedLogin,
} from '../src/services/account-lockout.service.js';

const updateMany = vi.mocked(prisma.user.updateMany);
const findMany = vi.mocked(prisma.user.findMany);
const recordAudit = vi.mocked(audit.recordAudit);
const getMailConfig = vi.mocked(mail.getMailConfig);
const sendMail = vi.mocked(mail.sendMail);

const who = { id: 'u1', email: 'a@b.c' };

/** Back the prisma mocks with one in-memory row; returns the row. */
function fakeRow(failedLoginAttempts: number, lockedUntil: Date | null = null) {
  const row = { failedLoginAttempts, twoFactorFailedAttempts: 0, lockedUntil };
  const fake = fakeUserWrites(row);
  vi.mocked(prisma.user.update).mockImplementation(fake.update as never);
  updateMany.mockImplementation(fake.updateMany as never);
  return row;
}

/** One full failed attempt the way the login route does it: reserve, then settle. */
async function failOnce(): Promise<{ evaluated: boolean; locked: boolean }> {
  if (!(await reserveLoginAttempt(who, '1.2.3.4'))) return { evaluated: false, locked: false };
  return { evaluated: true, locked: await registerFailedLogin(who, '1.2.3.4') };
}

beforeEach(() => {
  vi.clearAllMocks();
  getMailConfig.mockResolvedValue(null);
});

describe('isAccountLocked', () => {
  it('is true only while lockedUntil is in the future', () => {
    expect(isAccountLocked({ lockedUntil: new Date(Date.now() + 60_000) })).toBe(true);
    expect(isAccountLocked({ lockedUntil: new Date(Date.now() - 60_000) })).toBe(false);
    expect(isAccountLocked({ lockedUntil: null })).toBe(false);
  });
});

describe('clearFailedLogins', () => {
  it('resets the stored counter + lock', async () => {
    const row = fakeRow(3, new Date(Date.now() - 1000));
    await clearFailedLogins({ id: 'u1' });
    expect(row).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null });
  });

  it('clears the slot a reservation just took, even if the caller read a clean row', async () => {
    const row = fakeRow(0);
    expect(await reserveLoginAttempt(who, null)).toBe(true);
    expect(row.failedLoginAttempts).toBe(1);
    await clearFailedLogins({ id: 'u1' });
    expect(row.failedLoginAttempts).toBe(0);
  });
});

describe('reserve + register', () => {
  it('counts a failure below the threshold without locking or alerting', async () => {
    const row = fakeRow(2);
    expect(await failOnce()).toEqual({ evaluated: true, locked: false });
    expect(row.failedLoginAttempts).toBe(3);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('locks and audits on the attempt that reaches the threshold', async () => {
    // Default AUTH_LOCKOUT_MAX is 10, so attempt #10 (from 9) trips the lock.
    const row = fakeRow(9);
    expect(await failOnce()).toEqual({ evaluated: true, locked: true });
    expect(row.failedLoginAttempts).toBe(0); // reset as we lock
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.account_locked', targetId: 'u1' }),
    );
  });

  it('refuses to reserve while locked, and again once the lock has expired', async () => {
    fakeRow(0, new Date(Date.now() + 60_000));
    expect(await reserveLoginAttempt(who, null)).toBe(false);
    fakeRow(0, new Date(Date.now() - 1));
    expect(await reserveLoginAttempt(who, null)).toBe(true);
  });

  it('evaluates at most MAX of a concurrent burst and locks exactly once', async () => {
    const row = fakeRow(0);
    const results = await Promise.all(Array.from({ length: 40 }, () => failOnce()));
    expect(results.filter((r) => r.evaluated)).toHaveLength(10);
    expect(row.lockedUntil).not.toBeNull();
    expect(recordAudit.mock.calls.filter(([a]) => a.action === 'auth.account_locked')).toHaveLength(1);
  });

  it('turns a counter left at the threshold with no lock into an ordinary, expiring lock', async () => {
    const row = fakeRow(10);
    expect(await reserveLoginAttempt(who, null)).toBe(false);
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(row.failedLoginAttempts).toBe(0);
  });

  it('emails every admin when SMTP is configured', async () => {
    getMailConfig.mockResolvedValue({ host: 'smtp', port: 587, secure: false, from: 'x@y.z' } as never);
    findMany.mockResolvedValue([{ email: 'admin1@x.y' }, { email: 'admin2@x.y' }] as never);
    sendMail.mockResolvedValue();
    fakeRow(9);
    await failOnce();
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin1@x.y', subject: expect.stringContaining('Account locked') }),
    );
  });
});
