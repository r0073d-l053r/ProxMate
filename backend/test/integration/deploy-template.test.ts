import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same seam-mocking strategy as create-vm.test.ts: real proxmox.service
// request-builders run against a fake axios; only the DB/config/client are mocked.
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
import { deployFromTemplate } from '../../src/services/vm.service.js';
import { bodyOf } from '../helpers.js';
import type { Template } from '@prisma/client';

const create = vi.mocked(prisma.virtualMachine.create);
const update = vi.mocked(prisma.virtualMachine.update);
const getConfigMock = vi.mocked(getConfig);
const getClientMock = vi.mocked(pve.getClient);

function fakePve() {
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  return {
    get: vi.fn((url: string) => {
      if (url === '/cluster/nextid') return ok('110');
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
  getConfigMock.mockImplementation(async (k: string) => (k === 'isolation_enabled' ? 'false' : null));
});

describe('deployFromTemplate — cloud-init', () => {
  it('full-clones the template and injects ciuser + (encoded) sshkeys + dhcp', async () => {
    const client = fakePve();
    getClientMock.mockResolvedValue(client as never);
    create.mockResolvedValue({ id: 'vm-1', proxmoxVmId: 110, proxmoxNode: 'pve-x' } as never);
    update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'vm-1', proxmoxVmId: 110, proxmoxNode: 'pve-x', ...data }) as never);

    const admin = { id: 'a1', role: 'admin' } as never;
    const sshKey = 'ssh-ed25519 AAAAC3 test@laptop';
    const vm = await deployFromTemplate(admin, TEMPLATE, {
      name: 'box',
      cpu: 2,
      ram: 2048,
      storage: 4,
      sshKey,
      username: 'matey',
    });

    expect(vm.status).toBe('running');
    // Cloud-init keeps provisioning after boot — the VM is deploy-locked.
    expect(vm.deployState).toBe('deploying');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deployState: 'deploying' }) }),
    );

    // Cloud images full-clone (linked clones aren't supported on imported disks).
    const cloneCall = client.post.mock.calls.find((c) => /\/qemu\/100\/clone$/.test(c[0] as string));
    expect(cloneCall).toBeDefined();
    expect(bodyOf(cloneCall!).full).toBe('1');

    // Cloud-init config was PUT with the user + dhcp + URL-encoded key.
    const ciCall = client.put.mock.calls.find((c) => bodyOf(c).ciuser === 'matey');
    expect(ciCall).toBeDefined();
    const ci = bodyOf(ciCall!);
    expect(ci.ipconfig0).toBe('ip=dhcp');
    expect(ci.sshkeys).toBe(encodeURIComponent(sshKey));

    // It started.
    expect(client.post).toHaveBeenCalledWith('/nodes/pve-x/qemu/110/status/start');
  });

  it('does NOT set cloud-init config for a plain template', async () => {
    const client = fakePve();
    getClientMock.mockResolvedValue(client as never);
    create.mockResolvedValue({ id: 'vm-2', proxmoxVmId: 110, proxmoxNode: 'pve-x' } as never);
    update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'vm-2', ...data }) as never);

    const plain = { ...TEMPLATE, cloudInit: false } as Template;
    const admin = { id: 'a1', role: 'admin' } as never;
    const vm = await deployFromTemplate(admin, plain, { name: 'box', cpu: 1, ram: 1024, storage: 4 });

    // No cloud-init means no deploy lock — nothing provisions after boot.
    expect(vm.deployState).toBeUndefined();
    expect(
      update.mock.calls.some((c) => (c[0] as { data: Record<string, unknown> }).data.deployState !== undefined),
    ).toBe(false);

    expect(client.put.mock.calls.some((c) => bodyOf(c).ciuser !== undefined)).toBe(false);
    // Plain templates linked-clone.
    const cloneCall = client.post.mock.calls.find((c) => /\/qemu\/100\/clone$/.test(c[0] as string));
    expect(bodyOf(cloneCall!).full).toBe('0');
  });
});
