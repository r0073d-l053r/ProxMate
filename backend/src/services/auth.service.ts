import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
import type { AuthUser } from '../types/index.js';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Precomputed once so login spends the same time whether or not the email
// exists — prevents timing-based account enumeration.
const DUMMY_HASH = bcrypt.hashSync('proxmate-timing-guard', 12);

/**
 * Always runs a bcrypt comparison (against a dummy hash when `hash` is null)
 * so the response time doesn't reveal whether the account exists.
 */
export async function verifyPasswordSafe(
  password: string,
  hash: string | null | undefined,
): Promise<boolean> {
  const matches = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  return hash ? matches : false;
}

export async function getJwtSecret(): Promise<string> {
  const secret = await getConfig('jwt_secret');
  if (!secret) throw new Error('JWT secret not configured — run setup first');
  return secret;
}

export async function signToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const secret = await getJwtSecret();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  // jti makes every token unique even when minted in the same second for the
  // same user — otherwise the identical JWT collides on Session.token (@unique).
  const token = jwt.sign({ sub: userId, jti: randomBytes(16).toString('hex') }, secret, {
    expiresIn: '24h',
  });
  return { token, expiresAt };
}

/**
 * Verify a JWT and its backing session, returning the user or null.
 * Shared by the HTTP auth middleware and the WebSocket console upgrade
 * (which can only pass the token via query param).
 */
export async function verifyToken(token: string): Promise<AuthUser | null> {
  try {
    const secret = await getJwtSecret();
    const payload = jwt.verify(token, secret) as { sub: string };

    const session = await prisma.session.findUnique({ where: { token } });
    if (!session || session.expiresAt < new Date()) return null;

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return null;

    return { id: user.id, email: user.email, role: user.role, displayName: user.displayName };
  } catch {
    return null;
  }
}
