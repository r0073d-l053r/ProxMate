import { describe, it, expect } from 'vitest';
import {
  isAccessExpired,
  accessExpiryFrom,
  daysUntilExpiry,
  isAccessDuration,
  ACCESS_DURATIONS,
} from '../src/services/access.service.js';

const NOW = new Date('2026-07-01T12:00:00.000Z');
const past = new Date(NOW.getTime() - 1000);
const future = new Date(NOW.getTime() + 86_400_000);

describe('isAccessExpired', () => {
  it('NULL means never expires — the default for every pre-existing account', () => {
    expect(isAccessExpired({ role: 'user', accessExpiresAt: null }, NOW)).toBe(false);
    expect(isAccessExpired({ role: 'user' }, NOW)).toBe(false);
  });

  it('expires a tenant whose window has closed', () => {
    expect(isAccessExpired({ role: 'user', accessExpiresAt: past }, NOW)).toBe(true);
  });

  it('leaves a tenant inside their window alone', () => {
    expect(isAccessExpired({ role: 'user', accessExpiresAt: future }, NOW)).toBe(false);
  });

  it('treats the exact expiry instant as expired (boundary is inclusive)', () => {
    // Must match the sweep's `accessExpiresAt: { lte: now }` exactly, or a user
    // could be refused at the door but never actually suspended.
    expect(isAccessExpired({ role: 'user', accessExpiresAt: new Date(NOW) }, NOW)).toBe(true);
  });

  it('NEVER expires an admin, even with a past date on the row', () => {
    // A tenant promoted to admin keeps the accessExpiresAt from their invite.
    // Expiring them could lock the last admin out with no way back in.
    expect(isAccessExpired({ role: 'admin', accessExpiresAt: past }, NOW)).toBe(false);
  });
});

describe('accessExpiryFrom', () => {
  it('maps never/null/undefined to no expiry', () => {
    expect(accessExpiryFrom('never', NOW)).toBeNull();
    expect(accessExpiryFrom(null, NOW)).toBeNull();
    expect(accessExpiryFrom(undefined, NOW)).toBeNull();
  });

  it('adds fixed-length days (DST- and timezone-immune)', () => {
    expect(accessExpiryFrom('30d', NOW)!.toISOString()).toBe('2026-07-31T12:00:00.000Z');
    expect(accessExpiryFrom('365d', NOW)!.getTime()).toBe(NOW.getTime() + 365 * 86_400_000);
  });

  it('anchors to the moment of redemption, not invite creation', () => {
    const redeemedLater = new Date(NOW.getTime() + 7 * 86_400_000);
    // A 30-day invite opened a week late still grants a full 30 days.
    expect(accessExpiryFrom('30d', redeemedLater)!.getTime() - redeemedLater.getTime()).toBe(30 * 86_400_000);
  });

  it('THROWS on an unrecognised duration rather than granting unlimited access', () => {
    expect(() => accessExpiryFrom('forever' as string, NOW)).toThrow(/Invalid access duration/);
    expect(() => accessExpiryFrom('30' as string, NOW)).toThrow();
    expect(() => accessExpiryFrom('9999d' as string, NOW)).toThrow();
  });

  it('accepts every duration the UI offers', () => {
    for (const d of ACCESS_DURATIONS) expect(() => accessExpiryFrom(d, NOW)).not.toThrow();
  });
});

describe('daysUntilExpiry', () => {
  it('is null when access never expires, and for admins', () => {
    expect(daysUntilExpiry({ role: 'user', accessExpiresAt: null }, NOW)).toBeNull();
    expect(daysUntilExpiry({ role: 'admin', accessExpiresAt: future }, NOW)).toBeNull();
  });

  it('counts whole days remaining, and goes negative once lapsed', () => {
    expect(daysUntilExpiry({ role: 'user', accessExpiresAt: new Date(NOW.getTime() + 7 * 86_400_000) }, NOW)).toBe(7);
    expect(daysUntilExpiry({ role: 'user', accessExpiresAt: new Date(NOW.getTime() - 2 * 86_400_000) }, NOW)).toBe(-2);
  });
});

describe('isAccessDuration', () => {
  it('guards the API surface', () => {
    expect(isAccessDuration('never')).toBe(true);
    expect(isAccessDuration('30d')).toBe(true);
    expect(isAccessDuration('31d')).toBe(false);
    expect(isAccessDuration(null)).toBe(false);
    expect(isAccessDuration(30)).toBe(false);
  });
});
