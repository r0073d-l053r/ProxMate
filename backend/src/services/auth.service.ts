import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
import { isAccessExpired } from './access.service.js';
import { EphemeralStore } from '../lib/ephemeral-store.js';
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
 * Mint a session: sign a JWT, generate a CSRF token, and persist the `Session`
 * row. The caller sets the httpOnly session cookie + readable CSRF cookie from
 * the returned values. Requires the JWT secret to already exist.
 */
export async function createSession(
  userId: string,
): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const { token, expiresAt } = await signToken(userId);
  const csrfToken = randomBytes(32).toString('hex');
  await prisma.session.create({ data: { userId, token, csrfToken, expiresAt } });
  return { token, csrfToken, expiresAt };
}

/**
 * Retire a session with a short overlap instead of deleting it outright. Used
 * by session rotation (`POST /auth/session/refresh`): the kiosk panel polls
 * every second, so requests carrying the OLD cookie are still in flight when
 * the rotation response (with the new cookie) reaches the browser. Deleting
 * the old row immediately made those stragglers 401 — and the frontend clears
 * auth on any 401 — so the panel bounced to /login at a random heartbeat (the
 * "kiosk randomly logs out" bug). A ~90s grace lets in-flight requests finish;
 * `verifySession`'s expiresAt check then retires the row naturally.
 *
 * Shrink-only by construction: the WHERE clause touches only rows that expire
 * AFTER the grace mark, so a session's life is never extended here — and
 * explicit logout still hard-deletes immediately.
 */
export async function retireSessionWithGrace(token: string, graceMs = 90_000): Promise<void> {
  const grace = new Date(Date.now() + graceMs);
  await prisma.session.updateMany({
    where: { token, expiresAt: { gt: grace } },
    data: { expiresAt: grace },
  });
}

/**
 * Verify a JWT and its backing session, returning the user + the session's CSRF
 * token (or null). Used by the HTTP auth middleware (which enforces CSRF on
 * cookie-authenticated mutating requests).
 */
export async function verifySession(
  token: string,
): Promise<{ user: AuthUser; csrfToken: string | null; accessExpired: boolean; accessExpiresAt: Date | null } | null> {
  try {
    const secret = await getJwtSecret();
    // Pin the algorithm — never let a token dictate its own verification alg.
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as { sub: string };

    const session = await prisma.session.findUnique({ where: { token } });
    if (!session || session.expiresAt < new Date()) return null;

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return null;

    return {
      user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
      csrfToken: session.csrfToken,
      // Reported, never `return null`: a lapsed access window is NOT a broken
      // session, and collapsing the two would bounce the tenant to /login with
      // no explanation of why. The caller decides what to do about it.
      accessExpired: isAccessExpired(user),
      accessExpiresAt: user.accessExpiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Verify a token and return just the user (or null). Shared by the WebSocket
 * console upgrade and the IDE proxy, which authenticate via the session cookie
 * (not a header).
 *
 * A lapsed access window collapses to null HERE, deliberately: these callers
 * are raw socket/proxy transports with no JSON error channel, and doing it at
 * this one spot means any future transport that copies the `verifyToken`
 * pattern inherits the check instead of silently bypassing it.
 */
export async function verifyToken(token: string): Promise<AuthUser | null> {
  const s = await verifySession(token);
  return !s || s.accessExpired ? null : s.user;
}

/** Codes a single 2FA login challenge may be checked against before it stops working. */
const CHALLENGE_MAX_ATTEMPTS = 5;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Server-side record of every outstanding 2FA challenge (keyed by its `jti`), so
 * a challenge can be retired: after a successful exchange (single-use) or after
 * CHALLENGE_MAX_ATTEMPTS wrong codes. The signed JWT alone cannot express either.
 */
const challenges = new EphemeralStore<{ userId: string; attempts: number; busy: boolean }>(CHALLENGE_TTL_MS);

/**
 * Sign a short-lived "2FA pending" token issued after a correct password, to be
 * exchanged (with a TOTP/recovery code) for a real session. Proves the password
 * step happened without holding it client-side.
 */
export async function signChallenge(userId: string): Promise<string> {
  const secret = await getJwtSecret();
  const jti = randomBytes(16).toString('hex');
  challenges.set(jti, { userId, attempts: 0, busy: false });
  return jwt.sign({ sub: userId, twofa: true }, secret, { expiresIn: '5m', jwtid: jti });
}

/**
 * Verify a 2FA challenge token. Returns the userId and the challenge's id, or
 * null when the token is invalid, expired, already used or exhausted.
 */
export async function verifyChallenge(token: string): Promise<{ userId: string; challengeId: string } | null> {
  try {
    const secret = await getJwtSecret();
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as {
      sub: string;
      twofa?: boolean;
      jti?: string;
    };
    if (!payload.twofa || !payload.jti) return null;
    const entry = challenges.get(payload.jti);
    if (!entry || entry.userId !== payload.sub) return null;
    return { userId: payload.sub, challengeId: payload.jti };
  } catch {
    return null;
  }
}

/**
 * Start checking a code against a challenge. Synchronous, and it both counts the
 * attempt and marks the challenge busy BEFORE any code is verified, so requests
 * racing on one challenge are evaluated one at a time and never more than
 * CHALLENGE_MAX_ATTEMPTS in total. Serialising also means a recovery code is
 * never spent by a request that was bound to lose to a concurrent one. Returns
 * false when the challenge is unknown, spent, exhausted or already being checked.
 */
export function beginChallengeAttempt(challengeId: string): boolean {
  const entry = challenges.get(challengeId);
  if (!entry || entry.busy || entry.attempts >= CHALLENGE_MAX_ATTEMPTS) return false;
  entry.busy = true;
  entry.attempts += 1;
  return true;
}

/**
 * Finish a check started with beginChallengeAttempt. A correct code spends the
 * challenge (single-use); a wrong one frees it for another try, or retires it at
 * the cap.
 */
export function endChallengeAttempt(challengeId: string, ok: boolean): void {
  const entry = challenges.get(challengeId);
  if (!entry) return;
  if (ok || entry.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    challenges.delete(challengeId);
    return;
  }
  entry.busy = false;
}

/**
 * Sign a short-lived "2FA enrollment" token, issued at registration (or a
 * re-login) for a user whose invite required 2FA but who hasn't set up a factor.
 * It is NOT a session — it carries no `Session` row, so `verifySession` (and
 * therefore every resource route) rejects it. It authorizes only the first-factor
 * enrollment endpoints (via `requireEnrollment`), and only while the user still
 * needs setup. The real session is minted later, at the post-enrollment login.
 */
export async function signEnrollment(userId: string): Promise<string> {
  const secret = await getJwtSecret();
  return jwt.sign({ sub: userId, enroll: true }, secret, { expiresIn: '15m' });
}

/** Verify a 2FA enrollment token; returns the userId or null. */
export async function verifyEnrollment(token: string): Promise<string | null> {
  try {
    const secret = await getJwtSecret();
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as { sub: string; enroll?: boolean };
    return payload.enroll ? payload.sub : null;
  } catch {
    return null;
  }
}
