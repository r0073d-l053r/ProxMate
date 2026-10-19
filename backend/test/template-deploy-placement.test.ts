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
import { deployFromTemplate } from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

/**
 * Template deploys go where the scheduler would put a new VM when the clone is full
 * and every disk involved is on shared storage. A linked clone, or anything on
 * node-local storage, stays on the template's node.
 */

const HOME = 'pve-1'; // holds the template; busy
const IDLE = 'pve-2'; // nearly empty
const VMID = 101;

const createVm = vi.mocked(prisma.virtualMachine.create);
const updateVm = vi.mocked(prisma.virtualMachine.update);
const findManyVm = vi.mocked(prisma.virtualMachine.findMany);
const findConfig = vi.mocked(prisma.systemConfig.findUnique);
const getClient = vi.mocked(pve.getClient);

function configuredAs(values: Record<string, string>) {
  findConfig.mockImplementation(((args: { where: { key: string } }) => {
    const v = values[args.where.key];
    return Promise.resolve(v === undefined ? null : { key: args.where.key, value: v, sensitive: false });
  }) as never);
}

const user = { id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200 } as never;
const template = (over: Record<string, unknown> = {}) =>
  ({ id: 't1', name: 'Debian 12', os: 'Debian 12', proxmoxVmId: 9000, proxmoxNode: HOME, cloudInit: true, diskGb: 5, arch: null, ...over }) as never;
const input = { name: 'app-01', cpu: 2, ram: 2048, storage: 5 };

const GB = 1024 ** 3;
/**
 * Two online nodes; HOME is nearly full, IDLE nearly empty. `storages` maps each pool
 * to whether it is shared. The template's disks live on `templateDisks`.
 */
function fakeCluster(opts: {
  templateDisks: string[];
  storages: Record<string, boolean>;
  resourcesFail?: boolean;
  /** Storage id → the only nodes it is available on, as /cluster/resources reports it. */
  storageNodes?: Record<string, string[]>;
}) {
  const c = fakeClient();
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  const pools = Object.keys(opts.storages);
  c.get.mockImplementation((url: string) => {
    if (url === '/cluster/nextid') return ok(String(VMID));
    if (url === '/cluster/resources') {
      if (opts.resourcesFail) return Promise.reject(new Error('cluster resources unavailable'));
      return ok([
        { type: 'node', node: HOME, status: 'online', maxcpu: 8, cpu: 0.95, maxmem: 32 * GB, mem: 31 * GB },
        { type: 'node', node: IDLE, status: 'online', maxcpu: 8, cpu: 0.05, maxmem: 32 * GB, mem: 2 * GB },
        ...pools.flatMap((storage) =>
          [HOME, IDLE].map((node) => ({ type: 'storage', storage, node, status: 'available', maxdisk: 1000 * GB, disk: 100 * GB })),
        ),
        // Storages that exist only on some nodes (e.g. an NFS snippet share one node
        // cannot mount) are reported per node, exactly as /cluster/resources does.
        ...Object.entries(opts.storageNodes ?? {}).flatMap(([storage, nodes]) =>
          nodes.map((node) => ({ type: 'storage', storage, node, status: 'available', maxdisk: 10 * GB, disk: GB })),
        ),
      ]);
    }
    if (/\/nodes\/[^/]+\/storage$/.test(url)) {
      return ok(pools.map((storage) => ({ storage, type: 'rbd', active: 1, shared: opts.storages[storage] ? 1 : 0 })));
    }
    if (/\/qemu\/9000\/config$/.test(url)) {
      const [main, ...rest] = opts.templateDisks;
      return ok({
        scsi0: `${main}:base-9000-disk-0,size=5G`,
        ...(rest[0] ? { ide2: `${rest[0]}:vm-9000-cloudinit,media=cdrom` } : {}),
      });
    }
    if (/\/qemu\/101\/config$/.test(url)) {
      return ok({ scsi0: 'x:vm-101-disk-0,size=5G', net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1' });
    }
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    if (/\/firewall\/rules$/.test(url)) return ok([]);
    return ok(null);
  });
  return c;
}

const cloneCall = (c: ReturnType<typeof fakeClient>) => c.post.mock.calls.find((x) => /\/qemu\/9000\/clone$/.test(String(x[0])))!;
const rowNode = () => (createVm.mock.calls[0]![0] as { data: { proxmoxNode: string } }).data.proxmoxNode;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  findManyVm.mockResolvedValue([] as never);
  createVm.mockImplementation(((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'vm1', ...args.data })) as never);
  updateVm.mockImplementation(((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'vm1', ...args.data })) as never);
});

