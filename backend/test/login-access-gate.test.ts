import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  loginRefusal,
  ACCESS_EXPIRED_CODE,
  ACCESS_EXPIRED_MESSAGE,
} from '../src/services/access.service.js';

/**
 * Regression tests for the compute-access gate on SESSION-MINTING LOGIN PATHS.
 *
 * The window was enforced at `POST /auth/login` and nowhere else: the passwordless
 * passkey verify and the SSO callback both loaded the user and minted a session with
 * no entitlement check, so a suspended tenant signed in cleanly and received a valid
 * cookie — they were only turned away on their next API call, by `requireAuth`.
 *
 * Two layers pin the fix. The first exercises the shared gate itself. The second is a
 * source-level assertion that EVERY `createSession` call in the auth router is guarded,
 * because the real long-term risk is not this bug returning — it is the NEXT login path
 * (SAML and LDAP are both planned) being added without the check.
 */

const EXPIRED = { role: 'user', accessExpiresAt: new Date(Date.now() - 86_400_000) };
const ACTIVE = { role: 'user', accessExpiresAt: new Date(Date.now() + 86_400_000) };
const NEVER = { role: 'user', accessExpiresAt: null };

describe('loginRefusal — the shared entitlement gate', () => {
  it('refuses a lapsed tenant with the machine-readable code the UI keys on', () => {
    const refusal = loginRefusal(EXPIRED);
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe(ACCESS_EXPIRED_CODE);
    // The date-bearing variant, so the tenant is told when it ended rather than just "no".
    expect(refusal?.error).toMatch(/ended on /);
  });

  it('admits a tenant whose window is still open', () => {
    expect(loginRefusal(ACTIVE)).toBeNull();
  });

  it('admits a tenant with no window at all — null means never expires', () => {
    expect(loginRefusal(NEVER)).toBeNull();
  });

  it('never refuses an admin, even with a lapsed date on the row', () => {
    // A promoted tenant keeps the accessExpiresAt from their original invite; an
    // expiry that could lock out the last admin would be unrecoverable without
    // DB surgery, so admins are exempt at every gate.
    expect(loginRefusal({ role: 'admin', accessExpiresAt: new Date(Date.now() - 86_400_000) })).toBeNull();
  });

  it('treats the expiry instant itself as closed, matching isAccessExpired', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    expect(loginRefusal({ role: 'user', accessExpiresAt: at }, at)).not.toBeNull();
    expect(loginRefusal({ role: 'user', accessExpiresAt: at }, new Date(at.getTime() - 1))).toBeNull();
  });

  it('falls back to the undated message when there is no date to quote', () => {
    // Defensive: isAccessExpired can only be true with a date, but the message
    // helper is shared, and a future caller (a manual suspension, say) may not have one.
    expect(ACCESS_EXPIRED_MESSAGE).toMatch(/machines and data are safe/i);
  });
});

describe('every session-minting login path is guarded', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/routes/auth.routes.ts', import.meta.url)),
    'utf8',
  );
  const lines = source.split(/\r?\n/);

  /** Line numbers (0-based) of every call that mints a real session. */
  const mintSites = lines.flatMap((line, i) => (line.includes('createSession(') ? [i] : []));

  it('finds the session-minting sites it expects to police', () => {
    // Password login, 2FA verify, session refresh, register, passkey, SSO.
    // If this count changes, a login path was added or removed — read the next
    // test's failure before adjusting this number.
    expect(mintSites.length).toBeGreaterThanOrEqual(5);
  });

  it('guards each one with loginRefusal, or with a documented reason it needs no gate', () => {
    /**
     * A mint site is acceptable if `loginRefusal` appears in the preceding window of
     * the same handler, OR the site carries an explicit exemption comment saying why
     * the gate does not apply (e.g. refresh, which sits behind requireAuth and has
     * therefore already been gated).
     */
    const WINDOW = 40;
    const unguarded: string[] = [];

    for (const site of mintSites) {
      const start = Math.max(0, site - WINDOW);
      const preceding = lines.slice(start, site).join('\n');
      const guarded = preceding.includes('loginRefusal(');
      const exempt = /no-access-gate:/.test(preceding);
      if (!guarded && !exempt) {
        unguarded.push(`line ${site + 1}: ${lines[site]?.trim()}`);
      }
    }

    expect(
      unguarded,
      'Every createSession() in the auth router must be preceded by a loginRefusal() check, ' +
        'or carry a `no-access-gate: <reason>` comment explaining why it is exempt. ' +
        'A suspended tenant must not be able to obtain a session by ANY login method.',
    ).toEqual([]);
  });
});
