import type { Request, Response, NextFunction } from 'express';
import { verifySession, verifyEnrollment } from '../services/auth.service.js';
import { isMfaSetupRequired } from '../services/mfa.service.js';
import { prisma } from '../lib/prisma.js';
import { SESSION_COOKIE } from '../lib/cookies.js';
import type { AuthRequest } from '../types/index.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Authenticate a first-factor *enrollment* request via the Bearer enrollment
 * token (see `signEnrollment`). Honored only while the user still needs MFA
 * setup — the token goes inert the instant a factor lands, so it can't be
 * replayed to re-enroll a different authenticator afterwards. Sets `req.user`.
 * Resource routes never use this; they use `requireAuth`, which rejects the
 * enrollment token outright (it has no `Session` row).
 */
async function authenticateEnrollment(req: Request): Promise<AuthUserResult | null> {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!bearer) return null;

  const userId = await verifyEnrollment(bearer);
  if (!userId) return null;

  // The token only authorizes enrollment, and only until a factor exists.
  if (!(await isMfaSetupRequired(userId))) return null;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  return {
    user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
  };
}

type AuthUserResult = { user: AuthRequest['user'] };

/**
 * Accept EITHER a real session (cookie/Bearer, with CSRF for cookie-mutating
 * requests) OR a scoped enrollment token. Used only by the first-factor
 * enrollment endpoints, so both a logged-in user enrolling from /security and a
 * brand-new invitee finishing required 2FA can hit them. The enrollment branch
 * has no cookie, so no CSRF surface (consistent with the Bearer exemption in
 * `requireAuth`).
 */
export async function requireAuthOrEnrollment(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const cookieToken = req.cookies?.[SESSION_COOKIE] as string | undefined;
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  // 1) Real session first (a logged-in /security user).
  const session = await verifySession(cookieToken ?? bearer ?? '');
  if (session) {
    if (cookieToken && MUTATING.has(req.method)) {
      const csrf = req.header('x-csrf-token');
      if (!csrf || !session.csrfToken || csrf !== session.csrfToken) {
        res.status(403).json({ error: 'Invalid or missing CSRF token' });
        return;
      }
    }
    const ar = req as AuthRequest;
    ar.user = session.user;
    ar.sessionToken = cookieToken ?? bearer;
    next();
    return;
  }

  // 2) Otherwise a scoped enrollment token.
  const enrolled = await authenticateEnrollment(req);
  if (enrolled) {
    (req as AuthRequest).user = enrolled.user;
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized — sign in or restart 2FA setup' });
}
