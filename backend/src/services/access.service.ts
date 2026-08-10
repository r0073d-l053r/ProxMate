/**
 * Tenant compute-access windows.
 *
 * An admin decides how long someone may use the cluster: either a fixed window
 * ("30 days") or forever. The window is seeded from the invite at registration
 * and can be changed per-user afterwards from the admin Users panel.
 *
 * THE CENTRAL INVARIANT: `accessExpiresAt === null` means NEVER EXPIRES.
 * Null is the default for every column added by the access-expiry migration, so
 * every account that existed before this feature — and every future account
 * invited with "Never" — is unaffected. Callers must never treat a null as
 * "expired now"; `isAccessExpired` is the only thing allowed to make that call.
 *
 * ADMINS ARE ALWAYS EXEMPT, whatever their row says. An expiry that could lock
 * out the last admin would be unrecoverable without DB surgery.
 */

/** A user shape thin enough for the guards to accept any caller's record. */
export interface AccessSubject {
  role: string;
  accessExpiresAt?: Date | null;
}

/** The durations offered in the UI. `never` maps to a null expiry. */
export const ACCESS_DURATIONS = [
  'never',
  '7d',
  '14d',
  '30d',
  '60d',
  '90d',
  '180d',
  '365d',
] as const;

export type AccessDuration = (typeof ACCESS_DURATIONS)[number];

export function isAccessDuration(v: unknown): v is AccessDuration {
  return typeof v === 'string' && (ACCESS_DURATIONS as readonly string[]).includes(v);
}

/**
 * Turn a duration string into an absolute expiry, or null for "never".
 *
 * `from` is injectable so tests are deterministic and so a caller can anchor a
 * window to something other than now (e.g. extending from an existing expiry).
 * Throws on anything not in ACCESS_DURATIONS — an unrecognised string must
 * never silently become "never", which would hand out unlimited access.
 */
export function accessExpiryFrom(duration: string | null | undefined, from: Date = new Date()): Date | null {
  if (duration === null || duration === undefined || duration === 'never') return null;
  if (!isAccessDuration(duration)) {
    throw new Error(`Invalid access duration "${duration}" — expected one of: ${ACCESS_DURATIONS.join(', ')}`);
  }
  const days = parseInt(duration.slice(0, -1), 10);
  return new Date(from.getTime() + days * 86_400_000);
}

/**
 * Has this tenant's compute access lapsed?
 *
 * Admins never expire. A null expiry never expires. Otherwise it is a plain
 * instant comparison — the boundary is inclusive of the expiry moment itself
 * (at exactly expiresAt the window is over).
 */
export function isAccessExpired(user: AccessSubject, now: Date = new Date()): boolean {
  if (user.role === 'admin') return false;
  if (!user.accessExpiresAt) return false;
  return user.accessExpiresAt.getTime() <= now.getTime();
}

/** Whole days until access ends; null when it never expires. Negative once lapsed. */
export function daysUntilExpiry(user: AccessSubject, now: Date = new Date()): number | null {
  if (user.role === 'admin' || !user.accessExpiresAt) return null;
  return Math.ceil((user.accessExpiresAt.getTime() - now.getTime()) / 86_400_000);
}

/** The message shown wherever a suspended tenant is turned away. */
export const ACCESS_EXPIRED_MESSAGE =
  'Your compute access has ended. Your machines and data are safe — contact your administrator to restore access.';

/** Machine-readable marker so the UI can tell this apart from a dead session. */
export const ACCESS_EXPIRED_CODE = 'access_expired';

export function accessExpiredMessage(at: Date | null): string {
  return at
    ? `Your compute access ended on ${at.toUTCString()}. Your machines and data are safe — contact your administrator to restore access.`
    : ACCESS_EXPIRED_MESSAGE;
}

/** The 403 body handed back when a login is refused on entitlement grounds. */
export interface AccessRefusal {
  code: typeof ACCESS_EXPIRED_CODE;
  error: string;
}

/**
 * The entitlement gate every session-minting login path must pass through.
 *
 * Returns a ready-to-send refusal when this account may not be granted a session,
 * or null when it may. Exists as one function — rather than the same three lines
 * copied into each login handler — because the number of login paths only ever
 * grows (password, passkey, SSO today; SAML and LDAP are planned), and each new
 * one is an opportunity to forget the check. `login-access-gate.test.ts` asserts
 * that every `createSession` call site in the auth router is guarded by it.
 *
 * Authentication is not entitlement: the IdP or the passkey proves *who* they are,
 * this decides whether that identity may currently use the cluster. Admins are
 * exempt, per the standing invariant that an expiry can never lock out an admin.
 */
export function loginRefusal(user: AccessSubject & { accessExpiresAt: Date | null }, now: Date = new Date()): AccessRefusal | null {
  if (!isAccessExpired(user, now)) return null;
  return { code: ACCESS_EXPIRED_CODE, error: accessExpiredMessage(user.accessExpiresAt) };
}
