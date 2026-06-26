import { describe, it, expect, vi } from 'vitest';

// auth.service derives the signing key via config.service.getConfig('jwt_secret').
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (k: string) => (k === 'jwt_secret' ? 'test-secret-for-enrollment' : null)),
}));

import {
  signEnrollment,
  verifyEnrollment,
  signChallenge,
  verifyChallenge,
} from '../src/services/auth.service.js';

describe('enrollment token', () => {
  it('round-trips: verifyEnrollment returns the userId', async () => {
    const t = await signEnrollment('user-1');
    expect(await verifyEnrollment(t)).toBe('user-1');
  });

  it('verifyEnrollment rejects a non-enrollment (2FA login challenge) token', async () => {
    const challenge = await signChallenge('user-1');
    expect(await verifyEnrollment(challenge)).toBeNull();
  });

  it('verifyChallenge rejects an enrollment token — no cross-use between the two scopes', async () => {
    const enroll = await signEnrollment('user-1');
    expect(await verifyChallenge(enroll)).toBeNull();
  });

  it('verifyEnrollment rejects garbage', async () => {
    expect(await verifyEnrollment('not-a-jwt')).toBeNull();
  });
});
