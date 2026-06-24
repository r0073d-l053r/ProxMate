import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only the seams: the DB, config reads, and the Proxmox client factory.
// The REAL proxmox.service request-builders (pickBestNode, createVm, isolation,
// startVm) run against the fake axios below — that's the "integration" part.
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() } },
}));
vi.mock('../../src/services/config.service.js', () => ({ getConfig: vi.fn() }));
vi.mock('../../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { prisma } from '../../src/lib/prisma.js';
import { getConfig } from '../../src/services/config.service.js';
import * as pve from '../../src/services/proxmox.service.js';
import { createVm, QuotaError } from '../../src/services/vm.service.js';
import { GB } from '../helpers.js';

const create = vi.mocked(prisma.virtualMachine.create);
const update = vi.mocked(prisma.virtualMachine.update);
const findMany = vi.mocked(prisma.virtualMachine.findMany);
const getConfigMock = vi.mocked(getConfig);
const getClientMock = vi.mocked(pve.getClient);

const DEFAULTS: Record<string, string> = {
  default_storage: 'local-lvm',
  default_bridge: 'vmbr0',
  iso_storage: 'local',
  isolation_enabled: 'true',
};

/** A fake Proxmox axios that routes by URL and records every call. */
function fakePve() {
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  const client = {
    get: vi.fn((url: string) => {
      if (url === '/cluster/resources')
        return ok([
          { type: 'node', status: 'online', node: 'pve-int', maxcpu: 8, cpu: 0.1, maxmem: 32 * GB, mem: 4 * GB },
          { type: 'storage', status: 'available', node: 'pve-int', storage: 'local-lvm', maxdisk: 500 * GB, disk: 50 * GB },
        ]);
      if (url === '/cluster/nextid') return ok('120');
      // ISO is present on pve-int's `local` storage → it's an eligible placement.
      if (/\/nodes\/.+\/storage\/.+\/content/.test(url)) return ok([{ volid: 'local:iso/debian.iso' }]);
      // create + start tasks complete successfully.
      if (/\/nodes\/.+\/tasks\/.+\/status/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
      if (/\/nodes\/.+\/network\/.+/.test(url)) return Promise.resolve({ data: { data: { gateway: '10.10.0.1' } } });
      return ok(null);
    }),
    post: vi.fn(() => ok('UPID:task')),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => ok('')),
  };
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfigMock.mockImplementation(async (k: string) => DEFAULTS[k] ?? null);
});

describe('createVm orchestration (vs mocked Proxmox API)', () => {
  it('auto-schedules a node, then creates → isolates → starts, tracking DB status', async () => {
    const client = fakePve();
    getClientMock.mockResolvedValue(client as never);
    create.mockResolvedValue({ id: 'db-1', status: 'creating', proxmoxVmId: 120, proxmoxNode: 'pve-int' } as never);
    update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        ({ id: where.id, proxmoxVmId: 120, proxmoxNode: 'pve-int', ...data }) as never,
    );

    // admin → bypasses quota; exercises the full provisioning path
    const admin = { id: 'a1', role: 'admin' } as never;
    const vm = await createVm(admin, { name: 'web', cpu: 2, ram: 2048, storage: 20, os: 'debian.iso' });

    expect(vm.status).toBe('running');

    // DB row created as 'creating' on the auto-picked node, with the reserved VMID
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].data).toMatchObject({
      status: 'creating',
      proxmoxNode: 'pve-int',
      proxmoxVmId: 120,
    });

    // Proxmox side effects, in order: create VM, lock firewall, start VM
    expect(client.post).toHaveBeenCalledWith('/nodes/pve-int/qemu', expect.any(URLSearchParams));
    expect(client.put).toHaveBeenCalledWith(
      '/nodes/pve-int/qemu/120/firewall/options',
      expect.any(URLSearchParams),
    );
    expect(client.post).toHaveBeenCalledWith('/nodes/pve-int/qemu/120/status/start');

    // DB status transitions: creating → stopped → running
    const statuses = update.mock.calls.map((c) => (c[0] as { data: { status: string } }).data.status);
    expect(statuses).toEqual(['stopped', 'running']);
  });

  it('rejects an over-quota tenant before touching Proxmox at all', async () => {
    const client = fakePve();
    getClientMock.mockResolvedValue(client as never);
    findMany.mockResolvedValue([{ cpu: 4, ram: 8192, storage: 100 }] as never);
    const tenant = { id: 'u1', role: 'user', maxCpu: 4, maxRam: 8192, maxStorage: 100 } as never;

    await expect(
      createVm(tenant, { name: 'x', cpu: 1, ram: 1, storage: 1, os: 'd.iso' }),
    ).rejects.toBeInstanceOf(QuotaError);

    // The quota guard must short-circuit: no client, no DB row, no Proxmox calls.
    expect(getClientMock).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });
});
