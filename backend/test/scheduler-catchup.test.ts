import { describe, it, expect, vi, beforeEach } from 'vitest';

// DB + config are mocked; the real cronMatches/previousCronOccurrence run. Keep
// the rest of matestate.service real, but stub the actual backup run.
vi.mock('../src/lib/prisma.js', () => ({ prisma: { virtualMachine: { findMany: vi.fn() } } }));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(), setConfig: vi.fn() }));
vi.mock('../src/services/matestate.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/matestate.service.js')>();
  return { ...actual, runScheduledBackups: vi.fn() };
});

import { previousCronOccurrence } from '../src/services/power-schedule.service.js';
import { catchUpMissedBackups } from '../src/services/scheduler.service.js';
import { runScheduledBackups } from '../src/services/matestate.service.js';
import { getConfig, setConfig } from '../src/services/config.service.js';

const runBackups = vi.mocked(runScheduledBackups);
const getCfg = vi.mocked(getConfig);
const setCfg = vi.mocked(setConfig);

beforeEach(() => {
  vi.clearAllMocks();
  runBackups.mockResolvedValue({ ran: 1, failed: 0 } as never);
  setCfg.mockResolvedValue(undefined as never);
});

describe('previousCronOccurrence', () => {
  it('finds the most recent weekly Sunday 03:00 before a midweek time', () => {
    // 2026-07-01 is a Wednesday; the previous Sun 03:00 is 2026-06-28 03:00.
    const prev = previousCronOccurrence('0 3 * * 0', new Date(2026, 6, 1, 12, 0, 0));
    expect(prev).toEqual(new Date(2026, 5, 28, 3, 0, 0));
  });

  it('returns the current minute when it matches exactly', () => {
    const sun0300 = new Date(2026, 5, 28, 3, 0, 0);
    expect(previousCronOccurrence('0 3 * * 0', sun0300)).toEqual(sun0300);
  });

  it('handles a daily schedule', () => {
    const prev = previousCronOccurrence('0 3 * * *', new Date(2026, 5, 29, 12, 30, 0));
    expect(prev).toEqual(new Date(2026, 5, 29, 3, 0, 0));
  });
});

describe('catchUpMissedBackups', () => {
  const wed = new Date(2026, 6, 1, 12, 0, 0); // most recent window = 2026-06-28 03:00

  it('initializes the marker on first boot without running backups', async () => {
    getCfg.mockResolvedValue(null as never);
    const r = await catchUpMissedBackups(wed);
    expect(runBackups).not.toHaveBeenCalled();
    expect(setCfg).toHaveBeenCalledWith('matestate_last_run', new Date(2026, 5, 28, 3, 0, 0).toISOString());
    expect(r.caughtUp).toBe(false);
  });

  it('catches up when the last run predates the most recent scheduled window', async () => {
    getCfg.mockResolvedValue(new Date(2026, 5, 21, 3, 0, 0).toISOString() as never); // a week earlier
    const r = await catchUpMissedBackups(wed);
    expect(runBackups).toHaveBeenCalledTimes(1);
    expect(r.caughtUp).toBe(true);
  });

  it('does nothing when the last run already covers the most recent window', async () => {
    getCfg.mockResolvedValue(new Date(2026, 5, 28, 3, 5, 0).toISOString() as never); // just after the window
    const r = await catchUpMissedBackups(wed);
    expect(runBackups).not.toHaveBeenCalled();
    expect(r.caughtUp).toBe(false);
  });
});
