import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import {
  planBalance,
  planDrain,
  type BalancerNode,
  type BalancerVm,
  type DrainGuest,
} from '../src/services/cluster-balancer.service.js';
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
    ...(opts.allowedNodes !== undefined ? { allowedNodes: opts.allowedNodes } : {}),
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

  it('never proposes a move to a node the guest cannot land on (storage pinning)', () => {
    // The tank/snippet-test case: the only cold node isn't a valid migration
    // target (its disks live on node-local storage no other node has), so even a
    // badly imbalanced cluster must not propose the impossible move.
    const plan = planBalance({
      nodes: [node('pve-a', 0.85), node('pve-b', 0.15)],
      vms: [vm('pve-a', 30, { vmId: 'tank-vm', allowedNodes: [] })],
      thresholdPct: 15,
      maxMoves: 5,
    });
    expect(plan.moves).toHaveLength(0);
  });

  it('still moves a guest when the target is among its allowed nodes', () => {
    const plan = planBalance({
      nodes: [node('pve-a', 0.8), node('pve-b', 0.2)],
      vms: [vm('pve-a', 30, { vmId: 'ok-vm', allowedNodes: ['pve-b'] })],
      thresholdPct: 15,
      maxMoves: 5,
    });
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]).toMatchObject({ vmId: 'ok-vm', toNode: 'pve-b' });
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

let nextGuest = 500;
function guest(gb: number, opts: Partial<DrainGuest> = {}): DrainGuest {
  const proxmoxVmId = opts.proxmoxVmId ?? nextGuest++;
  return {
    vmId: opts.vmId ?? `g-${proxmoxVmId}`,
    proxmoxVmId,
    name: opts.name ?? `g-${proxmoxVmId}`,
    memBytes: gb * GB,
    running: opts.running ?? true,
    antiAffinity: opts.antiAffinity ?? [],
    ...(opts.allowedNodes !== undefined ? { allowedNodes: opts.allowedNodes } : {}),
  };
}

const offline = (name: string): BalancerNode => ({
  name,
  online: false,
  arch: 'amd64',
  memUsed: 0,
  memTotal: TOTAL,
  cpu: 0,
});

