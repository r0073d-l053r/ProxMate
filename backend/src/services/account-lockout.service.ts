import type { Prisma, User } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { recordAudit } from './audit.service.js';
import { getMailConfig, sendMail } from './mail.service.js';
import { notifyWebhook } from './notify.service.js';
import { accountLockedEmail } from '../lib/email-templates.js';
import { envNumber } from '../lib/env-number.js';

/**
 * Per-account brute-force lockout. The IP rate limiter (rate-limit.ts) blocks a
 * single noisy source; this protects a *targeted* account from distributed
 * password guessing (MITRE T1110). After `MAX` consecutive failed passwords the
 * account is locked for `LOCK_MINUTES`, auto-unlocking — never a permanent lock,
 * so an attacker can't weaponise it into a denial-of-service. Tunable via env.
 */
const MAX = envNumber('AUTH_LOCKOUT_MAX', 10, 1);
const LOCK_MINUTES = envNumber('AUTH_LOCKOUT_MINUTES', 15, 1);

type Who = Pick<User, 'id' | 'email'>;
type FailureCounter = 'failedLoginAttempts' | 'twoFactorFailedAttempts';

/** True while the account is inside an active lock window. */
export function isAccountLocked(user: Pick<User, 'lockedUntil'>): boolean {
  return !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
}

/*
 * How attempts are counted. Every password or 2FA-code check first RESERVES an
 * attempt: one conditional write that increments the counter only while it is
 * below MAX and the account is not locked. Only a request that got a slot runs
 * the (slow) verification. This is what bounds a parallel burst: requests that
 * arrive together cannot all pass a check and only be counted afterwards, so at
 * most MAX guesses are ever evaluated per lock window.
 *
 * The reserved slot is the attempt's count. A failure then only has to decide
 * whether the account is exhausted and lock it (registerFailed*); a success
 * clears the counter (clearFailed*).
 *
 * Locking does NOT reset the counter: it marks it as spent (EXHAUSTED, above
 * MAX) for the whole lock window, and only the lock running out gives a fresh
 * allowance. A correct password never lifts a lock that is in force, nor resets
 * the second-factor count, so holding the password cannot buy more code guesses
 * than MAX per lock window.
 */

/**
 * Reserve one password attempt. False means the account is locked (or out of
 * attempts): answer as for a wrong password, without verifying anything.
 */
export async function reserveLoginAttempt(user: Who, ip: string | null): Promise<boolean> {
  return reserve(user, ip, 'failedLoginAttempts', 'failed logins');
}

/**
 * Reserve one second-factor attempt (a TOTP or recovery code, at login or when
 * a code confirms a 2FA change). Counted on its own column, which a correct
 * password does NOT reset: whoever is guessing codes already holds the password,
 * so a password-keyed reset would hand them a fresh allowance with every new
 * challenge. Exhausting it applies the same temporary lock as password failures.
 */
export async function reserveSecondFactorAttempt(user: Who, ip: string | null): Promise<boolean> {
  return reserve(user, ip, 'twoFactorFailedAttempts', 'wrong 2FA codes');
}

/**
 * Settle a reserved password attempt that failed. Locks the account (and alerts
 * admins) once the threshold is reached. Returns true if this call applied the lock.
 */
export async function registerFailedLogin(user: Who, ip: string | null): Promise<boolean> {
  return lockIfExhausted(user, ip, 'failedLoginAttempts', 'failed logins');
}

/** Settle a reserved second-factor attempt that failed; may lock, as above. */
export async function registerFailedSecondFactor(user: Who, ip: string | null): Promise<boolean> {
  return lockIfExhausted(user, ip, 'twoFactorFailedAttempts', 'wrong 2FA codes');
}

/**
 * Clear the password failure counter after a correct password. A lock that is
 * still in force is left alone: it may have been applied by wrong 2FA codes, or
 * by other wrong passwords, while this login was in flight, and the login route
 * re-checks it before issuing anything. Only an already-expired lock is tidied up.
 */
export async function clearFailedLogins(user: Pick<User, 'id'>): Promise<void> {
  // Conditional in the database rather than on the caller's (stale) copy: the
  // reservation just incremented the stored counter.
  await prisma.user.updateMany({
    where: { id: user.id, failedLoginAttempts: { gt: 0 } },
    data: { failedLoginAttempts: 0 },
  });
  await prisma.user.updateMany({
    where: { id: user.id, lockedUntil: { lte: new Date() } },
    data: { lockedUntil: null },
  });
}

