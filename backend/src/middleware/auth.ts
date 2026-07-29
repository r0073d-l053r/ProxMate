import type { Request, Response, NextFunction } from 'express';
import { verifySession } from '../services/auth.service.js';
import { isApiToken, verifyApiToken } from '../services/api-token.service.js';
import { ACCESS_EXPIRED_CODE, accessExpiredMessage } from '../services/access.service.js';
import { SESSION_COOKIE } from '../lib/cookies.js';
import type { AuthRequest } from '../types/index.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Mark a route as reachable with a lapsed access window.
 *
 * Only `GET /auth/me` and `POST /auth/logout` use it. Without the first, the
 * frontend's AuthGuard — which bounces to /login on ANY /auth/me failure —
 * would eject a suspended tenant to the login screen where they'd type correct
 * credentials forever with no idea why. Without the second, they couldn't even
 * clear their own cookie. Must be mounted BEFORE requireAuth.
 */
export function allowExpiredAccess(req: Request, _res: Response, next: NextFunction): void {
  (req as AuthRequest).allowExpiredAccess = true;
  next();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Prefer the httpOnly session cookie (browser); fall back to a Bearer token
  // for non-browser API clients.
  const cookieToken = req.cookies?.[SESSION_COOKIE] as string | undefined;
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  // A `pm_…` Bearer is a personal API token (programmatic access), resolved
  // separately from session JWTs. API clients send no cookie, so no CSRF surface.
  if (!cookieToken && isApiToken(bearer)) {
    const user = await verifyApiToken(bearer!);
    if (!user) {
      res.status(401).json({ error: 'Invalid or expired API token' });
      return;
    }
    const ar = req as AuthRequest;
    ar.user = user;
    ar.sessionToken = bearer;
    next();
    return;
  }

  const token = cookieToken ?? bearer;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized — missing session' });
    return;
  }

  const session = await verifySession(token);
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  // The tenant's compute-access window (admins exempt). Checked BEFORE CSRF so
  // a suspended tenant gets the real reason rather than a baffling CSRF error.
  // 403 (not 401) on purpose: the session is valid, the entitlement isn't — and
  // the frontend interceptor only clears auth on 401, so the UI keeps enough
  // state to explain what happened instead of dumping them at /login.
  if (session.accessExpired && !(req as AuthRequest).allowExpiredAccess) {
    res.status(403).json({
      error: accessExpiredMessage(session.accessExpiresAt),
      code: ACCESS_EXPIRED_CODE,
    });
    return;
  }

  // CSRF: cookie-authenticated browser requests that change state must echo the
  // session's CSRF token in a header (double-submit). Bearer/API clients don't
  // auto-send cookies, so they have no CSRF surface and are exempt.
  if (cookieToken && MUTATING.has(req.method)) {
    const csrf = req.header('x-csrf-token');
    if (!csrf || !session.csrfToken || csrf !== session.csrfToken) {
      res.status(403).json({ error: 'Invalid or missing CSRF token' });
      return;
    }
  }

  const ar = req as AuthRequest;
  ar.user = session.user;
  ar.sessionToken = token;
  next();
}
