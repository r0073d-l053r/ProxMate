import { describe, it, expect, vi } from 'vitest';

// proxmox.service → config.service → prisma constructs a client at import; stub it.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { getNodesHealth } from '../src/services/proxmox.service.js';
import { fakeClient, asClient, GB } from './helpers.js';

describe('getNodesHealth (per-node + quorum)', () => {
  it('merges /cluster/status quorum with /cluster/resources per-node load', async () => {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/cluster/status') {
        return Promise.resolve({
          data: {
            data: [
              { type: 'cluster', name: 'homelab', quorate: 1, nodes: 3 },
              { type: 'node', name: 'pve-1', online: 1 },
              { type: 'node', name: 'pve-0', online: 1 },
              { type: 'node', name: 'pve-2', online: 0 },
            ],
          },
        });
      }
      // /cluster/resources?type=node — only the online nodes report load.
      return Promise.resolve({
        data: {
          data: [
            { type: 'node', node: 'pve-0', cpu: 0.3, mem: 8 * GB, maxmem: 32 * GB, uptime: 1000 },
            { type: 'node', node: 'pve-1', cpu: 0.6, mem: 16 * GB, maxmem: 32 * GB, uptime: 2000 },
          ],
        },
      });
    });

    const h = await getNodesHealth(asClient(c));

    expect(c.get.mock.calls[0]![0]).toBe('/cluster/status');
    expect(c.get.mock.calls[1]![0]).toBe('/cluster/resources?type=node');
    expect(h.quorate).toBe(true);
    expect(h.expected).toBe(3);
    expect(h.online).toBe(2);
    // numeric-aware sort: pve-0, pve-1, pve-2
    expect(h.nodes.map((n) => n.name)).toEqual(['pve-0', 'pve-1', 'pve-2']);
    expect(h.nodes[0]).toMatchObject({ name: 'pve-0', online: true, cpu: 0.3, uptime: 1000 });
    expect(h.nodes[0]!.mem).toEqual({ used: 8 * GB, total: 32 * GB });
    // offline node with no resource entry → safe zeros
    expect(h.nodes[2]).toMatchObject({ name: 'pve-2', online: false, cpu: 0, uptime: 0 });
    expect(h.nodes[2]!.mem).toEqual({ used: 0, total: 0 });
  });

  it('falls back to "any node online" for a standalone node (no cluster entry)', async () => {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/cluster/status') {
        return Promise.resolve({ data: { data: [{ type: 'node', name: 'pve', online: 1 }] } });
      }
      return Promise.resolve({
        data: { data: [{ type: 'node', node: 'pve', cpu: 0.1, mem: GB, maxmem: 4 * GB, uptime: 500 }] },
      });
    });

    const h = await getNodesHealth(asClient(c));

    expect(h.quorate).toBe(true); // online > 0
    expect(h.expected).toBe(1);
    expect(h.online).toBe(1);
    expect(h.nodes[0]).toMatchObject({ name: 'pve', online: true, cpu: 0.1 });
  });
});
