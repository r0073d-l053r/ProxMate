import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
  },
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { duplicateVm, QuotaError } from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const getClient = vi.mocked(pve.getClient);
const createVm = vi.mocked(prisma.virtualMachine.create);
const updateVm = vi.mocked(prisma.virtualMachine.update);
const findManyVm = vi.mocked(prisma.virtualMachine.findMany);
const findUser = vi.mocked(prisma.user.findUnique);
const findConfig = vi.mocked(prisma.systemConfig.findUnique);

const source = (over: Record<string, unknown> = {}) =>
  ({ id: 'src', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 120, proxmoxNode: 'pve1', cpu: 2, ram: 4096, storage: 40, os: 'Ubuntu 24.04', tags: 'web', status: 'stopped', ...over }) as never;

const owner = (over: Record<string, unknown> = {}) =>
  ({ id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200, ...over }) as never;

function fakePve(status = 'stopped') {
  const c = fakeClient();
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  c.get.mockImplementation((url: string) => {
    if (url === '/cluster/resources') return ok([{ type: 'qemu', vmid: 120, node: 'pve1' }]);
    if (/\/qemu\/120\/status\/current$/.test(url)) return ok({ status });
    if (url === '/cluster/nextid') return ok('130');
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    return ok(null);
  });
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  findConfig.mockResolvedValue(null as never); // isolation_enabled unset → default on
  findManyVm.mockResolvedValue([source()] as never); // owner's existing VMs (for quota)
  findUser.mockResolvedValue(owner() as never);
  createVm.mockResolvedValue({ id: 'copy', name: 'web-copy', proxmoxNode: 'pve1', proxmoxVmId: 130 } as never);
  updateVm.mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'copy', ...args.data }) as never);
});

describe('duplicateVm', () => {
  it('full-clones the stopped source to a new VMID and re-applies isolation', async () => {
    const c = fakePve('stopped');
    getClient.mockResolvedValue(asClient(c));

    await duplicateVm(source(), 'web-copy');

    // Clone POST with full=1 to the new id, on the source's node.
    const clone = c.post.mock.calls.find((x) => /\/qemu\/120\/clone$/.test(String(x[0])));
    expect(clone).toBeTruthy();
    const body = bodyOf(clone!);
    expect(body['newid']).toBe('130');
    expect(body['name']).toBe('web-copy');
    expect(body['full']).toBe('1');

    // Isolation firewall configured on the clone (PUT to .../130/firewall/...).
    expect(c.put.mock.calls.some((x) => /\/qemu\/130\/firewall\//.test(String(x[0])))).toBe(true);

    // DB row created for the copy, then started.
    expect(createVm).toHaveBeenCalled();
    expect(c.post.mock.calls.some((x) => /\/qemu\/130\/status\/start$/.test(String(x[0])))).toBe(true);
  });

  it('refuses to duplicate a running VM (no clone attempted)', async () => {
    const c = fakePve('running');
    getClient.mockResolvedValue(asClient(c));
    await expect(duplicateVm(source(), 'web-copy')).rejects.toThrow(/stop the machine/i);
    expect(c.post.mock.calls.some((x) => String(x[0]).includes('/clone'))).toBe(false);
    expect(createVm).not.toHaveBeenCalled();
  });

  it('refuses containers', async () => {
    await expect(duplicateVm(source({ type: 'lxc' }), 'x')).rejects.toThrow(/containers/i);
  });

  it('enforces the owner\'s quota (duplicate would exceed storage)', async () => {
    // Owner already has the 40 GB source; cap is 60 → a 40 GB copy overflows.
    findUser.mockResolvedValue(owner({ maxStorage: 60 }) as never);
    const c = fakePve('stopped');
    getClient.mockResolvedValue(asClient(c));
    await expect(duplicateVm(source(), 'web-copy')).rejects.toBeInstanceOf(QuotaError);
    expect(c.post.mock.calls.some((x) => String(x[0]).includes('/clone'))).toBe(false);
  });
});
