import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { computeClusterPlan, planNodeDrain } from '../src/services/cluster-balancer.service.js';
import { fakeClient, asClient, GB } from './helpers.js';

const findMany = vi.mocked(prisma.virtualMachine.findMany);
const getNodesHealth = vi.mocked(pve.getNodesHealth);
const getNodeArchMap = vi.mocked(pve.getNodeArchMap);
const migratableTargets = vi.mocked(pve.migratableTargets);
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
  // Default: every candidate can migrate cluster-wide (the storage guard is a no-op).
  migratableTargets.mockResolvedValue(['pve-a', 'pve-b']);
});

describe('computeClusterPlan skips VMs with PCI/GPU passthrough', () => {
  it('moves a normal hot VM but never a passthrough VM', async () => {
    getNodesHealth.mockResolvedValue(nodesHealth(0.8, 0.2));
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          { type: 'qemu', vmid: 100, node: 'pve-a', status: 'running', mem: 30 * GB },
          { type: 'qemu', vmid: 101, node: 'pve-a', status: 'running', mem: 30 * GB },
        ],
      },
    });
    findMany.mockResolvedValue([
      { id: 'vm1', proxmoxVmId: 100, name: 'web', proxmoxNode: 'pve-a', tags: null, type: 'qemu', hasPassthrough: false },
      { id: 'vm2', proxmoxVmId: 101, name: 'ml', proxmoxNode: 'pve-a', tags: null, type: 'qemu', hasPassthrough: true },
    ] as never);

    const plan = await computeClusterPlan({ mode: 'recommend', thresholdPct: 15, maxMoves: 5, exclude: [] }, asClient(c));
    expect(plan.moves.some((m) => m.proxmoxVmId === 100)).toBe(true);
    expect(plan.moves.some((m) => m.proxmoxVmId === 101)).toBe(false);
  });
});

describe('planNodeDrain flags passthrough VMs as blockers', () => {
  it('does not evacuate a passthrough VM and marks the plan not-ok', async () => {
    getNodesHealth.mockResolvedValue(nodesHealth(0.1, 0.1));
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: { data: [{ type: 'qemu', vmid: 101, node: 'pve-a', status: 'running', mem: 2 * GB }] },
    });
    findMany.mockResolvedValue([
      { id: 'vm2', proxmoxVmId: 101, name: 'ml', proxmoxNode: 'pve-a', tags: null, type: 'qemu', hasPassthrough: true },
    ] as never);

    const plan = await planNodeDrain('pve-a', undefined, asClient(c));
    expect(plan.ok).toBe(false);
    expect(plan.moves).toHaveLength(0);
    expect(plan.blockers.some((b) => b.proxmoxVmId === 101 && /passthrough/i.test(b.reason))).toBe(true);
  });
});
