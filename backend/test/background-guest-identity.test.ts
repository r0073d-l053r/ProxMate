import { describe, it, expect, vi, beforeEach } from 'vitest';

// Background jobs that act on (or report about) guests by VMID must skip a row
// whose VMID holds a guest without that row's ProxMate tag.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn() },
    alertRule: { findMany: vi.fn(), update: vi.fn(async () => ({})) },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getNodesHealth: vi.fn(),
    getNodeArchMap: vi.fn(),
    getClient: vi.fn(),
    migratableTargets: vi.fn(),
  };
});
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(async () => null) }));
vi.mock('../src/services/mail.service.js', () => ({ isMailConfigured: vi.fn(async () => false), sendMail: vi.fn() }));
vi.mock('../src/services/notify.service.js', () => ({ notifyWebhook: vi.fn(async () => undefined), notify: vi.fn() }));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { computeClusterPlan, planNodeDrain } from '../src/services/cluster-balancer.service.js';
import { evaluateAlerts } from '../src/services/alert.service.js';
import { notifyWebhook } from '../src/services/notify.service.js';
import { fakeClient, asClient, GB } from './helpers.js';

const TOTAL = 100 * GB;
const health = (a: number, b: number) =>
  ({
    quorate: true,
    expected: 2,
    online: 2,
    nodes: [
      { name: 'pve-a', online: true, cpu: 0, mem: { used: a * TOTAL, total: TOTAL }, uptime: 1 },
      { name: 'pve-b', online: true, cpu: 0, mem: { used: b * TOTAL, total: TOTAL }, uptime: 1 },
    ],
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pve.getNodeArchMap).mockResolvedValue(new Map([['pve-a', 'amd64'], ['pve-b', 'amd64']]) as never);
  vi.mocked(pve.migratableTargets).mockResolvedValue(['pve-a', 'pve-b']);
});

const ROWS = [
  { id: 'mine', proxmoxVmId: 100, name: 'web', proxmoxNode: 'pve-a', tags: null, type: 'qemu', hasPassthrough: false },
  { id: 'stale', proxmoxVmId: 101, name: 'db', proxmoxNode: 'pve-a', tags: null, type: 'qemu', hasPassthrough: false },
];
const RESOURCES = [
  { type: 'qemu', vmid: 100, node: 'pve-a', status: 'running', mem: 30 * GB, tags: 'proxmate-mine' },
  // VMID 101 now holds a guest that is not the 'stale' row's.
  { type: 'qemu', vmid: 101, node: 'pve-a', status: 'running', mem: 30 * GB, tags: 'proxmate-someoneelse' },
];

describe('balancer', () => {
  it('never plans a move for a row whose VMID holds another guest', async () => {
    vi.mocked(pve.getNodesHealth).mockResolvedValue(health(0.9, 0.1));
    // Only the stale row is a candidate, so any plan move would be moving the other guest.
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([ROWS[1]] as never);
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: [RESOURCES[1]] } });
    const plan = await computeClusterPlan({ mode: 'recommend', thresholdPct: 15, maxMoves: 5, exclude: [] }, asClient(c));
    expect(plan.moves).toHaveLength(0);
  });
});

describe('drain', () => {
  it('reports such a guest for manual handling instead of evacuating it as the row', async () => {
    vi.mocked(pve.getNodesHealth).mockResolvedValue(health(0.1, 0.1));
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue(ROWS as never);
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: RESOURCES } });
    const plan = await planNodeDrain('pve-a', undefined, asClient(c));
    expect(plan.moves.some((m) => m.proxmoxVmId === 101)).toBe(false);
    expect(plan.blockers.some((b) => b.proxmoxVmId === 101 && /ownership tag/i.test(b.reason))).toBe(true);
  });
});

describe('alerts', () => {
  it('never alerts on another guest\'s stats', async () => {
    vi.mocked(prisma.alertRule.findMany).mockResolvedValue([
      {
        id: 'a1', metric: 'cpu', threshold: 50, sustainedMin: 0, breachingSince: new Date(0), lastFiredAt: null, enabled: true,
        vm: { id: 'stale', name: 'db', userId: 'u1', proxmoxVmId: 101, proxmoxNode: 'pve-a', status: 'running', type: 'qemu' },
      },
    ] as never);
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: [{ ...RESOURCES[1], cpu: 0.99, maxmem: 1, mem: 1 }] } });
    vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
    const r = await evaluateAlerts();
    expect(r.fired).toBe(0);
    expect(notifyWebhook).not.toHaveBeenCalled();
  });
});
