import { describe, it, expect, vi, beforeEach } from 'vitest';

// Balancer settings fall back to their documented defaults when unset or blank,
// and clamp only values an admin actually stored.

const stored = new Map<string, string>();
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/config.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/config.service.js')>()),
  getConfig: vi.fn(async (key: string) => stored.get(key) ?? null),
}));

import { getBalancerSettings } from '../src/services/cluster-balancer.service.js';

beforeEach(() => stored.clear());

describe('getBalancerSettings', () => {
  it('uses the defaults on a fresh install', async () => {
    expect(await getBalancerSettings()).toEqual({ mode: 'off', thresholdPct: 15, maxMoves: 5, exclude: [] });
  });

  it('treats a blank stored value as unset', async () => {
    stored.set('balancer_threshold', ' ');
    stored.set('balancer_max_moves', '');
    const s = await getBalancerSettings();
    expect(s.thresholdPct).toBe(15);
    expect(s.maxMoves).toBe(5);
  });

  it('clamps stored values into range', async () => {
    stored.set('balancer_threshold', '2');
    stored.set('balancer_max_moves', '99');
    const s = await getBalancerSettings();
    expect(s.thresholdPct).toBe(5);
    expect(s.maxMoves).toBe(20);
  });
});
