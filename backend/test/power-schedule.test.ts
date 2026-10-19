import { describe, it, expect } from 'vitest';

// proxmox/vm services pull in prisma at import; stub it (we only test pure cron logic here).
import { vi } from 'vitest';
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { cronMatches, isValidCron } from '../src/services/power-schedule.service.js';

// A fixed reference moment: 2026-06-29 is a Monday; 08:30 local.
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);

describe('cronMatches', () => {
  it('matches an exact minute/hour every day with *', () => {
    expect(cronMatches('30 8 * * *', at(2026, 6, 29, 8, 30))).toBe(true);
    expect(cronMatches('30 8 * * *', at(2026, 6, 29, 8, 31))).toBe(false);
    expect(cronMatches('30 8 * * *', at(2026, 6, 29, 9, 30))).toBe(false);
  });

  it('honors weekday ranges (Mon–Fri)', () => {
    // 2026-06-29 = Monday (in range), 2026-06-28 = Sunday (out of range)
    expect(cronMatches('0 8 * * 1-5', at(2026, 6, 29, 8, 0))).toBe(true);
    expect(cronMatches('0 8 * * 1-5', at(2026, 6, 28, 8, 0))).toBe(false);
  });

  it('honors weekday lists and 0-or-7 = Sunday', () => {
    expect(cronMatches('0 0 * * 0,6', at(2026, 6, 28, 0, 0))).toBe(true); // Sunday via 0
    expect(cronMatches('0 0 * * 7', at(2026, 6, 28, 0, 0))).toBe(true); // Sunday via 7
    expect(cronMatches('0 0 * * 6', at(2026, 6, 28, 0, 0))).toBe(false); // Sat ≠ Sun
  });

  it('supports step values', () => {
    expect(cronMatches('*/15 * * * *', at(2026, 6, 29, 10, 30))).toBe(true);
    expect(cronMatches('*/15 * * * *', at(2026, 6, 29, 10, 31))).toBe(false);
  });

  it('rejects malformed expressions', () => {
    expect(cronMatches('30 8 * *', at(2026, 6, 29, 8, 30))).toBe(false); // 4 fields
  });
});

describe('isValidCron', () => {
  it('accepts the shapes the UI generates', () => {
    expect(isValidCron('0 8 * * 1-5')).toBe(true);
    expect(isValidCron('30 23 * * *')).toBe(true);
    expect(isValidCron('0 0 * * 0,6')).toBe(true);
  });

  it('rejects bad field counts, out-of-range values, and names', () => {
    expect(isValidCron('0 8 * *')).toBe(false);
    expect(isValidCron('99 8 * * *')).toBe(false); // minute > 59
    expect(isValidCron('0 25 * * *')).toBe(false); // hour > 23
    expect(isValidCron('0 8 * * mon')).toBe(false); // names unsupported
  });

  it('rejects empty list items, out-of-range list members and malformed ranges or steps', () => {
    expect(isValidCron('0 1,,2 * * *')).toBe(false);
    expect(isValidCron('0 1, * * *')).toBe(false);
    expect(isValidCron('0 1,99 * * *')).toBe(false);
    expect(isValidCron('0 5-2 * * *')).toBe(false);
    expect(isValidCron('0 1- * * *')).toBe(false);
    expect(isValidCron('*/0 * * * *')).toBe(false);
    expect(isValidCron('*/ * * * *')).toBe(false);
    expect(isValidCron('0 1/2/3 * * *')).toBe(false);
    expect(isValidCron('*/15 0-6/2 1,15 1-12 1-5')).toBe(true);
  });

  it('a malformed field never matches, even at a value an earlier list item names', () => {
    expect(cronMatches('0 1,,2 * * *', new Date(2026, 0, 5, 1, 0))).toBe(false);
    expect(cronMatches('0 1,99 * * *', new Date(2026, 0, 5, 1, 0))).toBe(false);
  });

  it('an empty list item never matches as 0', () => {
    expect(cronMatches('0 1,,2 * * *', new Date(2026, 0, 5, 0, 0))).toBe(false);
  });
});
