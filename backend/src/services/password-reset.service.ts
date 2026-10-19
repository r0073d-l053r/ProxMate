import { randomBytes, createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from './auth.service.js';
import { isMailConfigured, sendMail } from './mail.service.js';
import { passwordResetEmail } from '../lib/email-templates.js';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Handle a "forgot password" request. If SMTP is configured, email a single-use
 * reset link; otherwise file a request for an admin to handle. **Anti-enumeration:**
 * the caller-visible result depends only on SMTP config, never on whether the
 * email maps to a real account.
 */
export async function requestReset(email: string, appUrl: string): Promise<{ method: 'email' | 'admin' }> {
  const normalized = email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  const mailOn = await isMailConfigured();

  if (user) {
    if (mailOn) {
      const raw = randomBytes(32).toString('hex');
      await prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
      });
      const link = `${appUrl.replace(/\/+$/, '')}/reset-password?token=${raw}`;
      const email = passwordResetEmail(link);
      // Don't let a mail failure leak (or 500) — log it; the user still gets the generic message.
      await sendMail({ to: user.email, ...email }).catch((err) =>
        console.error('[reset] failed to send email:', err),
      );
    } else {
      // Dedupe pending requests so the admin list isn't spammed.
      const existing = await prisma.passwordResetRequest.findFirst({
        where: { userId: user.id, status: 'pending' },
      });
      if (!existing) {
        await prisma.passwordResetRequest.create({ data: { userId: user.id, email: user.email, status: 'pending' } });
      }
    }
  }

  return { method: mailOn ? 'email' : 'admin' };
}

/**
 * What a password reset (self-service or admin) revokes, in the same
 * transaction as the new password: every session, every API token, and any
 * other reset link still outstanding. A reset is how an account is recovered
 * after a compromise, so it must not leave behind any credential that was
 * derived from the old access.
 *
 * Passkeys are kept by default. They are a separate factor that the user
 * enrolled and manages on their own Security page (where they can see and
 * remove each one), and deleting them would silently strip the second factor
 * from a require2fa account at exactly the moment it is being recovered. So the
 * user is told which passkeys remain (resetWithToken returns them), and an
 * admin resetting a password can opt to remove them as well.
 */
function revokeAccessOnReset(userId: string) {
  return [
    prisma.session.deleteMany({ where: { userId } }),
    prisma.apiToken.deleteMany({ where: { userId } }),
    prisma.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } }),
  ];
}

/**
 * Complete a reset using the emailed token. Returns the user (for auditing) and
 * the names of the passkeys that can still sign in, so the person can check
 * them and remove any they do not recognise.
 */
export async function resetWithToken(
  token: string,
  newPassword: string,
): Promise<{ id: string; email: string; remainingPasskeys: string[] }> {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) {
    throw new Error('This reset link is invalid or has expired.');
  }
  // Spend the link before changing anything. The write is conditional on it
  // still being unused, so when two requests present the same link at once only
  // one of them goes on to set a password.
  const { count } = await prisma.passwordResetToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (count === 0) throw new Error('This reset link is invalid or has expired.');
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
    ...revokeAccessOnReset(row.userId),
  ]);
  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  const passkeys = await prisma.passkey.findMany({
    where: { userId: row.userId },
    select: { name: true },
    orderBy: { createdAt: 'asc' },
  });
  return { id: row.userId, email: user?.email ?? '', remainingPasskeys: passkeys.map((p) => p.name) };
}

/**
 * Admin sets a user's password directly (the no-email fallback). With
 * `removePasskeys` the user's passkeys are deleted too, for an account the
 * admin believes was taken over (off by default; see revokeAccessOnReset).
 */
export async function adminResetPassword(
  userId: string,
  newPassword: string,
  { removePasskeys = false }: { removePasskeys?: boolean } = {},
): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    ...revokeAccessOnReset(userId),
    ...(removePasskeys ? [prisma.passkey.deleteMany({ where: { userId } })] : []),
    prisma.passwordResetRequest.updateMany({
      where: { userId, status: 'pending' },
      data: { status: 'handled', handledAt: new Date() },
    }),
  ]);
}

/** Pending "contact admin" reset requests, newest first. */
export async function listResetRequests() {
  return prisma.passwordResetRequest.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' } });
}
