import { randomBytes } from 'node:crypto';
import { EphemeralStore } from './ephemeral-store.js';

/**
 * Server-side store of issued WebAuthn challenges. The browser's cookie carries
 * only a random handle; the challenge an assertion or attestation is verified
 * against is always the one the server issued, for that ceremony, within the
 * last five minutes, and at most once. Without this, a client could name any
 * challenge it liked, and an authenticator that never advances its signature
 * counter (common for synced passkeys) would make an old assertion reusable.
 *
 * Kept in process memory rather than a table: the backend is a single process,
 * a challenge lives five minutes, and a restart costs at most one retried tap.
 */

export type WebauthnPurpose = 'login' | 'register' | 'kiosk-exit';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const store = new EphemeralStore<{ challenge: string; purpose: WebauthnPurpose; userId: string | null }>(
  CHALLENGE_TTL_MS,
);

/** Remember an issued challenge; returns the opaque handle to put in the cookie. */
export function issueWebauthnChallenge(challenge: string, purpose: WebauthnPurpose, userId: string | null = null): string {
  const handle = randomBytes(24).toString('base64url');
  store.set(handle, { challenge, purpose, userId });
  return handle;
}

/**
 * Spend the challenge behind `handle`. Returns it only when it was issued for
 * this purpose (and, for per-user ceremonies, this user) and has not expired or
 * been used. The entry is removed either way, so each challenge gets one try.
 */
export function takeWebauthnChallenge(
  handle: string | undefined,
  purpose: WebauthnPurpose,
  userId: string | null = null,
): string | null {
  if (!handle) return null;
  const entry = store.take(handle);
  if (!entry || entry.purpose !== purpose || entry.userId !== userId) return null;
  return entry.challenge;
}
