import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../lib/prisma.js';

/**
 * Community-Edition broadcast opt-out. Each admin broadcast email carries a
 * per-recipient unsubscribe link authenticated by a deterministic HMAC over the
 * user id (keyed from ENCRYPTION_KEY) — no DB token table needed, the link stays
 * valid for the life of the account, and it can't be forged for another user.
 * Only broadcast (announcement) emails honor the flag; transactional, security,
 * and event-notification emails are unaffected. The EDU edition deliberately has
 * no opt-out (instructors must be able to reach every student).
 */

const SCOPE = 'broadcast-unsub:'; // domain-separates this HMAC from any future token use

function hmacFor(userId: string): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) throw new Error('ENCRYPTION_KEY is not set');
  return createHmac('sha256', Buffer.from(hex, 'hex')).update(SCOPE + userId).digest();
}

/** The unsubscribe token embedded in a broadcast email link: `<userId>.<hmac-hex>`. */
export function unsubscribeToken(userId: string): string {
  return `${userId}.${hmacFor(userId).toString('hex')}`;
}

// cuid ids are lowercase alphanumerics; the MAC is 64 hex chars.
const TOKEN_RE = /^([a-z0-9]{10,40})\.([a-f0-9]{64})$/;

/** Verify an unsubscribe token; returns the user id, or null for any invalid token. */
export function verifyUnsubscribeToken(token: string): string | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const [, userId, macHex] = m;
  const expected = hmacFor(userId!);
  const given = Buffer.from(macHex!, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return userId!;
}

/** Set a user's broadcast opt-out flag. Returns the user's email, or null if no such user. */
export async function setBroadcastOptOut(userId: string, optOut: boolean): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  if (user.broadcastOptOut !== optOut) {
    await prisma.user.update({ where: { id: userId }, data: { broadcastOptOut: optOut } });
  }
  return user.email;
}
