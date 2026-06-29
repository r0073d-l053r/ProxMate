import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    apiToken: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import { createApiToken, verifyApiToken, revokeApiToken, isApiToken } from '../src/services/api-token.service.js';

const create = vi.mocked(prisma.apiToken.create);
const findUnique = vi.mocked(prisma.apiToken.findUnique);
const update = vi.mocked(prisma.apiToken.update);
const deleteMany = vi.mocked(prisma.apiToken.deleteMany);

const HEX64 = /^[a-f0-9]{64}$/;

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({} as never);
});

describe('isApiToken', () => {
  it('recognizes the pm_ prefix only', () => {
    expect(isApiToken('pm_abc')).toBe(true);
    expect(isApiToken('eyJhbGci...')).toBe(false);
    expect(isApiToken(undefined)).toBe(false);
    expect(isApiToken(null)).toBe(false);
  });
});

describe('createApiToken', () => {
  it('returns a pm_ secret and stores only its SHA-256 hash + display prefix', async () => {
    create.mockResolvedValue({ id: 't1', name: 'ci', createdAt: new Date() } as never);

    const out = await createApiToken('u1', 'ci');
    expect(out.token.startsWith('pm_')).toBe(true);

    const data = (create.mock.calls[0]![0] as { data: Record<string, string> }).data;
    expect(data.tokenHash).toMatch(HEX64); // a hash, not the raw token
    expect(data.tokenHash).not.toContain(out.token);
    expect(data.prefix).toBe(out.token.slice(0, 11));
    expect(data.userId).toBe('u1');
  });
});

describe('verifyApiToken', () => {
  it('rejects anything without the pm_ prefix without hitting the DB', async () => {
    expect(await verifyApiToken('not-a-token')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns the user and bumps lastUsedAt for a valid token', async () => {
    const user = { id: 'u1', email: 'a@b.c', role: 'user', displayName: 'A' };
    findUnique.mockResolvedValue({ id: 't1', expiresAt: null, user } as never);

    const got = await verifyApiToken('pm_secret');
    expect(got).toEqual(user);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: expect.stringMatching(HEX64) } }),
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't1' } }));
  });

  it('returns null for an unknown or expired token', async () => {
    findUnique.mockResolvedValueOnce(null);
    expect(await verifyApiToken('pm_missing')).toBeNull();

    findUnique.mockResolvedValueOnce({ id: 't2', expiresAt: new Date(Date.now() - 1000), user: {} } as never);
    expect(await verifyApiToken('pm_expired')).toBeNull();
  });
});

describe('revokeApiToken', () => {
  it('is scoped to the owner and reports whether anything was deleted', async () => {
    deleteMany.mockResolvedValueOnce({ count: 1 } as never);
    expect(await revokeApiToken('u1', 't1')).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 't1', userId: 'u1' } });

    deleteMany.mockResolvedValueOnce({ count: 0 } as never);
    expect(await revokeApiToken('u1', 'nope')).toBe(false);
  });
});
