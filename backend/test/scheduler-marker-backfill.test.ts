import { describe, it, expect, vi } from 'vitest';

// The ownership-tag backfill is not one-shot: the scheduler re-runs it (the run
// itself becomes a no-op once a pass completes cleanly) and a failing pass never
// breaks the tick.

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/vm.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vm.service.js')>();
  return { ...actual, runGuestMarkerBackfill: vi.fn() };
});

import { guestMarkerBackfillTick } from '../src/services/scheduler.service.js';
import { runGuestMarkerBackfill } from '../src/services/vm.service.js';

describe('guestMarkerBackfillTick', () => {
  it('runs the backfill on every tick', async () => {
    vi.mocked(runGuestMarkerBackfill).mockResolvedValue({ ran: true, tagged: 1, unmatched: 0, errors: 0 });
    await guestMarkerBackfillTick();
    await guestMarkerBackfillTick();
    expect(runGuestMarkerBackfill).toHaveBeenCalledTimes(2);
  });

  it('survives a failing pass so the next tick can retry', async () => {
    vi.mocked(runGuestMarkerBackfill).mockRejectedValueOnce(new Error('cluster down'));
    await expect(guestMarkerBackfillTick()).resolves.toBeUndefined();
    vi.mocked(runGuestMarkerBackfill).mockResolvedValueOnce({ ran: true, tagged: 0, unmatched: 0, errors: 0 });
    await guestMarkerBackfillTick();
    expect(runGuestMarkerBackfill).toHaveBeenCalledTimes(4);
  });
});