describe('planDrain (maintenance node evacuation)', () => {
  it('evacuates every managed guest onto other nodes', () => {
    const plan = planDrain({
      drainNode: 'pve-a',
      targetNode: null,
      nodes: [node('pve-a', 0.5), node('pve-b', 0), node('pve-c', 0)],
      guests: [guest(20, { vmId: 'g1' }), guest(20, { vmId: 'g2' })],
      occupants: [],
    });
    expect(plan.ok).toBe(true);
    expect(plan.blockers).toHaveLength(0);
    expect(plan.moves).toHaveLength(2);
    expect(plan.moves.every((m) => m.fromNode === 'pve-a')).toBe(true);
    expect(plan.moves.every((m) => m.toNode !== 'pve-a')).toBe(true);
  });

  it('pushes everything to one node when a target is named', () => {
    const plan = planDrain({
      drainNode: 'pve-a',
      targetNode: 'pve-c',
      nodes: [node('pve-a', 0.5), node('pve-b', 0), node('pve-c', 0)],
      guests: [guest(20, { vmId: 'g1' }), guest(20, { vmId: 'g2' })],
      occupants: [],
    });
    expect(plan.ok).toBe(true);
    expect(plan.moves.map((m) => m.toNode)).toEqual(['pve-c', 'pve-c']);
  });

  it('spreads anti-affinity group members across receiving nodes', () => {
    const plan = planDrain({
      drainNode: 'pve-a',
      targetNode: null,
      nodes: [node('pve-a', 0.5), node('pve-b', 0), node('pve-c', 0)],
      guests: [
        guest(20, { vmId: 'db1', antiAffinity: ['db'] }),
        guest(20, { vmId: 'db2', antiAffinity: ['db'] }),
      ],
      occupants: [],
    });
    expect(plan.ok).toBe(true);
    const t1 = plan.moves.find((m) => m.vmId === 'db1')!.toNode;
    const t2 = plan.moves.find((m) => m.vmId === 'db2')!.toNode;
    expect(t1).not.toBe(t2);
  });

  it('blocks when there is no other online node to evacuate onto', () => {
    const plan = planDrain({
      drainNode: 'pve-a',
      targetNode: null,
      nodes: [node('pve-a', 0.5), offline('pve-b')],
      guests: [guest(20)],
      occupants: [],
    });
    expect(plan.ok).toBe(false);
    expect(plan.moves).toHaveLength(0);
    expect(plan.blockers).toHaveLength(1);
  });

  it('blocks a guest with no architecture-compatible target', () => {
    const plan = planDrain({
      drainNode: 'pve-a',
      targetNode: null,
      nodes: [node('pve-a', 0.5, 'amd64'), node('pve-b', 0, 'arm64')],
      guests: [guest(20)],
      occupants: [],
    });
    expect(plan.ok).toBe(false);
    expect(plan.moves).toHaveLength(0);
    expect(plan.blockers[0]!.reason).toMatch(/architecture/i);
  });

  it('marks running guests live and stopped guests offline', () => {
    const plan = planDrain({
      drainNode: 'pve-a',
      targetNode: null,
      nodes: [node('pve-a', 0.5), node('pve-b', 0), node('pve-c', 0)],
      guests: [
        guest(20, { vmId: 'run', running: true }),
        guest(20, { vmId: 'stop', running: false }),
      ],
      occupants: [],
    });
    const run = plan.moves.find((m) => m.vmId === 'run')!;
    const stop = plan.moves.find((m) => m.vmId === 'stop')!;
    expect(run.running).toBe(true);
    expect(run.reason).toMatch(/live/i);
    expect(stop.running).toBe(false);
    expect(stop.reason).toMatch(/offline/i);
  });

  it('blocks a guest whose disks are on node-local storage no other node has', () => {
    const plan = planDrain({
      drainNode: 'pve-a',
      targetNode: null,
      // Both other nodes are online and roomy, but the migrate preflight says the
      // guest can go nowhere (empty allow-list) — its disks live on a local pool.
      nodes: [node('pve-a', 0.5), node('pve-b', 0), node('pve-c', 0)],
      guests: [guest(20, { vmId: 'tank', allowedNodes: [] })],
      occupants: [],
    });
    expect(plan.ok).toBe(false);
    expect(plan.moves).toHaveLength(0);
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]!.reason).toMatch(/node-local storage/i);
  });

  it('still evacuates a guest that has a valid allowed target', () => {
    const plan = planDrain({
      drainNode: 'pve-a',
      targetNode: null,
      nodes: [node('pve-a', 0.5), node('pve-b', 0), node('pve-c', 0)],
      // Preflight allows only pve-b (e.g. the only other node with the same pool).
      guests: [guest(20, { vmId: 'pinned-b', allowedNodes: ['pve-b'] })],
      occupants: [],
    });
    expect(plan.ok).toBe(true);
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]).toMatchObject({ vmId: 'pinned-b', toNode: 'pve-b' });
  });

  it('treats an undefined allowedNodes as unconstrained (fail open)', () => {
    const plan = planDrain({
      drainNode: 'pve-a',
      targetNode: null,
      nodes: [node('pve-a', 0.5), node('pve-b', 0)],
      guests: [guest(20, { vmId: 'shared' })], // no allowedNodes → not restricted
      occupants: [],
    });
    expect(plan.ok).toBe(true);
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]!.toNode).toBe('pve-b');
  });

  it('blocks an explicit target the guest is not allowed to migrate to', () => {
    const plan = planDrain({
      drainNode: 'pve-a',
      targetNode: 'pve-c',
      nodes: [node('pve-a', 0.5), node('pve-b', 0), node('pve-c', 0)],
      // Admin forces pve-c, but the guest's disks can only follow it to pve-b.
      guests: [guest(20, { vmId: 'local-b', allowedNodes: ['pve-b'] })],
      occupants: [],
    });
    expect(plan.ok).toBe(false);
    expect(plan.moves).toHaveLength(0);
    expect(plan.blockers[0]!.reason).toMatch(/node-local storage/i);
  });
});
