import { describe, it, expect, vi, afterEach } from 'vitest';
import { fakeUserWrites } from './fake-user-row.js';

/**
 * Numeric tunables read from the environment fall back to their default when
 * the value is not a number, instead of becoming NaN (which compares false with
 * everything and silently switches the feature off).
 */

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { user: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(async () => []) } },
}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../src/services/mail.service.js', () => ({ getMailConfig: vi.fn(async () => null), sendMail: vi.fn() }));
vi.mock('../src/services/notify.service.js', () => ({ notifyWebhook: vi.fn(async () => undefined) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('envNumber', () => {
  it('reads a finite number, clamped to the minimum', async () => {
    const { envNumber } = await import('../src/lib/env-number.js');
    vi.stubEnv('PM_TEST_N', '42');
    expect(envNumber('PM_TEST_N', 7, 1)).toBe(42);
    vi.stubEnv('PM_TEST_N', '0');
    expect(envNumber('PM_TEST_N', 7, 1)).toBe(1);
  });

  it('falls back to the default when unset, empty or not a number', async () => {
    const { envNumber } = await import('../src/lib/env-number.js');
    expect(envNumber('PM_TEST_UNSET_N', 7, 1)).toBe(7);
    for (const bad of ['', 'abc', '10x', 'NaN', 'Infinity']) {
      vi.stubEnv('PM_TEST_N', bad);
      expect(envNumber('PM_TEST_N', 7, 1)).toBe(7);
    }
  });
});

describe('a non-numeric AUTH_LOCKOUT_MAX', () => {
  it('keeps the default threshold of 10', async () => {
    vi.stubEnv('AUTH_LOCKOUT_MAX', 'abc');
    const { prisma } = await import('../src/lib/prisma.js');
    const row = { failedLoginAttempts: 0, lockedUntil: null as Date | null };
    vi.mocked(prisma.user.updateMany).mockImplementation(fakeUserWrites(row).updateMany as never);
    const { reserveLoginAttempt, registerFailedLogin } = await import('../src/services/account-lockout.service.js');
    const user = { id: 'u1', email: 'a@b.c' };

    // Nine failures are counted without a lock…
    for (let i = 0; i < 9; i++) {
      expect(await reserveLoginAttempt(user, null)).toBe(true);
      expect(await registerFailedLogin(user, null)).toBe(false);
    }
    // …and the tenth locks.
    expect(await reserveLoginAttempt(user, null)).toBe(true);
    expect(await registerFailedLogin(user, null)).toBe(true);
    expect(row.lockedUntil).not.toBeNull();
  });
});
