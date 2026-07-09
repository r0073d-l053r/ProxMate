import { describe, it, expect, vi, beforeEach } from 'vitest';

// Orchestrator-level test for the node-drain migratability guard: planNodeDrain
// asks Proxmox (the migrate preflight, via pve.migratableTargets) which nodes
// each managed guest can actually move to, and never proposes evacuating a guest
// whose disks live on node-local storage no other node has.
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { findMany: vi.fn() } },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getNodesHealth: vi.fn(),
  getNodeArchMap: vi.fn(),
  getClient: vi.fn(),
  migratableTargets: vi.fn(),
}));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { planNodeDrain } from '../src/services/cluster-balancer.service.js';
import { fakeClient, asClient, GB } from './helpers.js';

const findMany = vi.mocked(prisma.virtualMachine.findMany);
const getNodesHealth = vi.mocked(pve.getNodesHealth);
const getNodeArchMap = vi.mocked(pve.getNodeArchMap);
const migratableTargets = vi.mocked(pve.migratableTargets);
const TOTAL = 100 * GB;

function threeNodesHealth() {
  return {
    quorate: true,
    expected: 3,
    online: 3,
    nodes: [
      { name: 'pve-a', online: true, cpu: 0, mem: { used: 0.1 * TOTAL, total: TOTAL }, uptime: 1 },
      { name: 'pve-b', online: true, cpu: 0, mem: { used: 0, total: TOTAL }, uptime: 1 },
      { name: 'pve-c', online: true, cpu: 0, mem: { used: 0, total: TOTAL }, uptime: 1 },
    ],
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  getNodeArchMap.mockResolvedValue(
    new Map([['pve-a', 'amd64'], ['pve-b', 'amd64'], ['pve-c', 'amd64']]) as never,
  );
});

describe('planNodeDrain honors the migrate preflight (storage locality)', () => {
  it('blocks a guest whose disks are on node-local storage no other node has', async () => {
    getNodesHealth.mockResolvedValue(threeNodesHealth());
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: { data: [{ type: 'qemu', vmid: 100, node: 'pve-a', status: 'running', mem: 4 * GB }] },
    });
    findMany.mockResolvedValue([
      { id: 'vm1', proxmoxVmId: 100, name: 'zfs-local', proxmoxNode: 'pve-a', tags: null, type: 'qemu', hasPassthrough: false },
    ] as never);
    // Preflight reports an empty allow-list — disks live on a local pool (e.g. a
    // ZFS `tank`) that no other node has, so the guest can't be evacuated at all.
    migratableTargets.mockResolvedValue([]);

    const plan = await planNodeDrain('pve-a', undefined, asClient(c));

    expect(migratableTargets).toHaveBeenCalledWith('pve-a', 100, expect.anything());
    expect(plan.ok).toBe(false);
    expect(plan.moves).toHaveLength(0);
    expect(plan.blockers.some((b) => b.proxmoxVmId === 100 && /node-local storage/i.test(b.reason))).toBe(true);
  });

  it('evacuates a guest the preflight says has a valid target', async () => {
    getNodesHealth.mockResolvedValue(threeNodesHealth());
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: { data: [{ type: 'qemu', vmid: 101, node: 'pve-a', status: 'running', mem: 4 * GB }] },
    });
    findMany.mockResolvedValue([
      { id: 'vm2', proxmoxVmId: 101, name: 'shared', proxmoxNode: 'pve-a', tags: null, type: 'qemu', hasPassthrough: false },
    ] as never);
    migratableTargets.mockResolvedValue(['pve-b', 'pve-c']);

    const plan = await planNodeDrain('pve-a', undefined, asClient(c));

    expect(plan.ok).toBe(true);
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]!.proxmoxVmId).toBe(101);
    expect(['pve-b', 'pve-c']).toContain(plan.moves[0]!.toNode);
  });

  it('fails open when the preflight is unavailable (null)', async () => {
    getNodesHealth.mockResolvedValue(threeNodesHealth());
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: { data: [{ type: 'qemu', vmid: 102, node: 'pve-a', status: 'running', mem: 4 * GB }] },
    });
    findMany.mockResolvedValue([
      { id: 'vm3', proxmoxVmId: 102, name: 'unknown', proxmoxNode: 'pve-a', tags: null, type: 'qemu', hasPassthrough: false },
    ] as never);
    migratableTargets.mockResolvedValue(null); // preflight couldn't be read → don't block

    const plan = await planNodeDrain('pve-a', undefined, asClient(c));

    expect(plan.ok).toBe(true);
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]!.proxmoxVmId).toBe(102);
  });
});
