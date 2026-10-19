import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

/**
 * Per-VM guest credential for the ProxMate IDE.
 *
 * The reverse proxy dials the guest at the IP its own guest agent reports, and a
 * guest's root user controls that report. So reaching *some* code-server at that
 * address proves nothing about WHICH VM it belongs to. Each install therefore gets
 * its own random secret, held encrypted here and handed only to that guest, and
 * code-server runs with password auth keyed to it:
 *
 *   - The guest's systemd env sets `HASHED_PASSWORD=<sha256 hex of the secret>`
 *     and code-server runs `--auth password`. A non-argon2 hash selects
 *     code-server's SHA256 mode, where a request is authenticated iff its
 *     `code-server-session` cookie equals that hash string exactly, and a login
 *     POST with the secret as password answers with that same cookie (code-server
 *     4.128.0: src/node/util.ts isCookieValid / handlePasswordValidation).
 *   - Before proxying, the backend proves the guest: it POSTs the secret to the
 *     guest's `/login` and requires the `code-server-session` cookie it gets back
 *     to equal the expected hash. Anything that is not this VM's install (another
 *     VM's code-server, an unrelated LAN service, an old `--auth none` install)
 *     cannot produce it, so the proxy refuses to relay.
 *   - Every proxied request then carries the cookie, injected server-side; the
 *     browser never holds it. Another VM's code-server rejects it.
 *
 * Successful logins do not consume code-server's login rate limit, so the proof
 * costs nothing on a healthy install; results are cached briefly per target.
 */

/** code-server's session cookie name (no `--cookie-suffix` is configured). */
export const IDE_GUEST_COOKIE = 'code-server-session';

/** A fresh guest secret (URL-safe, no shell-special characters). */
export function newIdeGuestSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The value code-server holds as `HASHED_PASSWORD` and expects as its session
 * cookie. Lowercase hex, so it never contains `$argon` (which would switch
 * code-server to argon2 mode) and is safe in a systemd EnvironmentFile.
 */
export function ideGuestCookieValue(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Store (or rotate) the encrypted guest secret for a VM. */
export async function saveIdeGuestSecret(vmId: string, secret: string): Promise<void> {
  const secretEnc = encrypt(secret);
  await prisma.ideGuestSecret.upsert({
    where: { vmId },
    update: { secretEnc },
    create: { vmId, secretEnc },
  });
}

/**
 * The VM's guest secret, or null when none is stored (an install made before
 * guest authentication existed) or it can't be decrypted. Callers fail closed.
 */
export async function loadIdeGuestSecret(vmId: string): Promise<string | null> {
  const row = await prisma.ideGuestSecret.findUnique({ where: { vmId } });
  if (!row) return null;
  try {
    return decrypt(row.secretEnc);
  } catch (err) {
    logger.warn({ vmId, err: (err as Error)?.message }, 'ide: guest secret could not be decrypted');
    return null;
  }
}

function sameString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Pull one cookie's value out of a list of Set-Cookie header lines. */
function setCookieValue(lines: string[], name: string): string | undefined {
  for (const line of lines) {
    const first = line.split(';', 1)[0] ?? '';
    const i = first.indexOf('=');
    if (i === -1 || first.slice(0, i).trim() !== name) continue;
    const raw = first.slice(i + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * Ask the code-server at `target` to prove it holds this VM's secret (see the
 * file header). True only when it answers the login with the expected session
 * cookie; any other answer, or no answer, is false.
 */
export async function proveIdeGuest(target: string, secret: string, timeoutMs = 4000): Promise<boolean> {
  const expected = ideGuestCookieValue(secret);
  try {
    const r = await fetch(new URL('login', target.endsWith('/') ? target : `${target}/`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: secret }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    void r.body?.cancel().catch(() => {});
    const got = setCookieValue(r.headers.getSetCookie(), IDE_GUEST_COOKIE);
    return got !== undefined && sameString(got, expected);
  } catch {
    return false;
  }
}

// Positive proofs only, keyed by vm + target + credential, so a changed IP or a
// re-provision (new secret) always re-proves. Single-process backend, so an
// in-memory map is enough.
const PROOF_TTL_MS = 5 * 60 * 1000;
const proofs = new Map<string, number>();

/** {@link proveIdeGuest}, with a short positive cache for the proxy's hot path. */
export async function ensureIdeGuestProven(vmId: string, target: string, secret: string): Promise<boolean> {
  const key = `${vmId}|${target}|${ideGuestCookieValue(secret)}`;
  const until = proofs.get(key);
  if (until && until > Date.now()) return true;
  const ok = await proveIdeGuest(target, secret);
  if (ok) {
    if (proofs.size > 1000) proofs.clear();
    proofs.set(key, Date.now() + PROOF_TTL_MS);
  } else {
    proofs.delete(key);
  }
  return ok;
}

/** Test hook: forget cached proofs. */
export function clearIdeGuestProofs(): void {
  proofs.clear();
}
