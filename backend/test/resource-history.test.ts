import { describe, it, expect } from 'vitest';
import { aggregateUsage } from '../src/services/resource-history.service.js';

describe('aggregateUsage', () => {
  it('folds samples into per-user averages/peaks, sorted by avg CPU desc', () => {
    const samples = [
      { userId: 'u1', cpu: 0.5, mem: 1000 },
      { userId: 'u1', cpu: 0.7, mem: 3000 },
      { userId: 'u2', cpu: 0.1, mem: 500 },
    ];
    const users = [
      { id: 'u1', email: 'a@x', displayName: 'Alice' },
      { id: 'u2', email: 'b@x', displayName: 'Bob' },
    ];
    const out = aggregateUsage(samples, users);

    expect(out.map((u) => u.userId)).toEqual(['u1', 'u2']); // u1 has the higher avg CPU
    const u1 = out[0]!;
    expect(u1.samples).toBe(2);
    expect(u1.avgCpuPct).toBeCloseTo(60); // (0.5 + 0.7) / 2 * 100
    expect(u1.avgMemBytes).toBe(2000);
    expect(u1.peakMemBytes).toBe(3000);
    expect(u1.displayName).toBe('Alice');
  });

  it('labels samples from a deleted user', () => {
    const out = aggregateUsage([{ userId: 'gone', cpu: 0.2, mem: 100 }], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.displayName).toBe('(deleted user)');
    expect(out[0]!.email).toBe('(deleted user)');
  });
});
