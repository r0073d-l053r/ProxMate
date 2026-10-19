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

type LockFields = Pick<User, 'id' | 'email' | 'failedLoginAttempts' | 'lockedUntil'>;

/** True while the account is inside an active lock window. */
export function isAccountLocked(user: Pick<User, 'lockedUntil'>): boolean {
  return !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
}

/** Clear the failure counter + any lock (called after a correct password). */
export async function clearFailedLogins(user: LockFields): Promise<void> {
  if (user.failedLoginAttempts === 0 && !user.lockedUntil) return; // nothing to clear
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null },
  });
}

/**
 * Record a failed password attempt. Locks the account (and alerts admins) once
 * the threshold is reached. Returns true if this attempt triggered a lock.
 *
 * The count is incremented IN the database and read back, never computed from
 * the caller's copy of the row: the login handler read that copy before a slow
 * bcrypt, so parallel failures would otherwise all write the same "N+1" and the
 * counter would barely move. The lock itself is claimed with a conditional write,
 * so when several concurrent failures cross the threshold together exactly one
 * of them locks, audits and alerts.
 */
export async function registerFailedLogin(user: LockFields, ip: string | null): Promise<boolean> {
  return registerFailure(user, ip, 'failedLoginAttempts', 'failed logins');
}

/**
 * Record a wrong second-factor code (TOTP or recovery code) at login. Counted on
 * its own column, which a correct password does NOT reset: whoever is guessing
 * codes already holds the password, so a password-keyed reset would hand them a
 * fresh allowance with every new challenge. Reaching the threshold applies the
 * same temporary lock (and alerts) as password failures.
 */
export async function registerFailedSecondFactor(
  user: Pick<User, 'id' | 'email'>,
  ip: string | null,
): Promise<boolean> {
  return registerFailure(user, ip, 'twoFactorFailedAttempts', 'wrong 2FA codes');
}

/** Clear the second-factor failure counter (called once a 2FA login fully succeeds). */
export async function clearFailedSecondFactor(user: Pick<User, 'id' | 'twoFactorFailedAttempts'>): Promise<void> {
  if (user.twoFactorFailedAttempts === 0) return;
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorFailedAttempts: 0 } });
}

type FailureCounter = 'failedLoginAttempts' | 'twoFactorFailedAttempts';

async function registerFailure(
  user: Pick<User, 'id' | 'email'>,
  ip: string | null,
  counter: FailureCounter,
  what: string,
): Promise<boolean> {
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { [counter]: { increment: 1 } } as Prisma.UserUpdateInput,
    select: { [counter]: true } as Prisma.UserSelect,
  });
  const attempts = (updated as unknown as Record<FailureCounter, number>)[counter];
  if (attempts < MAX) return false;

  const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
  // Reset the counter as we lock, so the next failed attempt after auto-unlock
  // starts a fresh window rather than instantly re-locking.
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, [counter]: { gte: MAX } } as Prisma.UserWhereInput,
    data: { [counter]: 0, lockedUntil } as Prisma.UserUpdateManyMutationInput,
  });
  if (count === 0) return false; // a concurrent failure already applied this lock

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
