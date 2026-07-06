import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    passthroughRequest: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    virtualMachine: { update: vi.fn() },
    user: { findUnique: vi.fn() },
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
  getNodes: vi.fn(),
  getNodeArchMap: vi.fn(),
  pickBestNode: vi.fn(),
  getStorages: vi.fn(),
  getNodeImagesStorages: vi.fn(),
  getVolumeStorages: vi.fn(),
  passthroughBootReadiness: vi.fn(),
  pveMessage: (e: unknown) => (e instanceof Error ? e.message : 'proxmox error'),
}));
vi.mock('../src/services/vm.service.js', () => ({
  syncVmNode: vi.fn(),
  migrateVmToNode: vi.fn(),
  startVm: vi.fn(),
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn() }));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { syncVmNode, migrateVmToNode, startVm } from '../src/services/vm.service.js';
import { getConfig } from '../src/services/config.service.js';
import { recordAudit } from '../src/services/audit.service.js';
import {
  createPassthroughRequest,
  beginPassthroughApproval,
  applyPassthroughApproval,
  denyPassthroughRequest,
  detachPassthrough,
} from '../src/services/passthrough-request.service.js';

const prFindFirst = vi.mocked(prisma.passthroughRequest.findFirst);
const prCreate = vi.mocked(prisma.passthroughRequest.create);
const prFindUnique = vi.mocked(prisma.passthroughRequest.findUnique);
const prUpdate = vi.mocked(prisma.passthroughRequest.update);
const vmUpdate = vi.mocked(prisma.virtualMachine.update);
const userFind = vi.mocked(prisma.user.findUnique);
const tx = vi.mocked(prisma.$transaction);
const getClient = vi.mocked(pve.getClient);
const listMappings = vi.mocked(pve.listPciMappings);
const getVmStatus = vi.mocked(pve.getVmStatus);
const stopVm = vi.mocked(pve.stopVm);
const attachPci = vi.mocked(pve.attachPci);
const detachPci = vi.mocked(pve.detachPci);
const getVmConfig = vi.mocked(pve.getVmConfig);
const getDevices = vi.mocked(pve.getPassthroughDevices);
const getNodes = vi.mocked(pve.getNodes);
const getArchMap = vi.mocked(pve.getNodeArchMap);
const pickBest = vi.mocked(pve.pickBestNode);
const getStorages = vi.mocked(pve.getStorages);
const getImagesStorages = vi.mocked(pve.getNodeImagesStorages);
const getVolStorages = vi.mocked(pve.getVolumeStorages);
const readiness = vi.mocked(pve.passthroughBootReadiness);
const syncNode = vi.mocked(syncVmNode);
const migrate = vi.mocked(migrateVmToNode);
const start = vi.mocked(startVm);
const config = vi.mocked(getConfig);
const audit = vi.mocked(recordAudit);

const GB = 1024 ** 3;

const qemuVm = (over: Record<string, unknown> = {}) =>
  ({ id: 'vm1', userId: 'u1', type: 'qemu', hasPassthrough: false, name: 'web', proxmoxNode: 'pve-0', proxmoxVmId: 100, cpu: 2, ram: 4096, storage: 32, ...over }) as never;

