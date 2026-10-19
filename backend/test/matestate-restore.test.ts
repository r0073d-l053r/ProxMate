import { describe, it, expect, vi, beforeEach } from 'vitest';

// A MateState restore replaces the guest's whole config with the backup-time one.
// These tests pin down that the row is re-synced from the restored guest, that a
// restore can't grow the guest past its owner's quota, and that a PCI device
// detached since the backup doesn't come back.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    mateState: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (key: string) => ({ default_bridge: 'vmbr0', isolation_enabled: 'true', ide_ingress_cidr: '10.0.0.5/32' })[key] ?? null),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(),
    readIsolationOptions: vi.fn(async () => ({ dnsServers: [], vlanTag: 42 })),
    configureVmIsolation: vi.fn(async () => undefined),
  };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { guestMarker, QuotaError, syncRestoredGuest, resizeVm } from '../src/services/vm.service.js';
import { restoreFromMateState } from '../src/services/matestate.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const VOLID = 'backups:backup/vzdump-qemu-100-2026_10_01-03_00_00.vma.zst';

/**
 * A stateful fake PVE with guest 100 on pve1. `live` is its config now; once the
 * restore task is posted it becomes `restored`. PUTs to the config are applied.
 */
function fakePve(live: Record<string, string>, archive: Record<string, string>) {
  const c = fakeClient();
  const state = { cfg: { ...live } as Record<string, string>, status: 'stopped' };
  const toText = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n');
  c.get.mockImplementation((url: string) => {
    if (url.startsWith('/cluster/resources')) return ok([{ type: 'qemu', vmid: 100, node: 'pve1', tags: state.cfg['tags'] }, { type: 'node', node: 'pve1', status: 'online' }]);
    if (/\/(qemu|lxc)\/100\/config$/.test(url)) return ok(state.cfg);
    if (/\/qemu\/100\/status\/current$/.test(url)) return ok({ status: state.status });
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    if (url.startsWith('/nodes/pve1/vzdump/extractconfig')) return ok(toText(archive));
    if (url.startsWith('/nodes/pve1/storage/backups/content')) return ok([{ volid: VOLID, vmid: 100 }]);
    if (/\/firewall\/rules$/.test(url)) return ok([]);
    return ok(null);
  });
  c.post.mockImplementation((url: string) => {
    if (url === '/nodes/pve1/qemu') state.cfg = { ...archive };
    if (/status\/start$/.test(url)) state.status = 'running';
    return ok('UPID:fake');
  });
  c.put.mockImplementation((url: string, body: URLSearchParams) => {
    if (/\/(qemu|lxc)\/100\/config$/.test(url)) {
      for (const [k, v] of body) {
        if (k === 'delete') for (const d of v.split(',')) delete state.cfg[d];
        else state.cfg[k] = v;
      }
    }
    return ok('');
  });
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return { c, state };
}

const marker = guestMarker('rowa');
const row = (over: Record<string, unknown> = {}) =>
  ({
    id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1',
    cpu: 1, ram: 1024, storage: 32, hasPassthrough: false, quotaExempt: false, status: 'running', ...over,
  }) as never;
const ms = { id: 'ms1', vmId: 'rowa', status: 'ready', volid: VOLID, proxmoxNode: 'pve1', storage: 'backups' } as never;

const LIVE = { name: 'web', tags: marker, cores: '1', memory: '1024', scsi0: 'local-lvm:vm-100-disk-0,size=32G', net0: 'virtio=AA:BB,bridge=vmbr0,firewall=1' };
const BIG_ARCHIVE = {
  name: 'web', cores: '8', memory: '16384',
  scsi0: 'local-lvm:vm-100-disk-0,size=32G',
  scsi1: 'local-lvm:vm-100-disk-1,size=100G',
  net0: 'virtio=AA:BB,bridge=vmbr0,firewall=1',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row());
  vi.mocked(prisma.virtualMachine.update).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ ...(row() as object), ...data }) as never,
  );
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200, accessExpiresAt: null } as never);
  vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([] as never);
});

