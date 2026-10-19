import { describe, it, expect, beforeEach, vi } from 'vitest';

// The cloud-init deploy lock and the pending login password advance from a
// background tick, so a machine nobody opens in the UI (an API-driven deploy)
// still unlocks and gets its password once cloud-init settles or the window closes.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { update: vi.fn(), findUnique: vi.fn(async () => null), findMany: vi.fn() } },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(async () => ({})),
  guestAgentPing: vi.fn(),
  guestExecOutput: vi.fn(),
  getVmConfig: vi.fn(async () => ({})),
  setGuestUserPassword: vi.fn(async () => undefined),
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));

import { prisma } from '../src/lib/prisma.js';
import { guestAgentPing, guestExecOutput, getVmConfig } from '../src/services/proxmox.service.js';
import { guestMarker } from '../src/services/vm.service.js';
import { advanceDeployingVms } from '../src/services/deploy-lock.service.js';

const update = vi.mocked(prisma.virtualMachine.update);
const findMany = vi.mocked(prisma.virtualMachine.findMany);

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({} as never);
  // Each row's VMID holds that row's own guest.
  vi.mocked(getVmConfig).mockResolvedValue({ tags: ['settled', 'running', 'timedout', 'broken', 'ok'].map(guestMarker).join(';') } as never);
});

const row = (id: string, ageMs: number) => ({
  id,
  type: 'qemu',
  proxmoxNode: 'pve-x',
  proxmoxVmId: 100,
  deployState: 'deploying',
  deployStateAt: new Date(Date.now() - ageMs),
  pendingCiPassword: null,
});

describe('advanceDeployingVms', () => {
  it('reads only machines still deploying', async () => {
    findMany.mockResolvedValue([]);
    await advanceDeployingVms();
    expect(findMany).toHaveBeenCalledWith({ where: { deployState: 'deploying' } });
  });

  it('unlocks a settled guest and a timed-out one, leaving a still-running one locked', async () => {
    findMany.mockResolvedValue([row('settled', 1000), row('running', 1000), row('timedout', 60 * 60 * 1000)] as never);
    vi.mocked(guestAgentPing).mockResolvedValue(true);
    vi.mocked(guestExecOutput).mockImplementation(async (_n, _v) => ({ exitcode: 0, stdout: 'status: done', stderr: '' }));
    // The second probe (the "running" row) reports cloud-init still working.
    vi.mocked(guestExecOutput)
      .mockResolvedValueOnce({ exitcode: 0, stdout: 'status: done', stderr: '' })
      .mockResolvedValueOnce({ exitcode: 0, stdout: 'status: running', stderr: '' });

    const r = await advanceDeployingVms();
    expect(r).toEqual({ checked: 3, ready: 2 });
    const readied = update.mock.calls
      .filter((c) => (c[0] as { data: { deployState?: string } }).data.deployState === 'ready')
      .map((c) => (c[0] as { where: { id: string } }).where.id);
    expect(readied.sort()).toEqual(['settled', 'timedout']);
  });

  it('keeps going when one machine fails', async () => {
    findMany.mockResolvedValue([row('broken', 1000), row('ok', 60 * 60 * 1000)] as never);
    vi.mocked(guestAgentPing).mockRejectedValueOnce(new Error('pve down'));
    const r = await advanceDeployingVms();
    expect(r.ready).toBe(1);
  });
});
