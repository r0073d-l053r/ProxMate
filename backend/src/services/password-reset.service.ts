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

/** Complete a reset using the emailed token. Returns the user (for auditing). */
export async function resetWithToken(
  token: string,
  newPassword: string,
): Promise<{ id: string; email: string }> {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) {
    throw new Error('This reset link is invalid or has expired.');
  }
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    // Invalidate every existing session — a reset logs you out everywhere.
    prisma.session.deleteMany({ where: { userId: row.userId } }),
  ]);
  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  return { id: row.userId, email: user?.email ?? '' };
}

/** Admin sets a user's password directly (the no-email fallback). */
export async function adminResetPassword(userId: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.session.deleteMany({ where: { userId } }),
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