describe('MateState restore: resources come back only within quota (BUG-024)', () => {
  it('refuses a backup that would grow the guest past the quota the owner has since spent elsewhere', async () => {
    const { c } = fakePve(LIVE, BIG_ARCHIVE);
    // Another VM now uses the quota this one freed when it was shrunk.
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([{ id: 'other', cpu: 7, ram: 15360, storage: 20 }] as never);

    await expect(restoreFromMateState(row(), ms)).rejects.toBeInstanceOf(QuotaError);
    expect(c.post.mock.calls.some((x) => x[0] === '/nodes/pve1/qemu')).toBe(false);
  });

  it('re-syncs cpu/ram/storage from the restored config when it fits', async () => {
    fakePve(LIVE, { ...BIG_ARCHIVE, tags: marker });
    await restoreFromMateState(row(), ms);
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: expect.objectContaining({ cpu: 8, ram: 16384, storage: 132, hasPassthrough: false }),
    });
  });

  it('counts sockets x cores, as Proxmox runs them', async () => {
    fakePve(LIVE, { ...LIVE, sockets: '2', cores: '2' });
    await restoreFromMateState(row(), ms);
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: expect.objectContaining({ cpu: 4 }),
    });
  });

  it('a data disk removed since the backup is counted again; one added since stops being counted', async () => {
    fakePve({ ...LIVE, scsi2: 'local-lvm:vm-100-disk-9,size=50G' }, { ...LIVE, scsi1: 'local-lvm:vm-100-disk-1,size=10G' });
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row({ storage: 82 }));
    await restoreFromMateState(row({ storage: 82 }), ms);
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: expect.objectContaining({ storage: 42 }),
    });
  });

  it('strips a PCI device that was detached after the backup, before the guest starts', async () => {
    const { c, state } = fakePve(LIVE, { ...LIVE, hostpci0: 'mapping=gpu0,pcie=1' });
    await restoreFromMateState(row({ hasPassthrough: false }), ms);
    expect(state.cfg['hostpci0']).toBeUndefined();
    const del = c.put.mock.calls.findIndex((x) => bodyOf(x)['delete'] === 'hostpci0');
    const start = c.post.mock.calls.findIndex((x) => /status\/start$/.test(String(x[0])));
    expect(del).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(c.put.mock.invocationCallOrder[del]!).toBeLessThan(c.post.mock.invocationCallOrder[start]!);
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: expect.objectContaining({ hasPassthrough: false }),
    });
  });

  it('keeps a PCI device that is approved and attached now', async () => {
    const gpu = 'mapping=gpu0,pcie=1';
    const { state } = fakePve({ ...LIVE, hostpci0: gpu }, { ...LIVE, hostpci0: gpu });
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row({ hasPassthrough: true }));
    await restoreFromMateState(row({ hasPassthrough: true }), ms);
    expect(state.cfg['hostpci0']).toBe(gpu);
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: expect.objectContaining({ hasPassthrough: true }),
    });
  });
});

describe('MateState restore re-applies the network placement and isolation of now (BUG-059)', () => {
  it('moves the NIC back to the current bridge, re-runs isolation with the current VLAN, and re-opens the IDE pinhole — all before start', async () => {
    const { c, state } = fakePve(LIVE, { ...LIVE, net0: 'virtio=AA:BB,bridge=vmbr9' });
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row({ ideState: 'ready' }));
    vi.mocked(prisma.virtualMachine.update).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ ...(row({ ideState: 'ready' }) as object), ...data }) as never,
    );
    await restoreFromMateState(row({ ideState: 'ready' }), ms);

    expect(state.cfg['net0']).toContain('bridge=vmbr0');
    expect(state.cfg['net0']).toContain('firewall=1');
    expect(pve.configureVmIsolation).toHaveBeenCalledWith('pve1', 100, { dnsServers: [], vlanTag: 42 }, expect.anything(), 'qemu');
    const pinhole = c.post.mock.calls.findIndex(
      (x) => x[0] === '/nodes/pve1/qemu/100/firewall/rules' && bodyOf(x)['comment']?.includes('IDE'),
    );
    const start = c.post.mock.calls.findIndex((x) => /status\/start$/.test(String(x[0])));
    expect(pinhole).toBeGreaterThanOrEqual(0);
    expect(c.post.mock.invocationCallOrder[pinhole]!).toBeLessThan(c.post.mock.invocationCallOrder[start]!);
    expect(vi.mocked(pve.configureVmIsolation).mock.invocationCallOrder[0]!).toBeLessThan(c.post.mock.invocationCallOrder[start]!);
  });

  it('does not start the guest when isolation cannot be re-applied', async () => {
    const { c } = fakePve(LIVE, LIVE);
    vi.mocked(pve.configureVmIsolation).mockRejectedValueOnce(new Error('firewall API down'));
    await expect(restoreFromMateState(row(), ms)).rejects.toThrow(/firewall API down/);
    expect(c.post.mock.calls.some((x) => /status\/start$/.test(String(x[0])))).toBe(false);
  });
});

