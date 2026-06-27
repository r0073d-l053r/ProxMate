import { describe, it, expect } from 'vitest';

// proxmox.service → config.service → prisma constructs a client at import; stub it.
import { vi } from 'vitest';
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { getVmRrdData } from '../src/services/proxmox.service.js';
import { fakeClient, asClient } from './helpers.js';

describe('getVmRrdData (Proxmox RRD store)', () => {
  it('requests the rrddata endpoint with the timeframe + AVERAGE cf', async () => {
    const c = fakeClient();
    const points = [
      { time: 1000, cpu: 0.25, mem: 512, maxmem: 1024 },
      { time: 1060, cpu: 0.5, mem: 768, maxmem: 1024 },
    ];
    c.get.mockResolvedValue({ data: { data: points } });

    const result = await getVmRrdData('pve-1', 101, 'day', asClient(c));

    expect(c.get.mock.calls[0]![0]).toBe('/nodes/pve-1/qemu/101/rrddata');
    expect(c.get.mock.calls[0]![1]).toEqual({ params: { timeframe: 'day', cf: 'AVERAGE' } });
    expect(result).toEqual(points);
  });

  it('defaults to the hour timeframe', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: [] } });
    await getVmRrdData('pve-1', 101, undefined, asClient(c));
    expect(c.get.mock.calls[0]![1]).toEqual({ params: { timeframe: 'hour', cf: 'AVERAGE' } });
  });

  it('returns an empty array when Proxmox sends no data', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: {} });
    expect(await getVmRrdData('pve-1', 101, 'week', asClient(c))).toEqual([]);
  });
});
