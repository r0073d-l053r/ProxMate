import { describe, it, expect, vi } from 'vitest';

// Mock the seams: the DB and the Proxmox client factory (same recipe as
// resize.test.ts) so the real suspend/resume request-builders and the real
// pauseVm/resumeVm guest-kind gating run against a fake axios.
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { findMany: vi.fn(), update: vi.fn() } },
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import * as pve from '../src/services/proxmox.service.js';
import { pauseVm, resumeVm } from '../src/services/vm.service.js';
import { fakeClient, asClient } from './helpers.js';

const getClient = vi.mocked(pve.getClient);

const vm = (over: Record<string, unknown> = {}) =>
  ({ id: 'db-1', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 120, proxmoxNode: 'pve1', status: 'running', ...over }) as never;

describe('suspendVm / resumeVm (Proxmox request builders)', () => {
  it('POST /nodes/{node}/qemu/{vmid}/status/suspend', async () => {
    const c = fakeClient();
    await pve.suspendVm('pve1', 120, asClient(c));
    expect(c.post.mock.calls[0]![0]).toBe('/nodes/pve1/qemu/120/status/suspend');
  });

  it('POST /nodes/{node}/qemu/{vmid}/status/resume', async () => {
    const c = fakeClient();
    await pve.resumeVm('pve1', 120, asClient(c));
    expect(c.post.mock.calls[0]![0]).toBe('/nodes/pve1/qemu/120/status/resume');
  });
});

describe('pauseVm / resumeVm (service gating)', () => {
  it('pauses a running QEMU VM on its node', async () => {
    const c = fakeClient();
    // syncVmNode reads /cluster/resources to confirm the node.
    c.get.mockResolvedValue({ data: { data: [{ type: 'qemu', vmid: 120, node: 'pve1' }] } });
    getClient.mockResolvedValue(asClient(c));

    await pauseVm(vm());
    expect(c.post.mock.calls.some((call) => call[0] === '/nodes/pve1/qemu/120/status/suspend')).toBe(true);
  });

  it('rejects pausing an LXC container without touching Proxmox', async () => {
    const c = fakeClient();
    getClient.mockResolvedValue(asClient(c));
    await expect(pauseVm(vm({ type: 'lxc' }))).rejects.toThrow(/cannot be paused/i);
    expect(c.post).not.toHaveBeenCalled();
  });

  it('rejects resuming an LXC container without touching Proxmox', async () => {
    const c = fakeClient();
    getClient.mockResolvedValue(asClient(c));
    await expect(resumeVm(vm({ type: 'lxc' }))).rejects.toThrow(/cannot be paused/i);
    expect(c.post).not.toHaveBeenCalled();
  });
});
