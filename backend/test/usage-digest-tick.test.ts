import { describe, it, expect, vi, beforeEach } from 'vitest';

// The scheduler's weekly digest tick runs the digest and never lets a failure
// escape the cron callback.

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(), setConfig: vi.fn() }));
vi.mock('../src/services/usage-digest.service.js', () => ({
  runUsageDigest: vi.fn(),
  DEFAULT_USAGE_DIGEST_CRON: '0 8 * * 1',
}));

import { usageDigestTick } from '../src/services/scheduler.service.js';
import { runUsageDigest } from '../src/services/usage-digest.service.js';

beforeEach(() => vi.clearAllMocks());

describe('usageDigestTick', () => {
  it('runs the digest and logs a skip reason', async () => {
    vi.mocked(runUsageDigest).mockResolvedValue({ ran: false, reason: 'SMTP is not configured', sent: 0, failed: 0 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const now = new Date('2026-10-26T08:00:00Z');
    await usageDigestTick(now);
    expect(runUsageDigest).toHaveBeenCalledWith(now);
    expect(log).toHaveBeenCalledWith('[scheduler] usage digest skipped: SMTP is not configured');
    log.mockRestore();
  });

  it('swallows a failure so the cron callback cannot crash the process', async () => {
    vi.mocked(runUsageDigest).mockRejectedValue(new Error('db gone'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(usageDigestTick()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith('[scheduler] usage-digest tick failed:', expect.any(Error));
    err.mockRestore();
  });
});
