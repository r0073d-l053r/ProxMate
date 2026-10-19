import { describe, it, expect, vi, beforeEach } from 'vitest';

// Adopting a held or errored machine makes its guest safe before the hold is
// cleared, the same way a restore does: the NIC goes back to the current bridge
// with the firewall on, isolation is re-applied, and cpu/ram/storage are re-read
// into the row under the owner's quota. If any of that fails the hold stays.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn(async () => 0) },
    user: { findUnique: vi.fn() },
    template: { count: vi.fn(async () => 0) },
  },
}));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (key: string) => ({ default_bridge: 'vmbr0', isolation_enabled: 'true' })[key] ?? null),
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
import { adoptGuest, AdoptError, isHeld, QUOTA_HOLD_MESSAGE } from '../src/services/vm.service.js';
import { fakeClient, asClient } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });

/** A 1.0.x guest 100 on pve1: untagged, on another bridge, NIC firewall off. */
const LEGACY = {
  name: 'web', cores: '2', memory: '2048',
  scsi0: 'local-lvm:vm-100-disk-0,size=40G',
  net0: 'virtio=AA:BB,bridge=vmbr9',
};

function fakePve(cfg: Record<string, string>) {
  const c = fakeClient();
  const state = { cfg: { ...cfg } };
  c.get.mockImplementation((url: string) => {
    if (url.startsWith('/cluster/resources')) {
      return ok([{ type: 'qemu', vmid: 100, node: 'pve1', name: state.cfg['name'], tags: state.cfg['tags'] }, { type: 'node', node: 'pve1', status: 'online' }]);
    }
    if (/\/qemu\/100\/config$/.test(url)) return ok(state.cfg);
    if (/\/firewall\/rules$/.test(url)) return ok([]);
    return ok(null);
  });
  c.put.mockImplementation((url: string, body: URLSearchParams) => {
    if (/\/qemu\/100\/config$/.test(url)) {
      for (const [k, v] of body) {
        if (k === 'delete') for (const d of v.split(',')) delete state.cfg[d];
        else state.cfg[k] = v;
      }
    }
    return ok('');
  });
  c.post.mockImplementation(() => ok('UPID:fake'));
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return { c, state };
}

const errored = (over: Record<string, unknown> = {}) =>
  ({
    id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1',
    cpu: 1, ram: 1024, storage: 32, hasPassthrough: false, status: 'error', holdReason: null, ...over,
  }) as never;

let row: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  row = { ...(errored() as object) };
  vi.mocked(prisma.virtualMachine.findUnique).mockImplementation(async () => ({ ...row }) as never);
  vi.mocked(prisma.virtualMachine.update).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    row = { ...row, ...data };
    return { ...row } as never;
  });
  vi.mocked(prisma.virtualMachine.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200, accessExpiresAt: null,
  } as never);
});

describe('adopting a 1.0.x error row makes its guest safe before it can start', () => {
  it('re-applies bridge, NIC firewall and isolation, and syncs sizes, before clearing the hold', async () => {
    const { state } = fakePve(LEGACY);
    const adopted = await adoptGuest(errored());

    expect(state.cfg['net0']).toContain('bridge=vmbr0');
    expect(state.cfg['net0']).toContain('firewall=1');
    expect(pve.configureVmIsolation).toHaveBeenCalledWith('pve1', 100, { dnsServers: [], vlanTag: 42 }, expect.anything(), 'qemu');

    const updates = vi.mocked(prisma.virtualMachine.update).mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    const sized = updates.findIndex((d) => d['cpu'] === 2 && d['ram'] === 2048 && d['storage'] === 40);
    const cleared = updates.findIndex((d) => d['status'] === 'stopped' && d['holdReason'] === null);
    expect(sized).toBeGreaterThanOrEqual(0);
    expect(cleared).toBeGreaterThan(sized);
    const isolated = vi.mocked(pve.configureVmIsolation).mock.invocationCallOrder[0]!;
    const clearCall = vi.mocked(prisma.virtualMachine.update).mock.invocationCallOrder[cleared]!;
    expect(isolated).toBeLessThan(clearCall);
    expect(isHeld(adopted)).toBe(false);
  });

  it('keeps the hold when isolation cannot be re-applied', async () => {
    fakePve(LEGACY);
    vi.mocked(pve.configureVmIsolation).mockRejectedValueOnce(new Error('firewall API down'));
    await expect(adoptGuest(errored())).rejects.toBeInstanceOf(AdoptError);
    expect(row['status']).toBe('error');
    expect(prisma.virtualMachine.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ holdReason: null }) }),
    );
  });

  it('keeps a quota hold instead of clearing when the guest\'s disks exceed the owner\'s quota', async () => {
    fakePve({ ...LEGACY, scsi1: 'local-lvm:vm-100-disk-1,size=500G' });
    await expect(adoptGuest(errored())).rejects.toThrow(/quota/i);
    expect(row['holdReason']).toBe(QUOTA_HOLD_MESSAGE);
    expect(row['status']).toBe('error');
  });
});
