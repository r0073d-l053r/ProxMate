import { describe, it, expect, vi, afterEach } from 'vitest';

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
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);
    const { registerFailedLogin } = await import('../src/services/account-lockout.service.js');
    const user = { id: 'u1', email: 'a@b.c', failedLoginAttempts: 0, lockedUntil: null };

    // The first failure is just counted…
    vi.mocked(prisma.user.update).mockResolvedValue({ failedLoginAttempts: 1 } as never);
    expect(await registerFailedLogin(user, null)).toBe(false);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();

    // …and the tenth locks, claimed against the default threshold.
    vi.mocked(prisma.user.update).mockResolvedValue({ failedLoginAttempts: 10 } as never);
    expect(await registerFailedLogin(user, null)).toBe(true);
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1', failedLoginAttempts: { gte: 10 } } }),
    );
  });
});
