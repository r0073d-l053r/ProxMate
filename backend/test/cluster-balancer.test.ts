import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { planBalance, type BalancerNode, type BalancerVm } from '../src/services/cluster-balancer.service.js';
import { GB } from './helpers.js';

const TOTAL = 100 * GB;

/** A node at a given memory-load fraction (0..1), 100 GB total, amd64 by default. */
function node(name: string, load: number, arch: BalancerNode['arch'] = 'amd64'): BalancerNode {
  return { name, online: true, arch, memUsed: load * TOTAL, memTotal: TOTAL, cpu: 0 };
}

let nextVmid = 100;
function vm(node: string, gb: number, opts: Partial<BalancerVm> = {}): BalancerVm {
  const id = opts.vmId ?? `vm-${nextVmid}`;
  const proxmoxVmId = opts.proxmoxVmId ?? nextVmid++;
  return {
    vmId: id,
    proxmoxVmId,
    name: opts.name ?? id,
    node,
    memBytes: gb * GB,
    running: opts.running ?? true,
    antiAffinity: opts.antiAffinity ?? [],
    excluded: opts.excluded ?? false,
  };
}

describe('planBalance (cluster balancer)', () => {
  it('does nothing when the cluster is already within tolerance', () => {
    const plan = planBalance({
      nodes: [node('pve-a', 0.5), node('pve-b', 0.5)],
      vms: [vm('pve-a', 30), vm('pve-b', 30)],
      thresholdPct: 15,
      maxMoves: 5,
    });
    expect(plan.balanced).toBe(true);
    expect(plan.moves).toHaveLength(0);
    expect(plan.reason).toMatch(/balanced/i);
  });

  it('relocates a guest off the hottest node to even out memory load', () => {
    const plan = planBalance({
      nodes: [node('pve-a', 0.8), node('pve-b', 0.2)],
      vms: [vm('pve-a', 30, { vmId: 'hot-vm' })],
      thresholdPct: 15,
      maxMoves: 5,
    });
    expect(plan.balanced).toBe(false);
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]).toMatchObject({ vmId: 'hot-vm', fromNode: 'pve-a', toNode: 'pve-b' });
    // 80/20 → 50/50 after moving the 30 GB guest.
    expect(plan.currentSpreadPct).toBe(60);
    expect(plan.projectedSpreadPct).toBe(0);
  });

  it('needs at least two online nodes', () => {
    const plan = planBalance({
      nodes: [node('solo', 0.9)],
      vms: [vm('solo', 30)],
      thresholdPct: 15,
      maxMoves: 5,
    });
    expect(plan.balanced).toBe(true);
    expect(plan.moves).toHaveLength(0);
    expect(plan.reason).toMatch(/two online nodes/i);
  });

  it('never migrates across CPU architectures', () => {
    const plan = planBalance({
      nodes: [node('x86', 0.8, 'amd64'), node('pi', 0.2, 'arm64')],
      vms: [vm('x86', 30)],
      thresholdPct: 15,
      maxMoves: 5,
    });
    expect(plan.moves).toHaveLength(0);
    expect(plan.reason).toMatch(/architecture/i);
  });

  it('keeps anti-affinity group members apart', () => {
    const plan = planBalance({
      nodes: [node('pve-a', 0.8), node('pve-b', 0.2)],
      vms: [
        vm('pve-a', 30, { vmId: 'db-1', antiAffinity: ['db'] }),
        vm('pve-b', 10, { vmId: 'db-2', antiAffinity: ['db'] }),
      ],
      thresholdPct: 15,
      maxMoves: 5,
    });
    // Moving db-1 onto pve-b would co-locate it with db-2 → blocked, no other candidate.
    expect(plan.moves).toHaveLength(0);
    expect(plan.reason).toMatch(/anti-affinity/i);
  });

  it('never moves an excluded (pinned) guest, choosing another instead', () => {
    const plan = planBalance({
      nodes: [node('pve-a', 0.8), node('pve-b', 0.2)],
      vms: [
        vm('pve-a', 30, { vmId: 'pinned', excluded: true }),
        vm('pve-a', 30, { vmId: 'movable' }),
      ],
      thresholdPct: 15,
      maxMoves: 5,
    });
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]!.vmId).toBe('movable');
  });

  it('only ever migrates running guests', () => {
    const plan = planBalance({
      nodes: [node('pve-a', 0.8), node('pve-b', 0.2)],
      vms: [vm('pve-a', 30, { running: false })],
      thresholdPct: 15,
      maxMoves: 5,
    });
    expect(plan.moves).toHaveLength(0);
  });

  it('respects the per-run move cap', () => {
    const plan = planBalance({
      nodes: [node('pve-a', 0.9), node('pve-b', 0.1)],
      vms: [
        vm('pve-a', 20, { vmId: 'a1' }),
        vm('pve-a', 20, { vmId: 'a2' }),
      ],
      thresholdPct: 15,
      maxMoves: 1,
    });
    expect(plan.moves).toHaveLength(1);
    // One move (90/10 → 70/30) leaves a 40-pt spread, still above the 15% tolerance.
    expect(plan.projectedSpreadPct).toBeGreaterThan(15);
  });

  it('treats unknown-arch nodes as compatible (fail-open)', () => {
    const plan = planBalance({
      nodes: [node('pve-a', 0.8, 'unknown'), node('pve-b', 0.2, 'amd64')],
      vms: [vm('pve-a', 30, { vmId: 'u1' })],
      thresholdPct: 15,
      maxMoves: 5,
    });
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]!.vmId).toBe('u1');
  });
});
