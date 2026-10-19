import { describe, it, expect, vi, beforeEach } from 'vitest';

// A row's VMID is only a pointer: Proxmox reuses a freed VMID for the next guest
// anyone creates. These tests pin down that a failed create drops its row, that
// new guests carry a marker naming their row, and that actions on a guest are
// refused (or, for delete, limited to the row) when the guest isn't the row's.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    user: { findUnique: vi.fn() },
    template: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    ideGuestSecret: { deleteMany: vi.fn(async () => ({})) },
    ideGatewayToken: { deleteMany: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (key: string) =>
    ({ default_storage: 'local-lvm', default_bridge: 'vmbr0', iso_storage: 'local' })[key] ?? null,
  ),
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(),
    getIsoNodes: vi.fn(async () => ['pve1']),
    pickBestNode: vi.fn(async () => 'pve1'),
    getNextVmId: vi.fn(async () => 100),
    readIsolationOptions: vi.fn(async () => ({})),
    configureVmIsolation: vi.fn(async () => undefined),
  };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import {
  createVm,
  destroyVm,
  stopVm,
  pauseVm,
  resumeVm,
  resetGuestPassword,
  addGuestSshKey,
  migrateVmToNode,
  guestIdentity,
  guestMarker,
  backfillGuestMarkers,
  GuestIdentityError,
} from '../src/services/vm.service.js';
import { convertVmToTemplate } from '../src/services/template.service.js';
import { listDisks } from '../src/services/disk.service.js';
import { createMateState } from '../src/services/matestate.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const create = vi.mocked(prisma.virtualMachine.create);
const update = vi.mocked(prisma.virtualMachine.update);
const del = vi.mocked(prisma.virtualMachine.delete);
const getClient = vi.mocked(pve.getClient);

const user = { id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200 } as never;
const row = (over: Record<string, unknown> = {}) =>
  ({ id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1', status: 'running', ...over }) as never;

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const missing = () =>
  Promise.reject(new Error("Configuration file 'nodes/pve1/qemu-server/100.conf' does not exist"));

/** A fake PVE whose guest 100 has `cfg` (or doesn't exist when cfg is null). */
function pveWith(cfg: Record<string, string> | null) {
  const c = fakeClient();
  c.get.mockImplementation((url: string) => {
    if (url === '/cluster/resources') return ok(cfg ? [{ type: 'qemu', vmid: 100, node: 'pve1' }] : []);
    if (/\/qemu\/100\/config$/.test(url)) return cfg ? ok(cfg) : missing();
    if (/\/qemu\/100\/status\/current$/.test(url)) return ok({ status: 'stopped' });
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    return ok(null);
  });
  getClient.mockResolvedValue(asClient(c));
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([] as never);
  create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'rowa', ...data }) as never);
  update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'rowa', ...data }) as never);
  del.mockResolvedValue({} as never);
});

const input = { name: 'web', cpu: 1, ram: 1024, storage: 10, os: 'debian.iso' };

describe('failed create', () => {
  it('drops the row when Proxmox never created the guest (its VMID goes back to the pool)', async () => {
    const c = pveWith(null);
    c.post.mockRejectedValue(new Error('parameter verification failed'));

    await expect(createVm(user, input)).rejects.toThrow(/parameter verification/);
    expect(del).toHaveBeenCalledWith({ where: { id: 'rowa' } });
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'error' }) }));
  });

  it('drops the row when the VMID turned out to hold another row\'s guest', async () => {
    const c = pveWith({ name: 'web', tags: guestMarker('rowb') });
    c.post.mockRejectedValue(new Error('VM 100 already exists'));

    await expect(createVm(user, input)).rejects.toThrow();
    expect(del).toHaveBeenCalledWith({ where: { id: 'rowa' } });
  });

  it('keeps the row in error when our own guest exists (the owner can see and delete it)', async () => {
    const c = pveWith({ name: 'web', tags: guestMarker('rowa') });
    // Create succeeds, then the start fails.
    c.post.mockImplementation((url: string) =>
      /status\/start$/.test(url) ? Promise.reject(new Error('start failed')) : ok('UPID:fake'),
    );

    await expect(createVm(user, input)).rejects.toThrow(/start failed/);
    expect(del).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ where: { id: 'rowa' }, data: expect.objectContaining({ status: 'error', holdReason: expect.any(String) }) });
  });

  it('tags the new guest with its row marker at create time', async () => {
    const c = pveWith({ name: 'web', tags: guestMarker('rowa') });
    await createVm(user, input);
    const post = c.post.mock.calls.find((x) => String(x[0]) === '/nodes/pve1/qemu');
    expect(bodyOf(post!)['tags']).toBe(guestMarker('rowa'));
  });
});