describe('deployFromTemplate placement', () => {
  it('sends a full clone on shared storage to the least-loaded node', async () => {
    configuredAs({ default_storage: 'ceph-vm' });
    const c = fakeCluster({ templateDisks: ['ceph-vm', 'ceph-vm'], storages: { 'ceph-vm': true } });
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), input);

    const call = cloneCall(c);
    expect(call[0]).toBe(`/nodes/${HOME}/qemu/9000/clone`); // the task runs where the template is
    expect(bodyOf(call)).toMatchObject({ full: '1', storage: 'ceph-vm', target: IDLE });
    expect(rowNode()).toBe(IDLE);
    // Everything after the clone talks to the node the guest is on.
    const after = [...c.put.mock.calls, ...c.post.mock.calls].map((x) => String(x[0])).filter((u) => /\/qemu\/101\//.test(u));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((u) => u.startsWith(`/nodes/${IDLE}/`))).toBe(true);
  });

  it('keeps a linked clone on the template node', async () => {
    configuredAs({ default_storage: 'ceph-vm' });
    const c = fakeCluster({ templateDisks: ['ceph-vm'], storages: { 'ceph-vm': true } });
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template({ cloudInit: false }), input);

    expect(bodyOf(cloneCall(c))['full']).toBe('0');
    expect(bodyOf(cloneCall(c))['target']).toBeUndefined();
    expect(rowNode()).toBe(HOME);
  });

  it('keeps the template node when any template disk is on node-local storage', async () => {
    configuredAs({ default_storage: 'ceph-vm' });
    const c = fakeCluster({ templateDisks: ['ceph-vm', 'local-lvm'], storages: { 'ceph-vm': true, 'local-lvm': false } });
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), input);

    expect(bodyOf(cloneCall(c))['target']).toBeUndefined();
    expect(rowNode()).toBe(HOME);
  });

  it('keeps the template node when the destination pool is node-local', async () => {
    configuredAs({ default_storage: 'local-lvm' });
    const c = fakeCluster({ templateDisks: ['ceph-vm'], storages: { 'ceph-vm': true, 'local-lvm': false } });
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), input);

    expect(bodyOf(cloneCall(c))['target']).toBeUndefined();
    expect(rowNode()).toBe(HOME);
  });

  // Lab test 2 (QueenBee): three deploys landed on a node where the snippet storage
  // wasn't available. They cloned, resized and configured, then every qmstart failed
  // with `storage 'musebot-backups' is not available on node 'pve-5'`, leaving the
  // guests held as failed provisions.
  it('does not place a deploy on a node that cannot see the snippet storage', async () => {
    configuredAs({ default_storage: 'ceph-vm' });
    const c = fakeCluster({
      templateDisks: ['ceph-vm', 'ceph-vm'],
      storages: { 'ceph-vm': true },
      storageNodes: { snippets: [HOME] }, // the idle node cannot serve the vendor snippet
    });
    getClient.mockResolvedValue(asClient(c));
    vi.stubEnv('SNIPPET_STORAGE', 'snippets');

    await deployFromTemplate(user, template(), input);

    expect(bodyOf(cloneCall(c))['target']).toBeUndefined();
    expect(rowNode()).toBe(HOME);
    vi.unstubAllEnvs();
  });

  it('still spreads when the snippet storage is available everywhere', async () => {
    configuredAs({ default_storage: 'ceph-vm' });
    const c = fakeCluster({
      templateDisks: ['ceph-vm', 'ceph-vm'],
      storages: { 'ceph-vm': true },
      storageNodes: { snippets: [HOME, IDLE] },
    });
    getClient.mockResolvedValue(asClient(c));
    vi.stubEnv('SNIPPET_STORAGE', 'snippets');

    await deployFromTemplate(user, template(), input);

    expect(bodyOf(cloneCall(c))).toMatchObject({ target: IDLE });
    expect(rowNode()).toBe(IDLE);
    vi.unstubAllEnvs();
  });

  it('falls back to the template node when the scheduler cannot read the cluster', async () => {
    configuredAs({ default_storage: 'ceph-vm' });
    const c = fakeCluster({ templateDisks: ['ceph-vm'], storages: { 'ceph-vm': true }, resourcesFail: true });
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), input);

    expect(bodyOf(cloneCall(c))['target']).toBeUndefined();
    expect(rowNode()).toBe(HOME);
  });
});

describe('volumeStoragesOf', () => {
  it('lists every storage a guest\'s drives use, skipping drives with no volume', () => {
    expect(
      pve.volumeStoragesOf({
        scsi0: 'tank:vm-1-disk-0,size=5G',
        efidisk0: 'ceph:vm-1-disk-1,size=4M',
        ide2: 'none,media=cdrom',
        ide0: 'cdrom,media=cdrom',
        net0: 'virtio=AA,bridge=vmbr0',
        scsi1: 'tank:vm-1-disk-2,size=1G',
      }).sort(),
    ).toEqual(['ceph', 'tank']);
  });
});
