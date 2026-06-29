import type { User } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { recordAudit } from './audit.service.js';
import { getMailConfig, sendMail } from './mail.service.js';
import { notifyWebhook } from './notify.service.js';

/**
 * Per-account brute-force lockout. The IP rate limiter (rate-limit.ts) blocks a
 * single noisy source; this protects a *targeted* account from distributed
 * password guessing (MITRE T1110). After `MAX` consecutive failed passwords the
 * account is locked for `LOCK_MINUTES`, auto-unlocking — never a permanent lock,
 * so an attacker can't weaponise it into a denial-of-service. Tunable via env.
 */
const MAX = Math.max(1, Number(process.env.AUTH_LOCKOUT_MAX ?? 10));
const LOCK_MINUTES = Math.max(1, Number(process.env.AUTH_LOCKOUT_MINUTES ?? 15));

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
 */
export async function registerFailedLogin(user: LockFields, ip: string | null): Promise<boolean> {
  const attempts = user.failedLoginAttempts + 1;
  if (attempts >= MAX) {
    const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
    // Reset the counter as we lock, so the next failed attempt after auto-unlock
    // starts a fresh window rather than instantly re-locking.
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil },
    });
    await recordAudit({
      action: 'auth.account_locked',
      actor: { id: user.id, email: user.email },
      targetType: 'user',
      targetId: user.id,
      detail: `locked ${LOCK_MINUTES}m after ${attempts} failed logins${ip ? ` from ${ip}` : ''}`,
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
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: attempts } });
  return false;
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
  const subject = `[ProxMate] Account locked after failed logins: ${user.email}`;
  const text =
    `The account "${user.email}" was locked after ${attempts} consecutive failed login attempts` +
    `${ip ? ` from IP ${ip}` : ''}.\n\n` +
    `It unlocks automatically at ${lockedUntil.toISOString()} (${LOCK_MINUTES} minutes).\n\n` +
    `If this wasn't the account owner mistyping their password, someone may be ` +
    `attempting to brute-force this account. Review the audit log in ProxMate.`;
  for (const a of admins) {
    await sendMail({ to: a.email, subject, text }).catch(() => undefined);
  }
}