describe('guestIdentity', () => {
  it('accepts a guest that carries this row\'s marker', async () => {
    const c = pveWith({ name: 'renamed', tags: `foo;${guestMarker('rowa')}` });
    expect(await guestIdentity(row(), asClient(c))).toBe('ours');
  });

  it('rejects a guest carrying another row\'s marker even if the name matches', async () => {
    const c = pveWith({ name: 'web', tags: guestMarker('rowb') });
    expect(await guestIdentity(row(), asClient(c))).toBe('foreign');
  });

  it('never treats an untagged guest as ours at runtime, even with a matching name (and writes nothing)', async () => {
    const c = pveWith({ name: 'web', tags: 'prod' });
    expect(await guestIdentity(row(), asClient(c))).toBe('unmarked');
    expect(c.put).not.toHaveBeenCalled();
  });

  it('refuses an action on an untagged guest with an ask-an-admin message', async () => {
    pveWith({ name: 'web' });
    await expect(stopVm(row(), true)).rejects.toThrow(/ask an admin/i);
  });

  it('reports an empty VMID as absent', async () => {
    const c = pveWith(null);
    expect(await guestIdentity(row(), asClient(c))).toBe('absent');
  });
});

describe('actions on a guest that is not the row\'s', () => {
  it('delete removes only the row and never touches the other guest', async () => {
    const c = pveWith({ name: 'other', tags: guestMarker('rowb') });
    await destroyVm(row());
    expect(c.delete).not.toHaveBeenCalled();
    expect(c.post.mock.calls.some((x) => /status\/stop$/.test(String(x[0])))).toBe(false);
    expect(del).toHaveBeenCalledWith({ where: { id: 'rowa' } });
  });

  it('delete still destroys the row\'s own guest', async () => {
    const c = pveWith({ name: 'web', tags: guestMarker('rowa') });
    await destroyVm(row());
    expect(c.delete.mock.calls.some((x) => /\/qemu\/100$/.test(String(x[0])))).toBe(true);
  });

  it('backup is refused (nothing is snapshotted into this row\'s backup list)', async () => {
    const c = pveWith({ name: 'other', tags: guestMarker('rowb') });
    await expect(createMateState(row())).rejects.toBeInstanceOf(GuestIdentityError);
    expect(c.post).not.toHaveBeenCalled();
  });

  it('stop is refused', async () => {
    const c = pveWith({ name: 'other', tags: guestMarker('rowb') });
    await expect(stopVm(row(), true)).rejects.toBeInstanceOf(GuestIdentityError);
    expect(c.post).not.toHaveBeenCalled();
  });
});

describe('every path that changes a guest or hands over control of it is refused for a foreign guest', () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHfXm3PpXcVSyCTXlq2WCyDPeeVGrLYU2VgYPBYcqvlj dev@laptop';
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['guest password reset', () => resetGuestPassword(row(), 'root')],
    ['SSH key injection', () => addGuestSshKey(row(), 'root', KEY)],
    ['pause', () => pauseVm(row())],
    ['resume', () => resumeVm(row())],
    ['migration', () => migrateVmToNode(row(), 'pve2')],
    ['convert to template', () => convertVmToTemplate(row(), { name: 'tpl' })],
  ];
  for (const [label, run] of cases) {
    it(label, async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ role: 'user', accessExpiresAt: null } as never);
      const c = pveWith({ name: 'other', tags: guestMarker('rowb') });
      await expect(run()).rejects.toBeInstanceOf(GuestIdentityError);
      expect(c.post).not.toHaveBeenCalled();
      expect(c.put).not.toHaveBeenCalled();
    });
  }

  it('convert to template also refuses the row\'s own guest when it carries a PCI device', async () => {
    const c = pveWith({ name: 'web', tags: guestMarker('rowa'), hostpci0: 'mapping=gpu' });
    await expect(convertVmToTemplate(row(), { name: 'tpl' })).rejects.toThrow(/passthrough/i);
    expect(c.post).not.toHaveBeenCalled();
  });
});

describe('read-only views of a foreign guest', () => {
  it('list no disks', async () => {
    pveWith({ name: 'other', tags: guestMarker('rowb'), scsi0: 'local-lvm:vm-100-disk-0,size=10G' });
    expect(await listDisks(row())).toEqual([]);
  });
});