describe('MateState restore after the guest moved outside ProxMate (BUG-060)', () => {
  it('restores on the node the guest is on now, as Proxmox reports it', async () => {
    const { c } = fakePve(LIVE, LIVE);
    await restoreFromMateState(row({ proxmoxNode: 'pve-old' }), ms);
    expect(c.post.mock.calls.some((x) => x[0] === '/nodes/pve1/qemu')).toBe(true);
  });

  it('refuses plainly when the backup is on another node\'s local storage', async () => {
    const { c } = fakePve(LIVE, LIVE);
    const get = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) => {
      if (url.startsWith('/cluster/resources')) {
        return ok([{ type: 'qemu', vmid: 100, node: 'pve1' }, { type: 'node', node: 'pve1', status: 'online' }, { type: 'node', node: 'pve2', status: 'online' }]);
      }
      if (url.startsWith('/nodes/pve1/storage/backups/content')) return ok([]);
      if (url.startsWith('/nodes/pve2/storage/backups/content')) return ok([{ volid: VOLID, vmid: 100 }]);
      return get(url);
    });
    await expect(restoreFromMateState(row(), ms)).rejects.toThrow(/stored on pve2, but the VM is now on pve1/);
    expect(c.post.mock.calls.some((x) => x[0] === '/nodes/pve1/qemu')).toBe(false);
  });
});

describe('MateState restore and the owner\'s compute-access window (BUG-067)', () => {
  it('restores the data but leaves the guest off when the owner\'s window has closed', async () => {
    const { c } = fakePve(LIVE, LIVE);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200, accessExpiresAt: new Date(Date.now() - 60_000),
    } as never);
    await restoreFromMateState(row(), ms);
    expect(c.post.mock.calls.some((x) => x[0] === '/nodes/pve1/qemu')).toBe(true);
    expect(c.post.mock.calls.some((x) => /status\/start$/.test(String(x[0])))).toBe(false);
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({ where: { id: 'rowa' }, data: { status: 'stopped', holdReason: null } });
  });

  it('starts the guest while the window is open', async () => {
    const { c } = fakePve(LIVE, LIVE);
    await restoreFromMateState(row(), ms);
    expect(c.post.mock.calls.some((x) => /status\/start$/.test(String(x[0])))).toBe(true);
  });
});

describe('CPU layout after a restore (audit MAJOR 3)', () => {
  it('a restored sockets=4/cores=8 guest is rewritten as one socket, and a resize to 8 leaves sockets 1 / cores 8 / no vcpus', async () => {
    const { state } = fakePve(LIVE, { ...LIVE, sockets: '4', cores: '8', vcpus: '32' });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1', role: 'user', maxCpu: 64, maxRam: 65536, maxStorage: 500, accessExpiresAt: null } as never);
    await restoreFromMateState(row(), ms);
    expect(state.cfg['sockets']).toBe('1');
    expect(state.cfg['cores']).toBe('32');
    expect(state.cfg['vcpus']).toBeUndefined();

    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row({ cpu: 32 }));
    await resizeVm({ id: 'u1', role: 'user', maxCpu: 64, maxRam: 65536, maxStorage: 500 } as never, row({ cpu: 32 }), { cpu: 8 });
    expect(state.cfg['sockets']).toBe('1');
    expect(state.cfg['cores']).toBe('8');
    expect(state.cfg['vcpus']).toBeUndefined();
  });
});

describe('unusedN volumes after a restore (audit minor)', () => {
  it('deletes a volume the restored config left detached, before the guest starts', async () => {
    const { c, state } = fakePve(LIVE, { ...LIVE, unused0: 'local-lvm:vm-100-disk-7' });
    await restoreFromMateState(row(), ms);
    expect(state.cfg['unused0']).toBeUndefined();
    const del = c.put.mock.calls.findIndex((x) => bodyOf(x)['delete'] === 'unused0');
    const start = c.post.mock.calls.findIndex((x) => /status\/start$/.test(String(x[0])));
    expect(c.put.mock.invocationCallOrder[del]!).toBeLessThan(c.post.mock.invocationCallOrder[start]!);
  });
});

describe('syncRestoredGuest', () => {
  it('pins a restored container with no cores line to the row\'s cores (BUG-028)', async () => {
    const { state } = fakePve({ hostname: 'ct', tags: marker, memory: '1024', rootfs: 'local-lvm:vm-100-disk-0,size=8G' }, {});
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row({ type: 'lxc', cpu: 2, storage: 8 }));
    await syncRestoredGuest(row({ type: 'lxc', cpu: 2, storage: 8 }), { approvedPci: [] });
    expect(state.cfg['cores']).toBe('2');
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: { cpu: 2, ram: 1024, storage: 8 },
    });
  });

  it('sets CPU/RAM that no longer fit the quota back to the row\'s size', async () => {
    const { state } = fakePve({ ...BIG_ARCHIVE, tags: marker }, {});
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([{ id: 'other', cpu: 7, ram: 15360, storage: 20 }] as never);
    await syncRestoredGuest(row(), { approvedPci: [] });
    expect(state.cfg['cores']).toBe('1');
    expect(state.cfg['memory']).toBe('1024');
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: expect.objectContaining({ cpu: 1, ram: 1024, storage: 132 }),
    });
  });
});
