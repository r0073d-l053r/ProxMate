import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { pickBestNode, getClusterStats } from '../src/services/proxmox.service.js';
import { fakeClient, asClient, GB } from './helpers.js';

// Three online nodes with differing headroom. pve-1 has the most free RAM/CPU.
const NODES = [
  { type: 'node', status: 'online', node: 'pve-0', maxcpu: 8, cpu: 0.5, maxmem: 16 * GB, mem: 8 * GB },
  { type: 'node', status: 'online', node: 'pve-1', maxcpu: 8, cpu: 0.1, maxmem: 16 * GB, mem: 2 * GB },
  { type: 'node', status: 'online', node: 'pve-2', maxcpu: 4, cpu: 0.9, maxmem: 8 * GB, mem: 7 * GB },
];

describe('pickBestNode (auto-scheduler)', () => {
  it('picks the node with the most free capacity', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: NODES } });
    const pick = await pickBestNode({ cpu: 2, ramMb: 2048, storageGb: 20 }, undefined, asClient(c));
    expect(pick).toBe('pve-1');
    expect(c.get).toHaveBeenCalledWith('/cluster/resources');
  });

  it('still returns a node when none can fit the request (overcommit, never hard-fails)', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: NODES } });
    const pick = await pickBestNode(
      { cpu: 64, ramMb: 1024 * 1024, storageGb: 99999 },
      undefined,
      asClient(c),
    );
    expect(pick).toBe('pve-1'); // best free-RAM fraction even though nothing fits
  });

  it('excludes offline nodes from placement', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          // would win on capacity, but it's offline → must be ignored
          { type: 'node', status: 'offline', node: 'pve-1', maxcpu: 8, cpu: 0, maxmem: 16 * GB, mem: 0 },
          { type: 'node', status: 'online', node: 'pve-0', maxcpu: 8, cpu: 0.5, maxmem: 16 * GB, mem: 8 * GB },
        ],
      },
    });
    const pick = await pickBestNode({ cpu: 1, ramMb: 1024, storageGb: 10 }, undefined, asClient(c));
    expect(pick).toBe('pve-0');
  });

  it('throws when there are no online nodes', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: { data: [{ type: 'node', status: 'offline', node: 'x', maxcpu: 1, maxmem: GB }] },
    });
    await expect(
      pickBestNode({ cpu: 1, ramMb: 1, storageGb: 1 }, undefined, asClient(c)),
    ).rejects.toThrow(/no online/i);
  });

  it('factors node-local pool free space into the score', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          // identical CPU/RAM; differ only in free pool disk
          { type: 'node', status: 'online', node: 'pve-a', maxcpu: 8, cpu: 0.5, maxmem: 16 * GB, mem: 8 * GB },
          { type: 'node', status: 'online', node: 'pve-b', maxcpu: 8, cpu: 0.5, maxmem: 16 * GB, mem: 8 * GB },
          { type: 'storage', status: 'available', node: 'pve-a', storage: 'local-lvm', maxdisk: 100 * GB, disk: 90 * GB }, // 10 GB free
          { type: 'storage', status: 'available', node: 'pve-b', storage: 'local-lvm', maxdisk: 100 * GB, disk: 10 * GB }, // 90 GB free
        ],
      },
    });
    const pick = await pickBestNode({ cpu: 2, ramMb: 2048, storageGb: 20 }, 'local-lvm', asClient(c));
    expect(pick).toBe('pve-b'); // only pve-b can fit 20 GB → gets the "fits" bonus
  });
});

describe('getClusterStats', () => {
  it('aggregates online-node cpu/mem and counts guests (ignores offline nodes)', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          { type: 'node', status: 'online', node: 'pve-0', maxcpu: 8, cpu: 0.5, maxmem: 16 * GB, mem: 8 * GB },
          { type: 'node', status: 'online', node: 'pve-1', maxcpu: 4, cpu: 0.25, maxmem: 8 * GB, mem: 2 * GB },
          { type: 'node', status: 'offline', node: 'pve-2', maxcpu: 99, cpu: 1, maxmem: 99 * GB, mem: 99 * GB },
          { type: 'qemu', vmid: 100 },
          { type: 'qemu', vmid: 101 },
          { type: 'lxc', vmid: 200 },
        ],
      },
    });
    const stats = await getClusterStats(undefined, asClient(c));
    expect(stats.nodes).toBe(2);
    expect(stats.cpu).toEqual({ total: 12, used: 5 }); // 0.5*8 + 0.25*4 = 5 cores
    expect(stats.memory).toEqual({ total: 24 * GB, used: 10 * GB });
    expect(stats.vmCount).toBe(3);
  });

  it('dedupes shared storage but sums node-local pools', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          { type: 'node', status: 'online', node: 'pve-0', maxcpu: 1, cpu: 0, maxmem: GB, mem: 0 },
          // shared pool appears once per node → must be counted once
          { type: 'storage', storage: 'ceph', shared: 1, node: 'pve-0', maxdisk: 500 * GB, disk: 100 * GB },
          { type: 'storage', storage: 'ceph', shared: 1, node: 'pve-1', maxdisk: 500 * GB, disk: 100 * GB },
        ],
      },
    });
    const stats = await getClusterStats('ceph', asClient(c));
    expect(stats.storage).toEqual({ total: 500 * GB, used: 100 * GB });
  });

  it('sums node-local pools across nodes', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          { type: 'node', status: 'online', node: 'pve-0', maxcpu: 1, cpu: 0, maxmem: GB, mem: 0 },
          { type: 'storage', storage: 'local-lvm', node: 'pve-0', maxdisk: 100 * GB, disk: 20 * GB },
          { type: 'storage', storage: 'local-lvm', node: 'pve-1', maxdisk: 100 * GB, disk: 30 * GB },
        ],
      },
    });
    const stats = await getClusterStats('local-lvm', asClient(c));
    expect(stats.storage).toEqual({ total: 200 * GB, used: 50 * GB });
  });
});
