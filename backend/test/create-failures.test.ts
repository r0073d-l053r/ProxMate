import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { recordCreateFailure, createFailureFor, resetCreateFailures } from '../src/lib/create-failures.js';

const owner = { id: 'u1', role: 'user' };
const admin = { id: 'a1', role: 'admin' };
const other = { id: 'u2', role: 'user' };

beforeEach(() => resetCreateFailures());
afterEach(() => vi.useRealTimers());

describe('create failure records', () => {
  it("gives the reason to the row's owner and to admins only", () => {
    recordCreateFailure('vm1', 'u1', 'storage full');
    expect(createFailureFor('vm1', owner)).toBe('storage full');
    expect(createFailureFor('vm1', admin)).toBe('storage full');
    expect(createFailureFor('vm1', other)).toBeNull();
    expect(createFailureFor('vm2', owner)).toBeNull();
  });

  it('forgets a failure after an hour', () => {
    vi.useFakeTimers({ now: new Date('2026-10-24T10:00:00Z') });
    recordCreateFailure('vm1', 'u1', 'storage full');
    vi.advanceTimersByTime(59 * 60 * 1000);
    expect(createFailureFor('vm1', owner)).toBe('storage full');
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(createFailureFor('vm1', owner)).toBeNull();
  });

  it('stays bounded, dropping the oldest first', () => {
    for (let i = 0; i < 1001; i++) recordCreateFailure(`vm${i}`, 'u1', `fail ${i}`);
    expect(createFailureFor('vm0', owner)).toBeNull();
    expect(createFailureFor('vm1', owner)).toBe('fail 1');
    expect(createFailureFor('vm1000', owner)).toBe('fail 1000');
  });
});
