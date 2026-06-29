import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same seam-mocking strategy as create-vm / deploy-template: the real
// proxmox.service request-builders run against a fake axios; only the DB, config
// reads, and the client factory are mocked.
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { update: vi.fn(), findMany: vi.fn(), delete: vi.fn() } },
}));
vi.mock('../../src/services/config.service.js', () => ({ getConfig: vi.fn() }));
vi.mock('../../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { prisma } from '../../src/lib/prisma.js';
import { getConfig } from '../../src/services/config.service.js';
import * as pve from '../../src/services/proxmox.service.js';
import { rebuildVm, QuotaError, type RebuildSource } from '../../src/services/vm.service.js';
import { bodyOf, GB } from '../helpers.js';
import type { Template } from '@prisma/client';

const update = vi.mocked(prisma.virtualMachine.update);
const del = vi.mocked(prisma.virtualMachine.delete);
const findMany = vi.mocked(prisma.virtualMachine.findMany);
const getConfigMock = vi.mocked(getConfig);
const getClientMock = vi.mocked(pve.getClient);

const DEFAULTS: Record<string, string> = {
  default_storage: 'local-lvm',
  default_bridge: 'vmbr0',
  iso_storage: 'local',
  isolation_enabled: 'false', // keep tests focused on the rebuild path, not isolation
};

/** Fake Proxmox axios covering both the teardown and the re-provision reads/writes. */
function fakePve() {
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  return {
    get: vi.fn((url: string) => {
      // syncVmNode + pickBestNode + getIsoNodes all read /cluster/resources.
      if (url === '/cluster/resources')
        return ok([
          { type: 'node', status: 'online', node: 'pve-x', maxcpu: 8, cpu: 0.1, maxmem: 32 * GB, mem: 4 * GB },
          { type: 'storage', status: 'available', node: 'pve-x', storage: 'local-lvm', maxdisk: 500 * GB, disk: 50 * GB },
          { type: 'qemu', vmid: 110, node: 'pve-x' },
        ]);
      // The ISO is present on pve-x's `local` storage → pve-x is an eligible node.
      if (/\/nodes\/.+\/storage\/.+\/content/.test(url)) return ok([{ volid: 'local:iso/debian.iso' }]);
      // Already stopped → teardown skips the stop/wait and goes straight to delete.
      if (/\/status\/current$/.test(url)) return ok({ status: 'stopped' });
      // getVmConfig (template autoscale) — a primary disk + a cloud-init cdrom.
      if (/\/qemu\/\d+\/config$/.test(url))
        return ok({ scsi0: 'local-lvm:vm-110-disk-0,size=2G', ide2: 'local-lvm:vm-110-cloudinit,media=cdrom' });
      if (/\/tasks\/.+\/status/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
      return ok(null);
    }),
    post: vi.fn(() => ok('UPID:task')),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => ok('')),
  };
}

const VM = {
  id: 'vm-1',
  userId: 'u1',
  proxmoxVmId: 110,
  proxmoxNode: 'pve-x',
  name: 'box',
  cpu: 2,
  ram: 2048,
  storage: 10,
  os: 'old.iso',
  status: 'running',
} as never;

const admin = { id: 'a1', role: 'admin' } as never;

const TEMPLATE = {
  id: 'tpl-1',
  proxmoxVmId: 100,
  proxmoxNode: 'pve-x',
  diskGb: 2,
  cloudInit: true,
  name: 'Debian 12',
  os: 'Debian 12',
} as unknown as Template;

beforeEach(() => {
  vi.clearAllMocks();
  getConfigMock.mockImplementation(async (k: string) => DEFAULTS[k] ?? null);
  update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...(VM as object), ...data }) as never);
});

describe('rebuildVm — ISO reinstall', () => {
  it('tears down the old VM, recreates into the SAME VMID, and starts it (DB row kept)', async () => {
    const client = fakePve();
    getClientMock.mockResolvedValue(client as never);

    const result = await rebuildVm(admin, VM, { kind: 'iso', os: 'debian.iso' });

    // Teardown deletes the old Proxmox VM but never our DB row.
    expect(client.delete).toHaveBeenCalledWith('/nodes/pve-x/qemu/110');
    expect(del).not.toHaveBeenCalled();

    // Recreated into the same VMID on the ISO-bearing node.
    const createCall = client.post.mock.calls.find((c) => c[0] === '/nodes/pve-x/qemu');
    expect(createCall).toBeDefined();
    expect(bodyOf(createCall!).vmid).toBe('110');

    // The new OS label is persisted, and it ends up running.
    expect(update.mock.calls.some((c) => (c[0] as { data: Record<string, unknown> }).data.os === 'debian.iso')).toBe(true);
    expect(client.post).toHaveBeenCalledWith('/nodes/pve-x/qemu/110/status/start');
    expect(result.status).toBe('running');
  });

  it('marks the VM "error" if re-provisioning fails after teardown', async () => {
    const client = fakePve();
    client.post = vi.fn((url: string) => {
      if (url === '/nodes/pve-x/qemu') return Promise.reject(new Error('pve create failed'));
      return Promise.resolve({ data: { data: 'UPID:task' } });
    });
    getClientMock.mockResolvedValue(client as never);

    await expect(rebuildVm(admin, VM, { kind: 'iso', os: 'debian.iso' })).rejects.toThrow('pve create failed');
    expect(update).toHaveBeenCalledWith({ where: { id: 'vm-1' }, data: { status: 'error' } });
  });
});

describe('rebuildVm — template / cloud-init redeploy', () => {
  it('clones the template into the same VMID, injects cloud-init, and starts', async () => {
    const client = fakePve();
    getClientMock.mockResolvedValue(client as never);

    const source: RebuildSource = {
      kind: 'template',
      template: TEMPLATE,
      cloud: { sshKey: 'ssh-ed25519 AAAAC3 test@laptop', username: 'matey' },
    };
    const result = await rebuildVm(admin, VM, source);

    // Old VM torn down, then cloned into VMID 110 from template 100.
    expect(client.delete).toHaveBeenCalledWith('/nodes/pve-x/qemu/110');
    const cloneCall = client.post.mock.calls.find((c) => /\/qemu\/100\/clone$/.test(c[0] as string));
    expect(cloneCall).toBeDefined();
    expect(bodyOf(cloneCall!).newid).toBe('110');

    // Cloud-init was applied with the supplied user + DHCP.
    const ciCall = client.put.mock.calls.find((c) => bodyOf(c).ciuser === 'matey');
    expect(ciCall).toBeDefined();
    expect(bodyOf(ciCall!).ipconfig0).toBe('ip=dhcp');

    expect(client.post).toHaveBeenCalledWith('/nodes/pve-x/qemu/110/status/start');
    expect(result.status).toBe('running');
  });

  it('rejects (and does NOT tear down) when a larger template disk exceeds quota', async () => {
    const client = fakePve();
    getClientMock.mockResolvedValue(client as never);
    findMany.mockResolvedValue([] as never); // this is the user's only VM

    const user = { id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 20 } as never;
    const bigTemplate = { ...TEMPLATE, diskGb: 50 } as Template; // 50 GB > 20 GB cap

    await expect(
      rebuildVm(user, VM, { kind: 'template', template: bigTemplate, cloud: {} }),
    ).rejects.toBeInstanceOf(QuotaError);

    // Quota is checked before the destructive teardown.
    expect(client.delete).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
