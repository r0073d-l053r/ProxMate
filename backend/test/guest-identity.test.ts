import { describe, it, expect, vi, beforeEach } from 'vitest';

// A row's VMID is only a pointer: Proxmox reuses a freed VMID for the next guest
// anyone creates. These tests pin down that a failed create drops its row, that
// new guests carry a marker naming their row, and that actions on a guest are
// refused (or, for delete, limited to the row) when the guest isn't the row's.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    user: { findUnique: vi.fn() },
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
  guestIdentity,
  guestMarker,
  GuestIdentityError,
} from '../src/services/vm.service.js';
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
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'error' } }));
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
    expect(update).toHaveBeenCalledWith({ where: { id: 'rowa' }, data: { status: 'error' } });
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

  it('accepts an unmarked (pre-marker) guest whose name matches, and backfills the marker', async () => {
    const c = pveWith({ name: 'web', tags: 'prod' });
    expect(await guestIdentity(row(), asClient(c))).toBe('ours');
    const put = c.put.mock.calls.find((x) => /\/qemu\/100\/config$/.test(String(x[0])));
    expect(bodyOf(put!)['tags']).toBe(`prod;${guestMarker('rowa')}`);
  });

  it('rejects an unmarked guest with a different name', async () => {
    const c = pveWith({ name: 'someone-else' });
    expect(await guestIdentity(row(), asClient(c))).toBe('foreign');
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
