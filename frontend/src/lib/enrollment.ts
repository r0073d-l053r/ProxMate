"use client";

/**
 * Holds the short-lived 2FA *enrollment* token in memory only — never persisted.
 * It's handed back by /auth/register or /auth/login for a user who must set up a
 * required second factor before they have a session. Kept in a module variable so
 * it survives client-side navigation (register/login → /setup-2fa) but is dropped
 * on a full reload — which is the point: if a mobile tab is evicted mid-setup,
 * there's nothing to leak, and the user simply re-logs-in to get a fresh one.
 */
let enrollmentToken: string | null = null;

export function setEnrollmentToken(token: string): void {
  enrollmentToken = token;
}

export function getEnrollmentToken(): string | null {
  return enrollmentToken;
}

export function clearEnrollmentToken(): void {
  enrollmentToken = null;
}
