import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    passthroughRequest: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    virtualMachine: { update: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(),
  listPciMappings: vi.fn(),
  getVmStatus: vi.fn(),
  stopVm: vi.fn(),
  attachPci: vi.fn(),
  detachPci: vi.fn(),
  getVmConfig: vi.fn(),
  getPassthroughDevices: vi.fn(),
}));
vi.mock('../src/services/vm.service.js', () => ({ syncVmNode: vi.fn() }));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { syncVmNode } from '../src/services/vm.service.js';
import {
  createPassthroughRequest,
  approvePassthroughRequest,
  denyPassthroughRequest,
  detachPassthrough,
} from '../src/services/passthrough-request.service.js';

const prFindFirst = vi.mocked(prisma.passthroughRequest.findFirst);
const prCreate = vi.mocked(prisma.passthroughRequest.create);
const prFindUnique = vi.mocked(prisma.passthroughRequest.findUnique);
const prUpdate = vi.mocked(prisma.passthroughRequest.update);
const vmUpdate = vi.mocked(prisma.virtualMachine.update);
const tx = vi.mocked(prisma.$transaction);
const getClient = vi.mocked(pve.getClient);
const listMappings = vi.mocked(pve.listPciMappings);
const getVmStatus = vi.mocked(pve.getVmStatus);
const stopVm = vi.mocked(pve.stopVm);
const attachPci = vi.mocked(pve.attachPci);
const detachPci = vi.mocked(pve.detachPci);
const getVmConfig = vi.mocked(pve.getVmConfig);
const getDevices = vi.mocked(pve.getPassthroughDevices);
const syncNode = vi.mocked(syncVmNode);

const qemuVm = (over: Record<string, unknown> = {}) =>
  ({ id: 'vm1', type: 'qemu', hasPassthrough: false, name: 'web', proxmoxNode: 'pve-0', proxmoxVmId: 100, ...over }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  getClient.mockResolvedValue({} as never);
  tx.mockResolvedValue([] as never);
  prCreate.mockResolvedValue({} as never);
  prUpdate.mockResolvedValue({} as never);
  vmUpdate.mockResolvedValue({} as never);
  syncNode.mockImplementation(async (vm: never) => vm);
});

describe('createPassthroughRequest', () => {
  it('rejects containers (LXC)', async () => {
    await expect(createPassthroughRequest('u1', qemuVm({ type: 'lxc' }), 'need gpu')).rejects.toMatchObject({ status: 400 });
    expect(prCreate).not.toHaveBeenCalled();
  });

  it('rejects a VM that already has a device attached', async () => {
    await expect(createPassthroughRequest('u1', qemuVm({ hasPassthrough: true }))).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a second pending request for the same VM', async () => {
    prFindFirst.mockResolvedValue({ id: 'x' } as never);
    await expect(createPassthroughRequest('u1', qemuVm())).rejects.toMatchObject({ status: 409 });
    expect(prCreate).not.toHaveBeenCalled();
  });

  it('creates when clean (trims the reason)', async () => {
    prFindFirst.mockResolvedValue(null as never);
    await createPassthroughRequest('u1', qemuVm(), '  need a GPU  ');
    expect(prCreate).toHaveBeenCalledWith({ data: { userId: 'u1', vmId: 'vm1', reason: 'need a GPU' } });
  });
});

