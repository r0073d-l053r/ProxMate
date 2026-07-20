import { describe, it, expect, beforeEach, vi } from 'vitest';

// The grace logic is a single guarded UPDATE — mock prisma and assert the query
// contract, which is where the correctness lives (see retireSessionWithGrace).
// vi.hoisted: the vi.mock factory is hoisted above ordinary const declarations.
const { updateMany } = vi.hoisted(() => ({ updateMany: vi.fn(async () => ({ count: 1 })) }));
vi.mock('../src/lib/prisma.js', () => ({ prisma: { session: { updateMany } } }));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async () => null),
  setConfig: vi.fn(async () => {}),
}));

import { retireSessionWithGrace } from '../src/services/auth.service.js';

type Call = {
  where: { token: string; expiresAt: { gt: Date } };
  data: { expiresAt: Date };
};

beforeEach(() => updateMany.mockClear());

describe('retireSessionWithGrace', () => {
  it('shrinks the old session to a ~90s grace window instead of deleting it', async () => {
    const before = Date.now();
    await retireSessionWithGrace('tok-abc');
    const after = Date.now();

    expect(updateMany).toHaveBeenCalledOnce();
    const call = updateMany.mock.calls[0]![0] as unknown as Call;
    expect(call.where.token).toBe('tok-abc');
    const grace = call.data.expiresAt.getTime();
    expect(grace).toBeGreaterThanOrEqual(before + 90_000);
    expect(grace).toBeLessThanOrEqual(after + 90_000);
  });

  it('is shrink-only: the WHERE clause excludes sessions already expiring sooner', async () => {
    // A session whose expiresAt is already before the grace mark must not be
    // touched (that would EXTEND it). The guard is `expiresAt > grace` using
    // the same instant that is written — assert they are the identical moment.
    await retireSessionWithGrace('tok-abc');
    const call = updateMany.mock.calls[0]![0] as unknown as Call;
    expect(call.where.expiresAt.gt.getTime()).toBe(call.data.expiresAt.getTime());
  });

  it('honors a custom grace window', async () => {
    const before = Date.now();
    await retireSessionWithGrace('tok-abc', 5_000);
    const call = updateMany.mock.calls[0]![0] as unknown as Call;
    expect(call.data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 5_000);
    expect(call.data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});
