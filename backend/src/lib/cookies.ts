import type { Response } from 'express';

/** httpOnly session cookie (the JWT) — never readable from JS. */
export const SESSION_COOKIE = 'proxmate_session';
/** JS-readable CSRF token cookie — echoed back in the X-CSRF-Token header (double-submit). */
export const CSRF_COOKIE = 'proxmate_csrf';

/**
 * Whether to set the `Secure` flag. Defaults to on in production (HTTPS), off in
 * dev so cookies work over plain-HTTP localhost. Override with `COOKIE_SECURE`.
 */
function secure(): boolean {
  if (process.env.COOKIE_SECURE !== undefined) return process.env.COOKIE_SECURE === 'true';
  return process.env.NODE_ENV === 'production';
}

/** Set the session + CSRF cookies. SameSite=Lax keeps CSRF defended while still
 * allowing the OAuth/SSO top-level redirect (added in a later phase). */
export function setAuthCookies(res: Response, token: string, csrfToken: string, expiresAt: Date): void {
  const maxAge = Math.max(0, expiresAt.getTime() - Date.now());
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secure(),
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false, // the frontend reads this to send the X-CSRF-Token header
    secure: secure(),
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

/** Short-lived httpOnly cookie holding a WebAuthn challenge between options + verify. */
export const WEBAUTHN_COOKIE = 'proxmate_webauthn';

export function setChallengeCookie(res: Response, challenge: string): void {
  res.cookie(WEBAUTHN_COOKIE, challenge, {
    httpOnly: true,
    secure: secure(),
    sameSite: 'lax',
    path: '/',
    maxAge: 5 * 60 * 1000, // 5 minutes to complete the ceremony
  });
}

export function clearChallengeCookie(res: Response): void {
  res.clearCookie(WEBAUTHN_COOKIE, { path: '/' });
}

/**
 * Short-lived httpOnly cookie holding the OIDC `state`/`nonce`/PKCE verifier
 * between the SSO redirect out and the provider's callback. SameSite=Lax so it
 * survives the top-level navigation back from the identity provider.
 */
export const SSO_COOKIE = 'proxmate_sso';

export function setSsoCookie(res: Response, value: string): void {
  res.cookie(SSO_COOKIE, value, {
    httpOnly: true,
    secure: secure(),
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60 * 1000, // 10 minutes to complete the round-trip
  });
}

export function clearSsoCookie(res: Response): void {
  res.clearCookie(SSO_COOKIE, { path: '/' });
}
