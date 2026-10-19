/**
 * Endpoints that re-check a credential (PIN, password, passkey) inside an already
 * signed-in session. Their 401 means "that credential was wrong", not "your session
 * is gone", so it must not sign the browser out — the caller shows the error inline.
 */
const REAUTH_PATHS = ["/auth/kiosk-exit"];

/** Bodies the auth middleware sends when the session cookie itself is missing or dead. */
const SESSION_ERRORS = ["Unauthorized — missing session", "Invalid or expired session"];

/**
 * Does this API error mean the browser's session is gone, so the cached user should be
 * cleared (and the guards bounce to /login)?
 */
export function isSessionLoss(status: number | undefined, url: string | undefined, data: unknown): boolean {
  if (status !== 401) return false;
  const path = "/" + (url ?? "").replace(/^\/+/, "").split(/[?#]/)[0];
  const isReauth = REAUTH_PATHS.some((p) => path === p || path.startsWith(p + "/"));
  if (!isReauth) return true;
  const error = (data as { error?: unknown } | undefined)?.error;
  return typeof error === "string" && SESSION_ERRORS.includes(error);
}