/** Clear the second-factor failure counter (after a correct code). */
export async function clearFailedSecondFactor(user: Pick<User, 'id'>): Promise<void> {
  await prisma.user.updateMany({
    where: { id: user.id, twoFactorFailedAttempts: { gt: 0 } },
    data: { twoFactorFailedAttempts: 0 },
  });
}

/** Where-clause for "no lock in force right now". */
const notLocked = (now: Date): Prisma.UserWhereInput => ({
  OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
});

/** Counter value that marks an allowance spent by a lock, until that lock runs out. */
const EXHAUSTED = MAX + 1;

async function reserve(user: Who, ip: string | null, counter: FailureCounter, what: string): Promise<boolean> {
  const now = new Date();
  // A lock that has run out gives a fresh allowance. Only a counter marked
  // EXHAUSTED by a lock is reset — never one merely at MAX with attempts still
  // in flight — so this cannot reopen the cap mid-burst.
  await prisma.user.updateMany({
    where: { id: user.id, [counter]: { gt: MAX }, ...notLocked(now) } as Prisma.UserWhereInput,
    data: { [counter]: 0 } as Prisma.UserUpdateManyMutationInput,
  });
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, [counter]: { lt: MAX }, ...notLocked(now) } as Prisma.UserWhereInput,
    data: { [counter]: { increment: 1 } } as Prisma.UserUpdateManyMutationInput,
  });
  if (count === 1) return true;
  // No slot. Normally that is an active lock. It can also be a counter left at
  // MAX with no lock (a request that reserved and then never settled, e.g. a
  // crash); turning that into an ordinary, self-expiring lock means it can
  // never wedge the account shut for good.
  await lockIfExhausted(user, ip, counter, what);
  return false;
}

/**
 * Lock the account when `counter` has reached MAX and no lock is in force. The
 * lock is claimed with a conditional write, so of several concurrent failures
 * exactly one locks, audits and alerts. The counter is marked EXHAUSTED rather
 * than reset, so the allowance stays spent until the lock runs out (see reserve).
 */
async function lockIfExhausted(user: Who, ip: string | null, counter: FailureCounter, what: string): Promise<boolean> {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000);
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, [counter]: { gte: MAX }, ...notLocked(now) } as Prisma.UserWhereInput,
    data: { [counter]: EXHAUSTED, lockedUntil } as Prisma.UserUpdateManyMutationInput,
  });
  if (count === 0) return false; // not exhausted, or a concurrent failure already locked

  const attempts = MAX;
  await recordAudit({
    action: 'auth.account_locked',
    actor: { id: user.id, email: user.email },
    targetType: 'user',
    targetId: user.id,
    detail: `locked ${LOCK_MINUTES}m after ${attempts} ${what}${ip ? ` from ${ip}` : ''}`,
  });
  await alertAdmins(user, attempts, ip, lockedUntil).catch(() => {});
  // Webhook-only here — admins are already emailed by alertAdmins above.
  await notifyWebhook({
    event: 'auth.lockout',
    title: user.email,
    message:
      `Account "${user.email}" was locked after ${attempts} failed login attempts` +
      `${ip ? ` from ${ip}` : ''}. Unlocks at ${lockedUntil.toISOString()}.`,
  }).catch(() => {});
  return true;
}

/**
 * Best-effort email to every admin that an account was locked, so a brute-force
 * attempt is visible without polling the audit log. No-op when SMTP is off. Fired
 * at most once per lock window (further attempts hit the locked-out short-circuit
 * before they reach here), so it can't be turned into a mail bomb.
 */
async function alertAdmins(
  user: Pick<User, 'email'>,
  attempts: number,
  ip: string | null,
  lockedUntil: Date,
): Promise<void> {
  if (!(await getMailConfig())) return;
  const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { email: true } });
  if (admins.length === 0) return;
  const { subject, text, html } = accountLockedEmail({
    email: user.email,
    attempts,
    ip,
    lockedUntil,
    lockMinutes: LOCK_MINUTES,
  });
  for (const a of admins) {
    await sendMail({ to: a.email, subject, text, html }).catch(() => undefined);
  }
}
