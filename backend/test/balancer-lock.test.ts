import { describe, it, expect, vi, beforeEach } from 'vitest';

// The balancer (manual apply, auto mode) and node drain never move a machine that
// is locked because the IDE is installing or cloud-init is still deploying.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { findMany: vi.fn(), findUnique: vi.fn() } },
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/proxmox.service.js')>()),
  getNodesHealth: vi.fn(),
  getNodeArchMap: vi.fn(),
  getClient: vi.fn(),
  migratableTargets: vi.fn(async () => ['pve-b']),
}));
vi.mock('../src/services/vm.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/vm.service.js')>()),
  migrateVmToNode: vi.fn(async () => ({})),
}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { migrateVmToNode, guestMarker } from '../src/services/vm.service.js';
import { runMigrations, planNodeDrain } from '../src/services/cluster-balancer.service.js';
import { fakeClient, asClient, GB } from './helpers.js';

const row = (id: string, vmid: number, over: Record<string, unknown> = {}) => ({
  id, proxmoxVmId: vmid, name: id, proxmoxNode: 'pve-a', tags: null, type: 'qemu', hasPassthrough: false,
  ideState: null, deployState: null, ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('runMigrations', () => {
  it('skips a locked machine and still moves the rest', async () => {
    vi.mocked(prisma.virtualMachine.findUnique).mockImplementation((async ({ where }: { where: { id: string } }) =>
      where.id === 'busy' ? row('busy', 100, { deployState: 'deploying' }) : row('free', 101)) as never);
    const r = await runMigrations([{ vmId: 'busy', toNode: 'pve-b' }, { vmId: 'free', toNode: 'pve-b' }]);
    expect(r.map((x) => [x.vmId, x.ok])).toEqual([['busy', false], ['free', true]]);
    expect(r[0]!.error).toMatch(/cloud-init/);
    expect(migrateVmToNode).toHaveBeenCalledTimes(1);
  });
});

describe('planNodeDrain', () => {
  it('reports a locked guest as a blocker instead of planning to move it', async () => {
    const TOTAL = 100 * GB;
    vi.mocked(pve.getNodesHealth).mockResolvedValue({
      quorate: true, expected: 2, online: 2,
      nodes: [
        { name: 'pve-a', online: true, cpu: 0, mem: { used: 0.1 * TOTAL, total: TOTAL }, uptime: 1 },
        { name: 'pve-b', online: true, cpu: 0, mem: { used: 0, total: TOTAL }, uptime: 1 },
      ],
    } as never);
    vi.mocked(pve.getNodeArchMap).mockResolvedValue(new Map([['pve-a', 'amd64'], ['pve-b', 'amd64']]) as never);
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: { data: [{ type: 'qemu', vmid: 100, node: 'pve-a', status: 'running', mem: 4 * GB, tags: guestMarker('ide') }] },
    });
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([row('ide', 100, { ideState: 'installing' })] as never);

    const plan = await planNodeDrain('pve-a', undefined, asClient(c));
    expect(plan.moves).toHaveLength(0);
    expect(plan.blockers.some((b) => b.proxmoxVmId === 100 && /IDE is installing/.test(b.reason))).toBe(true);
  });
});
