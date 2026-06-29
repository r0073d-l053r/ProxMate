import type { Request, Response, NextFunction } from 'express';
import { verifySession } from '../services/auth.service.js';
import { isApiToken, verifyApiToken } from '../services/api-token.service.js';
import { SESSION_COOKIE } from '../lib/cookies.js';
import type { AuthRequest } from '../types/index.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
