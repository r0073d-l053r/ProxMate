import { describe, it, expect, vi, beforeEach } from 'vitest';

// With the `proxmox_pool` setting, every guest ProxMate creates, clones, restores or
// imports has to join that pool: a token whose guest privileges are granted on
// /pool/<name> is refused (403) a create without it, and a guest created outside the
// pool is one the token can no longer reach.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    user: { findUnique: vi.fn() },
    template: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
const config: Record<string, string> = {};
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (key: string) => config[key] ?? null),
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(),
    getIsoNodes: vi.fn(async () => ['pve1']),
    getTemplateNodes: vi.fn(async () => ['pve1']),
    pickBestNode: vi.fn(async () => 'pve1'),
    getNextVmId: vi.fn(async () => 100),
    readIsolationOptions: vi.fn(async () => ({})),
    configureVmIsolation: vi.fn(async () => undefined),
  };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { createVm, createContainer, rebuildVm, guestMarker } from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const getClient = vi.mocked(pve.getClient);
const user = { id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200 } as never;
const ok = (data: unknown) => Promise.resolve({ data: { data } });

/** A fake PVE whose guest 100 carries row `rowa`'s marker. */
function fakePve(kind: 'qemu' | 'lxc' = 'qemu') {
  const c = fakeClient();
  c.get.mockImplementation((url: string) => {
    if (url === '/cluster/resources') return ok([{ type: kind, vmid: 100, node: 'pve1' }]);
    if (/\/100\/config$/.test(url)) return ok({ name: 'web', hostname: 'web', tags: guestMarker('rowa') });
    if (/\/100\/status\/current$/.test(url)) return ok({ status: 'stopped' });
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    return ok(null);
  });
  getClient.mockResolvedValue(asClient(c));
  return c;
}

const createPost = (c: ReturnType<typeof fakeClient>, path: string) =>
  c.post.mock.calls.find((x) => String(x[0]) === path);

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, { default_storage: 'local-lvm', default_bridge: 'vmbr0', iso_storage: 'local', isolation_enabled: 'false' });
  vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.virtualMachine.create).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: 'rowa', ...data }) as never,
  );
  vi.mocked(prisma.virtualMachine.update).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: 'rowa', ...data }) as never,
  );
});

describe('getGuestPool', () => {
  it('is undefined when the setting is unset or blank', async () => {
    expect(await pve.getGuestPool()).toBeUndefined();
    config['proxmox_pool'] = '  ';
    expect(await pve.getGuestPool()).toBeUndefined();
  });

  it('returns the trimmed pool name', async () => {
    config['proxmox_pool'] = ' proxmate ';
    expect(await pve.getGuestPool()).toBe('proxmate');
  });
});

describe('request builders carry the pool', () => {
  const cases: Array<[string, (c: ReturnType<typeof fakeClient>, pool?: string) => Promise<unknown>]> = [
    ['createVm', (c, pool) =>
      pve.createVm({ node: 'pve1', vmid: 100, name: 'web', cores: 1, memory: 1024, diskGb: 10, storage: 'local-lvm', bridge: 'vmbr0', isoStorage: 'local', iso: 'd.iso', pool }, asClient(c))],
    ['createLxc', (c, pool) =>
      pve.createLxc({ node: 'pve1', vmid: 100, hostname: 'web', cores: 1, memory: 512, diskGb: 8, storage: 'local-lvm', bridge: 'vmbr0', ostemplate: 'local:vztmpl/d.tar.zst', pool }, asClient(c))],
    ['createCloudInitVm', (c, pool) =>
      pve.createCloudInitVm({ node: 'pve1', vmid: 100, name: 'img', importFrom: 'local:import/x.qcow2', diskStorage: 'local-lvm', bridge: 'vmbr0', pool }, asClient(c))],
    ['cloneVm', (c, pool) =>
      pve.cloneVm({ node: 'pve1', templateVmid: 9000, newVmid: 100, name: 'web', full: true, pool }, asClient(c))],
    ['restoreBackup (qemu)', (c, pool) =>
      pve.restoreBackup({ node: 'pve1', vmid: 100, volid: 'b:backup/x.vma.zst', pool }, asClient(c))],
    ['restoreBackup (lxc)', (c, pool) =>
      pve.restoreBackup({ node: 'pve1', vmid: 100, volid: 'b:backup/x.tar.zst', pool }, asClient(c), 'lxc')],
    ['restoreNewGuest (qemu)', (c, pool) =>
      pve.restoreNewGuest({ node: 'pve1', vmid: 100, volid: 'b:backup/x.vma.zst', pool }, asClient(c))],
    ['restoreNewGuest (lxc)', (c, pool) =>
      pve.restoreNewGuest({ node: 'pve1', vmid: 100, volid: 'b:backup/x.tar.zst', pool }, asClient(c), 'lxc')],
  ];

  it.each(cases)('%s sends pool=<name>', async (_label, run) => {
    const c = fakeClient();
    await run(c, 'proxmate');
    expect(bodyOf(c.post.mock.calls[0]!)['pool']).toBe('proxmate');
  });

  it.each(cases)('%s sends no pool parameter without one', async (_label, run) => {
    const c = fakeClient();
    await run(c);
    expect(bodyOf(c.post.mock.calls[0]!)).not.toHaveProperty('pool');
  });
});