describe('destroy when the guest\'s whereabouts are unknown', () => {
  it('keeps the row when the VMID is empty on the stored node but the cluster lookup failed', async () => {
    const c = pveWith(null);
    const base = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) =>
      url === '/cluster/resources' ? Promise.reject(new Error('cluster unreachable')) : base(url),
    );
    await expect(destroyVm(row())).rejects.toThrow(/try again/i);
    expect(del).not.toHaveBeenCalled();
  });

  it('drops only the row when the cluster confirms the VMID is empty', async () => {
    pveWith(null);
    await destroyVm(row());
    expect(del).toHaveBeenCalledWith({ where: { id: 'rowa' } });
  });

  it('a row-only delete is refused while the cluster lookup fails (C2)', async () => {
    const c = pveWith(null);
    const base = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) =>
      url === '/cluster/resources' ? Promise.reject(new Error('cluster unreachable')) : base(url),
    );
    await expect(destroyVm(row(), { rowOnly: true })).rejects.toThrow(/try again/i);
    expect(del).not.toHaveBeenCalled();
  });

  it('a row-only delete still removes the row once the cluster confirms the VMID is empty (C2)', async () => {
    pveWith(null);
    await destroyVm(row(), { rowOnly: true });
    expect(del).toHaveBeenCalledWith({ where: { id: 'rowa' } });
  });
});

describe('backfillGuestMarkers (one-time startup tagging of pre-marker guests)', () => {
  /** Rows + a cluster where each vmid maps to { name, tags } and its config. */
  function cluster(rows: Array<Record<string, unknown>>, guests: Record<number, Record<string, string>>) {
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue(rows as never);
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url.startsWith('/cluster/resources')) {
        return ok(Object.entries(guests).map(([vmid, g]) => ({ type: 'qemu', vmid: Number(vmid), node: 'pve1', ...g })));
      }
      const m = /\/qemu\/(\d+)\/config$/.exec(url);
      if (m) return guests[Number(m[1])] ? ok(guests[Number(m[1])]) : missing();
      return ok(null);
    });
    getClient.mockResolvedValue(asClient(c));
    return c;
  }
  const tagsPut = (c: ReturnType<typeof fakeClient>, vmid: number) =>
    c.put.mock.calls.filter((x) => String(x[0]) === `/nodes/pve1/qemu/${vmid}/config`).map((x) => bodyOf(x)['tags']);

  it('tags an unambiguous match, keeping its other tags', async () => {
    const c = cluster([{ id: 'rowa', name: 'web', proxmoxVmId: 100, proxmoxNode: 'pve1', status: 'running', type: 'qemu' }], {
      100: { name: 'web', tags: 'prod' },
    });
    const r = await backfillGuestMarkers();
    expect(r.tagged).toBe(1);
    expect(tagsPut(c, 100)).toEqual([`prod;${guestMarker('rowa')}`]);
  });

  it('leaves alone (and reports) a name mismatch, an error row, two rows on one VMID, and another row\'s tag', async () => {
    const c = cluster(
      [
        { id: 'r1', name: 'web', proxmoxVmId: 101, proxmoxNode: 'pve1', status: 'running', type: 'qemu' },
        { id: 'r2', name: 'db', proxmoxVmId: 102, proxmoxNode: 'pve1', status: 'error', type: 'qemu' },
        { id: 'r3', name: 'x', proxmoxVmId: 103, proxmoxNode: 'pve1', status: 'running', type: 'qemu' },
        { id: 'r4', name: 'x', proxmoxVmId: 103, proxmoxNode: 'pve1', status: 'stopped', type: 'qemu' },
        { id: 'r5', name: 'y', proxmoxVmId: 104, proxmoxNode: 'pve1', status: 'running', type: 'qemu' },
      ],
      {
        101: { name: 'someone-else' },
        102: { name: 'db' },
        103: { name: 'x' },
        104: { name: 'y', tags: guestMarker('elsewhere') },
      },
    );
    const r = await backfillGuestMarkers();
    expect(r.tagged).toBe(0);
    expect(c.put).not.toHaveBeenCalled();
    expect(r.unmatched.map((u) => u.id).sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  });

  it('is idempotent: an already-tagged guest is left as is', async () => {
    const c = cluster([{ id: 'rowa', name: 'web', proxmoxVmId: 100, proxmoxNode: 'pve1', status: 'running', type: 'qemu' }], {
      100: { name: 'web', tags: guestMarker('rowa') },
    });
    const r = await backfillGuestMarkers();
    expect(r).toEqual({ tagged: 0, unmatched: [], errors: 0 });
    expect(c.put).not.toHaveBeenCalled();
  });
});