const READY = { q35: true, ovmf: true, efidisk: true, warnings: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getClient.mockResolvedValue({} as never);
  tx.mockResolvedValue([] as never);
  prCreate.mockResolvedValue({} as never);
  prUpdate.mockResolvedValue({} as never);
  vmUpdate.mockResolvedValue({} as never);
  userFind.mockResolvedValue({ id: 'admin', email: 'admin@x' } as never);
  syncNode.mockImplementation(async (vm: never) => vm);
  getNodes.mockResolvedValue([
    { node: 'pve-0', status: 'online' },
    { node: 'pve-4', status: 'online' },
  ] as never);
  getArchMap.mockResolvedValue(new Map([['pve-0', 'amd64'], ['pve-4', 'amd64']]) as never);
  getVmConfig.mockResolvedValue({} as never);
  readiness.mockReturnValue(READY);
  getVolStorages.mockReturnValue([]);
  getStorages.mockResolvedValue([{ storage: 'tank', type: 'zfspool' }] as never);
  getImagesStorages.mockResolvedValue([] as never);
  getVmStatus.mockResolvedValue({ status: 'stopped' } as never);
  config.mockResolvedValue(null);
  migrate.mockImplementation(async (vm: never, target: string) => ({ ...(vm as object), proxmoxNode: target }) as never);
  start.mockResolvedValue(undefined as never);
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

describe('beginPassthroughApproval (validate + plan)', () => {
  const pendingRow = (vmOver: Record<string, unknown> = {}, rowOver: Record<string, unknown> = {}) =>
    ({ id: 'q1', status: 'pending', applyState: null, vm: qemuVm(vmOver), ...rowOver }) as never;

  it('404 when the request is missing', async () => {
    prFindUnique.mockResolvedValue(null as never);
    await expect(beginPassthroughApproval('q1', 'gpu0')).rejects.toMatchObject({ status: 404 });
  });

  it('409 when already resolved / 409 when an apply is in flight', async () => {
    prFindUnique.mockResolvedValue(pendingRow({}, { status: 'approved' }));
    await expect(beginPassthroughApproval('q1', 'gpu0')).rejects.toMatchObject({ status: 409 });
    prFindUnique.mockResolvedValue(pendingRow({}, { applyState: 'migrating' }));
    await expect(beginPassthroughApproval('q1', 'gpu0')).rejects.toMatchObject({ status: 409 });
  });

  it('rejects an unknown mapping name', async () => {
    prFindUnique.mockResolvedValue(pendingRow());
    listMappings.mockResolvedValue([{ id: 'other', nodes: ['pve-0'] }] as never);
    await expect(beginPassthroughApproval('q1', 'gpu0')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a mapping with no per-node device entries', async () => {
    prFindUnique.mockResolvedValue(pendingRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: [] }] as never);
    await expect(beginPassthroughApproval('q1', 'gpu0')).rejects.toMatchObject({ status: 400 });
  });

  it("409 when every node hosting the device is offline", async () => {
    prFindUnique.mockResolvedValue(pendingRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4'] }] as never);
    getNodes.mockResolvedValue([
      { node: 'pve-0', status: 'online' },
      { node: 'pve-4', status: 'offline' },
    ] as never);
    await expect(beginPassthroughApproval('q1', 'gpu0')).rejects.toMatchObject({ status: 409 });
  });

  it('no-op plan when the VM is already on the device node (still queues, carries warnings)', async () => {
    prFindUnique.mockResolvedValue(pendingRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-0'] }] as never);
    readiness.mockReturnValue({ ...READY, q35: false, warnings: ['not q35'] });

    const plan = await beginPassthroughApproval('q1', 'gpu0');
    expect(plan).toMatchObject({ targetNode: 'pve-0', willMigrate: false, bootWarnings: ['not q35'] });
    expect(prUpdate).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { mapping: 'gpu0', targetNode: 'pve-0', applyState: 'queued', applyError: null },
    });
  });

  it('plans a migration to the single device node; no disk relocation when the storage exists there', async () => {
    prFindUnique.mockResolvedValue(pendingRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4'] }] as never);
    getVolStorages.mockReturnValue(['ceph']);
    getImagesStorages.mockResolvedValue([{ storage: 'ceph', type: 'rbd', shared: true, availBytes: 500 * GB }] as never);

    const plan = await beginPassthroughApproval('q1', 'gpu0');
    expect(plan).toMatchObject({ targetNode: 'pve-4', willMigrate: true });
    expect(plan.targetstorage).toBeUndefined();
  });

  it('plans disk relocation when the target lacks the VM storage — prefers the default pool', async () => {
    prFindUnique.mockResolvedValue(pendingRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4'] }] as never);
    getVolStorages.mockReturnValue(['tank']); // node-local, not on pve-4
    getImagesStorages.mockResolvedValue([
      { storage: 'big', type: 'zfspool', shared: false, availBytes: 900 * GB },
      { storage: 'local-zfs', type: 'zfspool', shared: false, availBytes: 200 * GB },
    ] as never);
    config.mockResolvedValue('local-zfs'); // default_storage

    const plan = await beginPassthroughApproval('q1', 'gpu0');
    expect(plan.targetstorage).toBe('local-zfs');
  });

  it('falls back to the most-free images storage when the default is absent on the target', async () => {
    prFindUnique.mockResolvedValue(pendingRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4'] }] as never);
    getVolStorages.mockReturnValue(['tank']);
    getImagesStorages.mockResolvedValue([
      { storage: 'small', type: 'dir', shared: false, availBytes: 100 * GB },
      { storage: 'big', type: 'zfspool', shared: false, availBytes: 900 * GB },
    ] as never);
    config.mockResolvedValue('tank'); // default exists but not on target

    const plan = await beginPassthroughApproval('q1', 'gpu0');
    expect(plan.targetstorage).toBe('big');
  });

  it('409 when the target node has no images-capable storage for relocation', async () => {
    prFindUnique.mockResolvedValue(pendingRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4'] }] as never);
    getVolStorages.mockReturnValue(['tank']);
    getImagesStorages.mockResolvedValue([] as never);
    await expect(beginPassthroughApproval('q1', 'gpu0')).rejects.toMatchObject({ status: 409 });
  });

  it('409 when the chosen relocation storage is too small for the VM', async () => {
    prFindUnique.mockResolvedValue(pendingRow({ storage: 500 })); // needs 500 GB
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4'] }] as never);
    getVolStorages.mockReturnValue(['tank']);
    getImagesStorages.mockResolvedValue([{ storage: 'small', type: 'dir', shared: false, availBytes: 100 * GB }] as never);
    await expect(beginPassthroughApproval('q1', 'gpu0')).rejects.toMatchObject({ status: 409 });
  });

  it('prefers a SAME-TYPE storage for a stopped guest (offline needs format compatibility), even over more space', async () => {
    prFindUnique.mockResolvedValue(pendingRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4'] }] as never);
    getVolStorages.mockReturnValue(['tank']); // zfspool (per getStorages default)
    getImagesStorages.mockResolvedValue([
      { storage: 'huge-nfs', type: 'nfs', shared: true, availBytes: 5000 * GB },
      { storage: 'small-zfs', type: 'zfspool', shared: false, availBytes: 300 * GB },
    ] as never);

    const plan = await beginPassthroughApproval('q1', 'gpu0'); // VM stopped (default)
    expect(plan.targetstorage).toBe('small-zfs');
  });

  it('ignores storage types for a RUNNING guest (live NBD mirror crosses types) — picks the most free', async () => {
    prFindUnique.mockResolvedValue(pendingRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4'] }] as never);
    getVmStatus.mockResolvedValue({ status: 'running' } as never);
    getVolStorages.mockReturnValue(['tank']);
    getImagesStorages.mockResolvedValue([
      { storage: 'huge-nfs', type: 'nfs', shared: true, availBytes: 5000 * GB },
      { storage: 'small-zfs', type: 'zfspool', shared: false, availBytes: 300 * GB },
    ] as never);

    const plan = await beginPassthroughApproval('q1', 'gpu0');
    expect(plan.targetstorage).toBe('huge-nfs');
  });

  it('uses pickBestNode when the mapping spans multiple online nodes', async () => {
    prFindUnique.mockResolvedValue(pendingRow());
    getNodes.mockResolvedValue([
      { node: 'pve-0', status: 'online' },
      { node: 'pve-4', status: 'online' },
      { node: 'pve-5', status: 'online' },
    ] as never);
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4', 'pve-5'] }] as never);
    pickBest.mockResolvedValue('pve-5');
    getVolStorages.mockReturnValue([]);

    const plan = await beginPassthroughApproval('q1', 'gpu0');
    expect(pickBest).toHaveBeenCalledWith(
      { cpu: 2, ramMb: 4096, storageGb: 32 },
      undefined,
      expect.anything(),
      ['pve-4', 'pve-5'],
      'amd64',
    );
    expect(plan.targetNode).toBe('pve-5');
  });
});

describe('applyPassthroughApproval (background worker)', () => {
  const queuedRow = (vmOver: Record<string, unknown> = {}, rowOver: Record<string, unknown> = {}) =>
    ({
      id: 'q1',
      status: 'pending',
      applyState: 'queued',
      mapping: 'gpu0',
      targetNode: 'pve-4',
      user: { email: 'a@b.c' },
      vm: qemuVm(vmOver),
      ...rowOver,
    }) as never;

  it('does nothing unless the row is queued', async () => {
    prFindUnique.mockResolvedValue(queuedRow({}, { applyState: 'failed' }));
    await applyPassthroughApproval('q1', 'admin');
    expect(attachPci).not.toHaveBeenCalled();
  });

  it('LIVE-migrates a running VM with disk relocation, then stops on the target, attaches, resolves, restarts', async () => {
    prFindUnique.mockResolvedValue(queuedRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4'] }] as never);
    getVolStorages.mockReturnValue(['tank']);
    getImagesStorages.mockResolvedValue([{ storage: 'local-zfs', type: 'zfspool', shared: false, availBytes: 200 * GB }] as never);
    config.mockResolvedValue('local-zfs');
    getVmStatus.mockResolvedValueOnce({ status: 'running' } as never).mockResolvedValue({ status: 'stopped' } as never);

    await applyPassthroughApproval('q1', 'admin');

    // Migration comes FIRST and is live (offline:false) — the guest keeps
    // running through the disk copy; downtime is only the attach window.
    expect(migrate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vm1' }),
      'pve-4',
      expect.objectContaining({ offline: false, targetstorage: 'local-zfs', notifyOwner: true, actorId: 'admin' }),
    );
    // The stop happens on the NEW node, after the migration.
    expect(stopVm).toHaveBeenCalledWith('pve-4', 100, expect.anything(), 'qemu');
    expect(attachPci).toHaveBeenCalledWith('pve-4', 100, 0, 'gpu0', expect.anything(), { pcie: true });
    expect(tx).toHaveBeenCalled(); // hasPassthrough + approved/done
    expect(start).toHaveBeenCalled(); // was running → restarted
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'passthrough.approve' }));
  }, 15_000);

  it('skips migration when the VM is already on the target node', async () => {
    prFindUnique.mockResolvedValue(queuedRow({ proxmoxNode: 'pve-4' }));
    getVmStatus.mockResolvedValue({ status: 'stopped' } as never);

    await applyPassthroughApproval('q1', 'admin');
    expect(migrate).not.toHaveBeenCalled();
    expect(attachPci).toHaveBeenCalledWith('pve-4', 100, 0, 'gpu0', expect.anything(), { pcie: true });
    expect(start).not.toHaveBeenCalled(); // wasn't running
  });

  it('attaches WITHOUT pcie on a non-q35 machine', async () => {
    prFindUnique.mockResolvedValue(queuedRow({ proxmoxNode: 'pve-4' }));
    getVmStatus.mockResolvedValue({ status: 'stopped' } as never);
    readiness.mockReturnValue({ q35: false, ovmf: false, efidisk: false, warnings: ['not q35'] });

    await applyPassthroughApproval('q1', 'admin');
    expect(attachPci).toHaveBeenCalledWith('pve-4', 100, 0, 'gpu0', expect.anything(), { pcie: false });
  });

  it('a live-migration failure marks failed with the reason and leaves the still-running VM alone', async () => {
    prFindUnique.mockResolvedValue(queuedRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4'] }] as never);
    getVolStorages.mockReturnValue([]);
    getVmStatus.mockResolvedValue({ status: 'running' } as never);
    migrate.mockRejectedValue(new Error('storage copy failed'));

    await applyPassthroughApproval('q1', 'admin');

    // Migration is first now — the guest was never stopped, so no restart.
    expect(stopVm).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(attachPci).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
    expect(prUpdate).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { applyState: 'failed', applyError: 'storage copy failed' },
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'passthrough.apply_failed' }));
  });

  it('an attach failure AFTER migration restarts the VM on the target (bootable, no device, retryable)', async () => {
    prFindUnique.mockResolvedValue(queuedRow());
    listMappings.mockResolvedValue([{ id: 'gpu0', nodes: ['pve-4'] }] as never);
    getVolStorages.mockReturnValue([]);
    getVmStatus.mockResolvedValueOnce({ status: 'running' } as never).mockResolvedValue({ status: 'stopped' } as never);
    attachPci.mockRejectedValue(new Error('hostpci rejected'));

    await applyPassthroughApproval('q1', 'admin');

    expect(migrate).toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled(); // hasPassthrough never set
    expect(start).toHaveBeenCalled(); // we stopped it → restarted on the target
    expect(prUpdate).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { applyState: 'failed', applyError: 'hostpci rejected' },
    });
  }, 15_000);
});

describe('denyPassthroughRequest', () => {
  it('marks the request denied without touching the VM', async () => {
    prFindUnique.mockResolvedValue({ id: 'q1', status: 'pending', applyState: null, vm: { name: 'web' }, user: { email: 'a@b.c' } } as never);
    const r = await denyPassthroughRequest('q1', 'admin');
    expect(prUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'q1' }, data: expect.objectContaining({ status: 'denied', resolvedById: 'admin' }) }),
    );
    expect(vmUpdate).not.toHaveBeenCalled();
    expect(r.vmName).toBe('web');
  });

  it('409 when already resolved, and 409 while an apply is in flight', async () => {
    prFindUnique.mockResolvedValue({ id: 'q1', status: 'denied', applyState: null, vm: {}, user: {} } as never);
    await expect(denyPassthroughRequest('q1', 'admin')).rejects.toMatchObject({ status: 409 });
    prFindUnique.mockResolvedValue({ id: 'q1', status: 'pending', applyState: 'attaching', vm: {}, user: {} } as never);
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