describe('every create path puts the new guest in the configured pool', () => {
  beforeEach(() => {
    config['proxmox_pool'] = 'proxmate';
  });

  it('an ISO install', async () => {
    const c = fakePve();
    await createVm(user, { name: 'web', cpu: 1, ram: 1024, storage: 10, os: 'debian.iso' });
    expect(bodyOf(createPost(c, '/nodes/pve1/qemu')!)['pool']).toBe('proxmate');
  });

  it('a container', async () => {
    const c = fakePve('lxc');
    await createContainer(user, { name: 'web', cpu: 1, ram: 512, storage: 8, template: 'local:vztmpl/debian-12.tar.zst' });
    expect(bodyOf(createPost(c, '/nodes/pve1/lxc')!)['pool']).toBe('proxmate');
  });

  it('an ISO rebuild (the guest is destroyed and created again at its VMID)', async () => {
    const c = fakePve();
    const row = { id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1', status: 'stopped', cpu: 1, ram: 1024, storage: 10 };
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([row] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user);
    await rebuildVm(user, row as never, { kind: 'iso', os: 'debian.iso' });
    expect(bodyOf(createPost(c, '/nodes/pve1/qemu')!)['pool']).toBe('proxmate');
  });

  it('a template rebuild (the guest is cloned again at its VMID)', async () => {
    const c = fakePve();
    const row = { id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1', status: 'stopped', cpu: 1, ram: 1024, storage: 10 };
    const template = { id: 't1', name: 'Debian', os: 'Debian', proxmoxVmId: 9000, proxmoxNode: 'pve1', cloudInit: false, diskGb: 5 };
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([row] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user);
    await rebuildVm(user, row as never, { kind: 'template', template: template as never, cloud: {} });
    expect(bodyOf(createPost(c, '/nodes/pve1/qemu/9000/clone')!)['pool']).toBe('proxmate');
  });

  it('sends no pool when the setting is empty (the default)', async () => {
    config['proxmox_pool'] = '';
    const c = fakePve();
    await createVm(user, { name: 'web', cpu: 1, ram: 1024, storage: 10, os: 'debian.iso' });
    expect(bodyOf(createPost(c, '/nodes/pve1/qemu')!)).not.toHaveProperty('pool');
  });
});

describe('addGuestsToPool', () => {
  it('uses PUT /pools with the pool id in the body, allowing a move from another pool', async () => {
    const c = fakeClient();
    await pve.addGuestsToPool('proxmate', [100, 101], asClient(c));
    expect(c.put).toHaveBeenCalledTimes(1);
    expect(c.put.mock.calls[0]![0]).toBe('/pools');
    expect(bodyOf(c.put.mock.calls[0]!)).toEqual({ poolid: 'proxmate', vms: '100,101', 'allow-move': '1' });
  });

  it('falls back to PUT /pools/{poolid} on a release without the newer endpoint', async () => {
    const { AxiosError } = await import('axios');
    const c = fakeClient();
    c.put.mockRejectedValueOnce(
      new AxiosError('not implemented', '501', undefined, undefined, { status: 501 } as never),
    );
    await pve.addGuestsToPool('proxmate', [100], asClient(c));
    expect(c.put.mock.calls[1]![0]).toBe('/pools/proxmate');
    expect(bodyOf(c.put.mock.calls[1]!)).toEqual({ vms: '100', 'allow-move': '1' });
  });

  it('does nothing for an empty list', async () => {
    const c = fakeClient();
    await pve.addGuestsToPool('proxmate', [], asClient(c));
    expect(c.put).not.toHaveBeenCalled();
  });
});
