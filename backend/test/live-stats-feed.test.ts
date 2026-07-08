import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Response } from 'express';

// live-stats.service only imports getClient from proxmox.service — replace the
// whole module so the SSE fan-out is exercised without the real Proxmox client.
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(),
}));

import { getClient } from '../src/services/proxmox.service.js';
import { addLiveFeedSubscriber } from '../src/services/live-stats.service.js';

const getClientMock = vi.mocked(getClient);

// A minimal SSE-response stand-in: a write spy plus the liveness flags isDead() reads.
function fakeRes() {
  return {
    writableEnded: false,
    destroyed: false,
    writable: true,
    write: vi.fn(),
  } as unknown as Response & { write: ReturnType<typeof vi.fn> };
}

function fakeClientReturning(resources: unknown[]) {
  return { get: vi.fn().mockResolvedValue({ data: { data: resources } }) };
}

describe('live-stats SSE fan-out', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getClientMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('pushes stats to a live subscriber, then prunes it once it dies and stops the feed', async () => {
    const client = fakeClientReturning([{ type: 'qemu', vmid: 100, status: 'running' }]);
    getClientMock.mockResolvedValue(client as never);

    const res = fakeRes();
    addLiveFeedSubscriber(res);

    // First tick (default 1s cadence): the live subscriber gets one data frame.
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(String(res.write.mock.calls[0]?.[0])).toContain('data: ');

    // The client disconnects but its unsubscribe never fires (a missed 'close').
    (res as unknown as { writable: boolean }).writable = false;

    // The next tick prunes the dead subscriber up front — no fetch, and crucially
    // no write to a dead socket.
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledTimes(1);

    // With no subscribers left the loop must stop itself: further ticks do nothing.
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('stops pushing once the last subscriber unsubscribes', async () => {
    const client = fakeClientReturning([{ type: 'lxc', vmid: 200, status: 'running' }]);
    getClientMock.mockResolvedValue(client as never);

    const res = fakeRes();
    const unsubscribe = addLiveFeedSubscriber(res);

    await vi.advanceTimersByTimeAsync(1000);
    expect(res.write.mock.calls.length).toBeGreaterThanOrEqual(1);

    unsubscribe();

    // Timer cleared on the last unsubscribe → no further pushes to this response.
    const writesAtUnsub = res.write.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(res.write.mock.calls.length).toBe(writesAtUnsub);
  });
});
