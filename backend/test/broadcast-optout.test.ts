import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// The HMAC key derives from ENCRYPTION_KEY (read lazily per call).
process.env['ENCRYPTION_KEY'] = randomBytes(32).toString('hex');

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { unsubscribeToken, verifyUnsubscribeToken } from '../src/services/broadcast-optout.service.js';

describe('broadcast unsubscribe token', () => {
  it('round-trips: a generated token verifies back to the same user id', () => {
    const token = unsubscribeToken('clx0abcd1234efgh5678');
    expect(verifyUnsubscribeToken(token)).toBe('clx0abcd1234efgh5678');
  });

  it('is deterministic for a user (the link in an old email keeps working)', () => {
    expect(unsubscribeToken('clx0user1aaaa')).toBe(unsubscribeToken('clx0user1aaaa'));
  });

  it('rejects a tampered MAC', () => {
    const token = unsubscribeToken('clx0abcd1234efgh5678');
    const [id, mac] = token.split('.');
    const flipped = (mac![0] === 'a' ? 'b' : 'a') + mac!.slice(1);
    expect(verifyUnsubscribeToken(`${id}.${flipped}`)).toBeNull();
  });

  it("rejects one user's MAC pasted onto another user's id", () => {
    const macOfOther = unsubscribeToken('clx0victim000000').split('.')[1];
    expect(verifyUnsubscribeToken(`clx0attacker0000.${macOfOther}`)).toBeNull();
  });

  it('rejects malformed tokens outright', () => {
    for (const bad of ['', 'no-dot', 'id.', '.mac', 'UPPER.deadbeef', `x.${'f'.repeat(64)}`, 'clx0user1aaaa.zznothex']) {
      expect(verifyUnsubscribeToken(bad)).toBeNull();
    }
  });
});
