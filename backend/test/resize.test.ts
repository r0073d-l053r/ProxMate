import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the seams: the DB and the Proxmox client factory. The REAL proxmox.service
// request-builders (setVmResources, resizeDisk, getVmConfig, findPrimaryDisk) and
// the REAL quota/resize logic run against the fake axios below.
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { findMany: vi.fn(), update: vi.fn() } },
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { resizeVm, QuotaError, ResizeError } from '../src/services/vm.service.js';
import { bodyOf } from './helpers.js';

const findMany = vi.mocked(prisma.virtualMachine.findMany);
const update = vi.mocked(prisma.virtualMachine.update);
const getClient = vi.mocked(pve.getClient);

const user = (over: Record<string, unknown> = {}) =>
  ({ id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200, ...over }) as never;
const vm = (over: Record<string, unknown> = {}) =>
  ({ id: 'db-1', userId: 'u1', name: 'web', proxmoxVmId: 120, proxmoxNode: 'pve1', cpu: 1, ram: 1024, storage: 10, ...over }) as never;

/** A fake Proxmox axios that records puts and answers the reads resizeVm makes. */
function fakePve(over: Record<string, unknown> = {}) {
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  return {
    get: vi.fn((url: string) => {
      // syncVmNode: report the VM on its stored node so the node doesn't change.
      if (url === '/cluster/resources') return ok([{ type: 'qemu', vmid: 120, node: 'pve1' }]);
      // getVmConfig: a primary scsi0 disk (10G) plus a cdrom that must be ignored.
      if (/\/qemu\/120\/config$/.test(url))
        return ok({ scsi0: 'local-lvm:vm-120-disk-0,size=10G', ide2: 'local:iso/x.iso,media=cdrom' });
      return ok(null);
    }),
    put: vi.fn(() => Promise.resolve({ data: { data: '' } })),
    post: vi.fn(() => ok('UPID')),
    delete: vi.fn(() => ok('')),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([] as never); // no other VMs by default
  update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      ({ ...vm(), id: where.id, ...data }) as never,
  );
});

describe('resizeVm', () => {
  it('applies new CPU/RAM via the config endpoint and persists it', async () => {
    const client = fakePve();
    getClient.mockResolvedValue(client as never);

    const result = await resizeVm(user(), vm(), { cpu: 4, ram: 8192 });

    const cfgPut = client.put.mock.calls.find((c) => /\/config$/.test(c[0] as string));
    expect(bodyOf(cfgPut!)).toEqual({ cores: '4', memory: '8192' });
    // No disk change requested → no resize call.
    expect(client.put.mock.calls.some((c) => /\/resize$/.test(c[0] as string))).toBe(false);
    expect(update).toHaveBeenCalledWith({ where: { id: 'db-1' }, data: { cpu: 4, ram: 8192 } });
    expect(result).toMatchObject({ cpu: 4, ram: 8192 });
  });

  it('grows the primary disk (ignoring the cdrom) to an absolute size and persists it', async () => {
    const client = fakePve();
    getClient.mockResolvedValue(client as never);

    const result = await resizeVm(user(), vm(), { storage: 20 });

    const resizePut = client.put.mock.calls.find((c) => /\/resize$/.test(c[0] as string));
    expect(bodyOf(resizePut!)).toEqual({ disk: 'scsi0', size: '20G' });
    expect(update).toHaveBeenCalledWith({ where: { id: 'db-1' }, data: { storage: 20 } });
    expect(result).toMatchObject({ storage: 20 });
  });

  it('refuses to shrink a disk and touches neither Proxmox nor the DB', async () => {
    const client = fakePve();
    getClient.mockResolvedValue(client as never);

    await expect(resizeVm(user(), vm({ storage: 10 }), { storage: 5 })).rejects.toBeInstanceOf(ResizeError);
    expect(client.put).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('judges quota on the delta — resizing one VM up to the cap is allowed (no double-count)', async () => {
    const client = fakePve();
    getClient.mockResolvedValue(client as never);
    findMany.mockResolvedValue([] as never); // this is the user's only VM

    // Currently 4 cores; grow to the full 8-core cap. Double-counting (4+8) would reject.
    const result = await resizeVm(user(), vm({ cpu: 4 }), { cpu: 8 });
    expect(result).toMatchObject({ cpu: 8 });
  });

  it('rejects a resize that, with the user\'s other VMs, exceeds the cap', async () => {
    getClient.mockResolvedValue(fakePve() as never);
    findMany.mockResolvedValue([{ cpu: 6, ram: 4096, storage: 50 }] as never); // another VM

    let err: unknown;
    try {
      await resizeVm(user(), vm({ cpu: 1 }), { cpu: 4 }); // 6 + 4 = 10 > max 8
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QuotaError);
    expect((err as QuotaError).details.cpu).toEqual({ used: 6, requested: 4, max: 8 });
    expect(update).not.toHaveBeenCalled();
  });

  it('leaves the DB unchanged when Proxmox rejects the change (no desync)', async () => {
    const client = fakePve({ put: vi.fn(() => Promise.reject(new Error('pve 500'))) });
    getClient.mockResolvedValue(client as never);

    await expect(resizeVm(user(), vm(), { cpu: 4, ram: 8192 })).rejects.toThrow('pve 500');
    expect(update).not.toHaveBeenCalled();
  });

  it('is a no-op (no Proxmox or DB writes) when nothing changes', async () => {
    const client = fakePve();
    getClient.mockResolvedValue(client as never);

    const same = vm();
    const result = await resizeVm(user(), same, {});
    expect(result).toBe(same);
    expect(client.put).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
