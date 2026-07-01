import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB and the Proxmox helpers the orchestrators call, so we can drive
// computeClusterPlan / planNodeDrain from a fixed cluster snapshot.
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { findMany: vi.fn() } },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getNodesHealth: vi.fn(),
  getNodeArchMap: vi.fn(),
  getClient: vi.fn(),
}));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { computeClusterPlan, planNodeDrain } from '../src/services/cluster-balancer.service.js';
import { fakeClient, asClient, GB } from './helpers.js';

const findMany = vi.mocked(prisma.virtualMachine.findMany);
const getNodesHealth = vi.mocked(pve.getNodesHealth);
const getNodeArchMap = vi.mocked(pve.getNodeArchMap);
const TOTAL = 100 * GB;

function nodesHealth(aLoad: number, bLoad: number) {
  return {
    quorate: true,
    expected: 2,
    online: 2,
    nodes: [
      { name: 'pve-a', online: true, cpu: 0, mem: { used: aLoad * TOTAL, total: TOTAL }, uptime: 1 },
      { name: 'pve-b', online: true, cpu: 0, mem: { used: bLoad * TOTAL, total: TOTAL }, uptime: 1 },
    ],
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  getNodeArchMap.mockResolvedValue(new Map([['pve-a', 'amd64'], ['pve-b', 'amd64']]) as never);
});

describe('computeClusterPlan (balancer) skips LXC containers', () => {
  it('moves a hot QEMU VM but never a container, even on the hottest node', async () => {
    getNodesHealth.mockResolvedValue(nodesHealth(0.8, 0.2));
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          { type: 'qemu', vmid: 100, node: 'pve-a', status: 'running', mem: 30 * GB },
          { type: 'lxc', vmid: 200, node: 'pve-a', status: 'running', mem: 30 * GB },
        ],
      },
    });
    findMany.mockResolvedValue([
      { id: 'vm1', proxmoxVmId: 100, name: 'web', proxmoxNode: 'pve-a', tags: null, type: 'qemu' },
      { id: 'ct1', proxmoxVmId: 200, name: 'ct-web', proxmoxNode: 'pve-a', tags: null, type: 'lxc' },
    ] as never);

    const plan = await computeClusterPlan(
      { mode: 'recommend', thresholdPct: 15, maxMoves: 5, exclude: [] },
      asClient(c),
    );

    expect(plan.moves.some((m) => m.proxmoxVmId === 100)).toBe(true);
    expect(plan.moves.some((m) => m.proxmoxVmId === 200)).toBe(false);
  });
});

describe('planNodeDrain flags LXC containers on the drained node', () => {
  it('reports a container as a blocker and marks the plan not-ok', async () => {
    getNodesHealth.mockResolvedValue(nodesHealth(0.1, 0.1));
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: { data: [{ type: 'lxc', vmid: 200, node: 'pve-a', status: 'running', mem: 2 * GB }] },
    });
    findMany.mockResolvedValue([
      { id: 'ct1', proxmoxVmId: 200, name: 'ct-web', proxmoxNode: 'pve-a', tags: null, type: 'lxc' },
    ] as never);

    const plan = await planNodeDrain('pve-a', undefined, asClient(c));

    expect(plan.ok).toBe(false);
    expect(plan.moves).toHaveLength(0);
    expect(plan.blockers.some((b) => b.proxmoxVmId === 200 && /container|lxc/i.test(b.reason))).toBe(true);
  });
});
