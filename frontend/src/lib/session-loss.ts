/**
 * Does this API error mean the browser's session is gone, so the cached user should be
 * cleared (and the guards bounce to /login)?
 *
 * A 401 from the API always means exactly that. Endpoints that re-check a credential
 * inside a live session (the kiosk-exit PIN, password and passkey) answer a rejected
 * credential with 403 and `code: "reauth_failed"` instead, so they never sign the
 * browser out; the caller shows the error inline.
 */
export function isSessionLoss(status: number | undefined): boolean {
  return status === 401;
}