describe('approvePassthroughRequest', () => {
  it('404 when the request is missing', async () => {
    prFindUnique.mockResolvedValue(null as never);
    await expect(approvePassthroughRequest('q1', 'admin', 'gpu0')).rejects.toMatchObject({ status: 404 });
  });

  it('409 when already resolved', async () => {
    prFindUnique.mockResolvedValue({ id: 'q1', status: 'approved', vm: qemuVm(), user: {} } as never);
    await expect(approvePassthroughRequest('q1', 'admin', 'gpu0')).rejects.toMatchObject({ status: 409 });
  });

  it('rejects an unknown mapping name', async () => {
    prFindUnique.mockResolvedValue({ id: 'q1', status: 'pending', vm: qemuVm(), user: { email: 'a@b.c' } } as never);
    listMappings.mockResolvedValue([{ id: 'other', nodes: ['pve-0'] }] as never);
    await expect(approvePassthroughRequest('q1', 'admin', 'gpu0')).rejects.toMatchObject({ status: 400 });
    expect(attachPci).not.toHaveBeenCalled();
  });

  it('stops a running VM, attaches hostpci0=mapping, flags the VM and resolves', async () => {
    prFindUnique.mockResolvedValue({ id: 'q1', status: 'pending', vm: qemuVm(), user: { email: 'a@b.c' } } as never);
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-0'] }] as never);
    // First status read = running; waitStopped then sees stopped.
    getVmStatus.mockResolvedValueOnce({ status: 'running' } as never).mockResolvedValue({ status: 'stopped' } as never);

    const r = await approvePassthroughRequest('q1', 'admin', 'gpu0');

    expect(stopVm).toHaveBeenCalledWith('pve-0', 100, expect.anything(), 'qemu');
    expect(attachPci).toHaveBeenCalledWith('pve-0', 100, 0, 'gpu0', expect.anything());
    // VM flagged hasPassthrough + stopped; request resolved approved with the mapping.
    expect(vmUpdate).toHaveBeenCalledWith({ where: { id: 'vm1' }, data: { hasPassthrough: true, status: 'stopped' } });
    expect(prUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'q1' }, data: expect.objectContaining({ status: 'approved', mapping: 'gpu0', resolvedById: 'admin' }) }),
    );
    expect(r).toMatchObject({ mapping: 'gpu0', wasRunning: true });
  });

  it('attaches directly when the VM is already stopped (no stop call)', async () => {
    prFindUnique.mockResolvedValue({ id: 'q1', status: 'pending', vm: qemuVm(), user: { email: 'a@b.c' } } as never);
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-0'] }] as never);
    getVmStatus.mockResolvedValue({ status: 'stopped' } as never);

    const r = await approvePassthroughRequest('q1', 'admin', 'gpu0');
    expect(stopVm).not.toHaveBeenCalled();
    expect(attachPci).toHaveBeenCalledWith('pve-0', 100, 0, 'gpu0', expect.anything());
    expect(vmUpdate).toHaveBeenCalledWith({ where: { id: 'vm1' }, data: { hasPassthrough: true } });
    expect(r.wasRunning).toBe(false);
  });
});

describe('denyPassthroughRequest', () => {
  it('marks the request denied without touching the VM', async () => {
    prFindUnique.mockResolvedValue({ id: 'q1', status: 'pending', vm: { name: 'web' }, user: { email: 'a@b.c' } } as never);
    const r = await denyPassthroughRequest('q1', 'admin');
    expect(prUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'q1' }, data: expect.objectContaining({ status: 'denied', resolvedById: 'admin' }) }),
    );
    expect(vmUpdate).not.toHaveBeenCalled();
    expect(r.vmName).toBe('web');
  });

  it('409 when already resolved', async () => {
    prFindUnique.mockResolvedValue({ id: 'q1', status: 'denied', vm: {}, user: {} } as never);
    await expect(denyPassthroughRequest('q1', 'admin')).rejects.toMatchObject({ status: 409 });
  });
});

describe('detachPassthrough', () => {
  it('detaches and clears hasPassthrough when no devices remain', async () => {
    getVmStatus.mockResolvedValue({ status: 'stopped' } as never);
    getVmConfig.mockResolvedValue({} as never);
    getDevices.mockReturnValue([]);
    await detachPassthrough(qemuVm({ hasPassthrough: true }), 0);
    expect(detachPci).toHaveBeenCalledWith('pve-0', 100, 0, expect.anything());
    expect(vmUpdate).toHaveBeenCalledWith({ where: { id: 'vm1' }, data: { hasPassthrough: false } });
  });

  it('keeps hasPassthrough true when another device remains', async () => {
    getVmStatus.mockResolvedValue({ status: 'stopped' } as never);
    getVmConfig.mockResolvedValue({ hostpci1: 'mapping=nic' } as never);
    getDevices.mockReturnValue([{ index: 1, slot: 'hostpci1', mapping: 'nic', raw: 'mapping=nic' }]);
    await detachPassthrough(qemuVm({ hasPassthrough: true }), 0);
    expect(vmUpdate).toHaveBeenLastCalledWith({ where: { id: 'vm1' }, data: { hasPassthrough: true } });
  });

  it('rejects containers', async () => {
    await expect(detachPassthrough(qemuVm({ type: 'lxc' }), 0)).rejects.toMatchObject({ status: 400 });
  });
});
