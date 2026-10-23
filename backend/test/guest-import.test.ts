import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Admin import of a Proxmox guest ProxMate didn't create: only a guest nothing else
// could claim is accepted, and an accepted one gets this row's tag (its other tags
// kept), the isolation firewall a new guest gets, and a row counted toward quota.

const rows: Array<Record<string, unknown>> = [];
/** A row matching a where clause of plain values (Dates compared by time). */
const sameRow = (r: Record<string, unknown>, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) =>
    v instanceof Date ? r[k] instanceof Date && (r[k] as Date).getTime() === v.getTime() : r[k] === v,
  );
const templates: Array<{ proxmoxVmId: number }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      count: vi.fn(async ({ where }: { where: { proxmoxVmId: number } }) =>
        (await sleep(5), rows.filter((r) => r['proxmoxVmId'] === where.proxmoxVmId).length),
      ),
      findMany: vi.fn(async ({ where }: { where?: { userId?: string; quotaExempt?: boolean } } = {}) =>
        rows.filter(
          (r) =>
            (!where?.userId || r['userId'] === where.userId) &&
            (where?.quotaExempt === undefined || r['quotaExempt'] === where.quotaExempt),
        ),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `row${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r['id'] === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows.splice(rows.findIndex((r) => r['id'] === where.id), 1);
      }),
      // The restart reconciler's conditional writes (by id + status + opStartedAt).
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => sameRow(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const i = rows.findIndex((r) => sameRow(r, where));
        if (i < 0) return { count: 0 };
        rows.splice(i, 1);
        return { count: 1 };
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r['id'] === where.id) ?? null),
    },
    ideGuestSecret: { deleteMany: vi.fn(async () => ({})) },
    ideGatewayToken: { deleteMany: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    template: {
      count: vi.fn(async ({ where }: { where: { proxmoxVmId: number } }) =>
        templates.filter((t) => t.proxmoxVmId === where.proxmoxVmId).length,
      ),
      findMany: vi.fn(async () => templates),
    },
  },
}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (key: string) => ({ isolation_enabled: 'true' })[key] ?? null),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import * as pve from '../src/services/proxmox.service.js';
import { importGuest, listImportableGuests, ImportError } from '../src/services/guest-import.service.js';
import { hostLevelKeys } from '../src/lib/guest-config.js';
import { QuotaError, guestMarker } from '../src/services/vm.service.js';
import { recordAudit } from '../src/services/audit.service.js';
import { prisma } from '../src/lib/prisma.js';
import { isInFlight } from '../src/lib/in-flight.js';
import { reconcileCreatingVm, STUCK_AFTER_MS } from '../src/services/task-reconcile.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const ADMIN = { id: 'admin', email: 'admin@example.com' };
const owner = (over: Record<string, unknown> = {}) =>
  ({ id: 'u1', email: 'u1@example.com', role: 'user', maxCpu: 8, maxRam: 8192, maxStorage: 100, ...over }) as never;

const BASE_CFG = {
  name: 'legacy-web',
  cores: '2',
  sockets: '1',
  memory: '2048',
  scsi0: 'local-lvm:vm-200-disk-0,size=20G',
  net0: 'virtio=AA:BB:CC:DD:EE:01,bridge=vmbr0',
  ostype: 'l26',
  tags: 'prod;web',
};

/** A cluster with one QEMU guest at VMID 200 (plus whatever `extra` lists) whose config is `cfg`. */
function cluster(cfg: Record<string, string>, extra: Array<Record<string, unknown>> = []) {
  const c = fakeClient();
  c.get.mockImplementation((url: string) => {
    if (url.startsWith('/cluster/resources')) {
      return ok([
        { type: 'qemu', vmid: 200, node: 'pve1', name: cfg['name'], tags: cfg['tags'], status: 'running', maxcpu: 2, maxmem: 2 * 1024 ** 3, maxdisk: 20 * 1024 ** 3 },
        ...extra,
      ]);
    }
    if (/\/qemu\/200\/config$/.test(url)) return ok(cfg);
    if (/\/qemu\/200\/status\/current$/.test(url)) return ok({ status: 'running' });
    if (/\/firewall\/rules$/.test(url)) return ok([]);
    if (/\/firewall\/ipset/.test(url)) return ok([]);
    return ok(null);
  });
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  templates.length = 0;
});

describe('listing importable guests', () => {
  it('offers only untagged, unreferenced, non-template guests', async () => {
    rows.push({ id: 'r1', proxmoxVmId: 201, userId: 'u1' });
    templates.push({ proxmoxVmId: 9000 });
    cluster(BASE_CFG, [
      { type: 'qemu', vmid: 201, node: 'pve1', name: 'managed' },
      { type: 'qemu', vmid: 202, node: 'pve1', name: 'tagged', tags: 'proxmate-abc' },
      { type: 'qemu', vmid: 203, node: 'pve1', name: 'tpl', template: 1 },
      { type: 'qemu', vmid: 9000, node: 'pve1', name: 'store' },
      { type: 'lxc', vmid: 204, node: 'pve2', name: 'ct', status: 'stopped', maxcpu: 1, maxmem: 512 * 1024 ** 2, maxdisk: 8 * 1024 ** 3 },
      { type: 'storage', storage: 'local' },
    ]);
    const list = await listImportableGuests();
    expect(list.map((g) => g.vmid)).toEqual([200, 204]);
    expect(list[1]).toEqual({ vmid: 204, node: 'pve2', name: 'ct', type: 'lxc', status: 'stopped', cpu: 1, ramMb: 512, diskGb: 8, pool: null });
  });
});

describe('importing a guest', () => {
  describe('with a Proxmox pool configured', () => {
    let base: ((key: string) => Promise<string | null>) | undefined;
    beforeEach(async () => {
      const { getConfig } = await import('../src/services/config.service.js');
      base = vi.mocked(getConfig).getMockImplementation() as never;
      vi.mocked(getConfig).mockImplementation(async (key: string) => (key === 'proxmox_pool' ? 'proxmate' : base!(key)));
    });
    afterEach(async () => {
      const { getConfig } = await import('../src/services/config.service.js');
      vi.mocked(getConfig).mockImplementation(base as never);
    });

    it('adds the imported guest to the pool and says so in the audit entry', async () => {
      const c = cluster(BASE_CFG);
      await importGuest(ADMIN, { vmid: 200, owner: owner() });
      const put = c.put.mock.calls.find((x) => x[0] === '/pools');
      expect(bodyOf(put!)).toEqual({ poolid: 'proxmate', vms: '200', 'allow-move': '1' });
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'vm.import', detail: expect.stringMatching(/added to pool proxmate$/) }),
      );
    });

    it('still imports when the pool refuses the guest, and records why', async () => {
      const c = cluster(BASE_CFG);
      c.put.mockImplementation((url: string) =>
        url === '/pools' ? Promise.reject(new Error('Permission check failed')) : ok(''),
      );
      const { vm } = await importGuest(ADMIN, { vmid: 200, owner: owner() });
      expect(vm).toMatchObject({ proxmoxVmId: 200 });
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.stringMatching(/not added to pool proxmate: Permission check failed/) }),
      );
    });

    it('refuses a guest in another pool unless the admin confirms the move', async () => {
      const c = cluster(BASE_CFG);
      const baseGet = c.get.getMockImplementation()!;
      c.get.mockImplementation((url: string) =>
        url.startsWith('/cluster/resources')
          ? ok([{ type: 'qemu', vmid: 200, node: 'pve1', name: 'legacy-web', tags: 'prod;web', pool: 'lab', status: 'running' }])
          : baseGet(url),
      );
      await expect(importGuest(ADMIN, { vmid: 200, owner: owner() })).rejects.toMatchObject({ code: 'pool_move', status: 409 });
      expect(c.put).not.toHaveBeenCalled();

      const r = await importGuest(ADMIN, { vmid: 200, owner: owner(), movePool: true });
      expect(r.poolNote).toBe('Added to the Proxmox pool proxmate (moved out of lab).');
      expect(bodyOf(c.put.mock.calls.find((x) => x[0] === '/pools')!)).toEqual({ poolid: 'proxmate', vms: '200', 'allow-move': '1' });
    });

    it('leaves a guest that is already in the pool alone', async () => {
      const c = cluster(BASE_CFG);
      const baseGet = c.get.getMockImplementation()!;
      c.get.mockImplementation((url: string) =>
        url.startsWith('/cluster/resources')
          ? ok([{ type: 'qemu', vmid: 200, node: 'pve1', name: 'legacy-web', tags: 'prod;web', pool: 'proxmate', status: 'running' }])
          : baseGet(url),
      );
      await importGuest(ADMIN, { vmid: 200, owner: owner() });
      expect(c.put.mock.calls.some((x) => x[0] === '/pools')).toBe(false);
    });
  });

  it('writes the marker (keeping its tags), applies isolation, records the row and audits it', async () => {
    const c = cluster(BASE_CFG);
    const { vm } = await importGuest(ADMIN, { vmid: 200, owner: owner() });

    expect(vm).toMatchObject({
      userId: 'u1', proxmoxVmId: 200, proxmoxNode: 'pve1', type: 'qemu', name: 'legacy-web',
      cpu: 2, ram: 2048, storage: 20, status: 'running', quotaExempt: false, adminManaged: true,
    });
    const tagPut = c.put.mock.calls.find((x) => /\/qemu\/200\/config$/.test(String(x[0])) && bodyOf(x)['tags']);
    expect(bodyOf(tagPut!)['tags']).toBe(`prod;web;${guestMarker(vm.id)}`);
    const fw = c.put.mock.calls.find((x) => String(x[0]) === '/nodes/pve1/qemu/200/firewall/options');
    expect(bodyOf(fw!)).toMatchObject({ enable: '1', macfilter: '1' });
    // The NIC gets the per-NIC firewall flag, as a new guest's does.
    expect(c.put.mock.calls.some((x) => /firewall=1/.test(bodyOf(x)['net0'] ?? ''))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'vm.import', targetId: vm.id }));
  });

  it('refuses a guest carrying a ProxMate marker', async () => {
    const c = cluster({ ...BASE_CFG, tags: 'proxmate-otherrow' });
    await expect(importGuest(ADMIN, { vmid: 200, owner: owner() })).rejects.toThrow(/carries a ProxMate tag/);
    expect(rows).toHaveLength(0);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('refuses a Proxmox template and a Template Store VMID', async () => {
    cluster({ ...BASE_CFG, template: '1' });
    await expect(importGuest(ADMIN, { vmid: 200, owner: owner() })).rejects.toThrow(/Proxmox template/);
    templates.push({ proxmoxVmId: 200 });
    await expect(importGuest(ADMIN, { vmid: 200, owner: owner() })).rejects.toThrow(/Template Store/);
    expect(rows).toHaveLength(0);
  });

  it('refuses a guest whose disks reference another guest’s volume', async () => {
    const c = cluster({ ...BASE_CFG, scsi1: 'local-lvm:vm-201-disk-0,size=10G' });
    const err = await importGuest(ADMIN, { vmid: 200, owner: owner() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect((err as Error).message).toMatch(/aren't its own \(scsi1\)/);
    expect(rows).toHaveLength(0);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('refuses host devices and a privileged container', async () => {
    cluster({ ...BASE_CFG, hostpci0: '0000:01:00.0' });
    await expect(importGuest(ADMIN, { vmid: 200, owner: owner() })).rejects.toThrow(/hostpci0.*passthrough request/);
    expect(hostLevelKeys({ usb0: 'host=1234:5678', usb1: 'spice', serial0: 'socket' }, 'qemu')).toEqual(['usb0']);
    expect(hostLevelKeys({ unprivileged: '1', dev0: '/dev/ttyUSB0' }, 'lxc')).toEqual(['dev0']);
    expect(hostLevelKeys({ hostname: 'ct' }, 'lxc')).toEqual(['unprivileged']);
  });

  it('refuses a VMID a machine already references', async () => {
    rows.push({ id: 'r1', proxmoxVmId: 200, userId: 'u2' });
    cluster(BASE_CFG);
    await expect(importGuest(ADMIN, { vmid: 200, owner: owner() })).rejects.toThrow(/already references this VMID/);
  });

  it('refuses when it would exceed the owner’s quota, unless marked exempt', async () => {
    cluster(BASE_CFG);
    rows.push({ id: 'r1', proxmoxVmId: 300, userId: 'u1', cpu: 7, ram: 1024, storage: 10, quotaExempt: false });
    await expect(importGuest(ADMIN, { vmid: 200, owner: owner() })).rejects.toBeInstanceOf(QuotaError);
    expect(rows).toHaveLength(1);

    const { vm } = await importGuest(ADMIN, { vmid: 200, owner: owner(), quotaExempt: true, adminManaged: false });
    // An exempt grant is always admin-managed.
    expect(vm).toMatchObject({ quotaExempt: true, adminManaged: true });
  });

  it('lets only one of two concurrent imports of the same VMID succeed', async () => {
    cluster(BASE_CFG);
    const results = await Promise.allSettled([
      importGuest(ADMIN, { vmid: 200, owner: owner() }),
      importGuest({ id: 'admin2' }, { vmid: 200, owner: owner({ id: 'u2', email: 'u2@example.com' }) }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ImportError);
    expect(rows.filter((r) => r['proxmoxVmId'] === 200)).toHaveLength(1);
  });

  it('never tags a guest whose isolation couldn’t be applied, and says what state it is in', async () => {
    const c = cluster(BASE_CFG);
    c.put.mockImplementation((url: string) =>
      /firewall\/options$/.test(url) ? Promise.reject(new Error('firewall unavailable')) : ok(''),
    );
    await expect(importGuest(ADMIN, { vmid: 200, owner: owner() })).rejects.toThrow(
      /not imported: its isolation couldn't be applied.*still unmanaged and untagged/,
    );
    expect(rows).toHaveLength(0);
    expect(c.put.mock.calls.some((x) => bodyOf(x)['tags'])).toBe(false);
  });

  it('keeps the row in creating until the guest is isolated and tagged', async () => {
    const c = cluster(BASE_CFG);
    const seen: unknown[] = [];
    c.put.mockImplementation((url: string, body: URLSearchParams) => {
      if (/firewall\/options$/.test(url) || body.get('tags')) seen.push(rows[0]?.['status']);
      return ok('');
    });
    await importGuest(ADMIN, { vmid: 200, owner: owner() });
    expect(seen.every((s) => s === 'creating')).toBe(true);
    // Isolation is applied before the tag is written.
    const order = c.put.mock.calls.map((x) => (bodyOf(x)['tags'] ? 'tag' : /firewall\/options$/.test(String(x[0])) ? 'fw' : null)).filter(Boolean);
    expect(order.indexOf('fw')).toBeLessThan(order.indexOf('tag'));
  });

  it('refuses a guest whose snapshots hold what the live config may not', async () => {
    for (const snapCfg of [
      { args: '-drive file=/dev/sdb' },
      { usb0: 'host=1234:5678' },
      { serial0: '/dev/ttyS0' },
      { hookscript: 'local:snippets/hook.sh' },
      { virtiofs0: 'dirid=share' },
      { hostpci0: '0000:01:00.0' },
      { scsi1: 'local-lvm:vm-201-disk-0,size=10G' },
    ]) {
      rows.length = 0;
      const c = cluster(BASE_CFG);
      const base = c.get.getMockImplementation()!;
      c.get.mockImplementation((url: string) => {
        if (/\/qemu\/200\/snapshot$/.test(url)) return ok([{ name: 'before-upgrade' }, { name: 'current' }]);
        if (/\/qemu\/200\/snapshot\/before-upgrade\/config$/.test(url)) return ok({ ...BASE_CFG, ...snapCfg });
        return base(url);
      });
      await expect(importGuest(ADMIN, { vmid: 200, owner: owner() })).rejects.toThrow(
        new RegExp(`snapshots holding .*"before-upgrade": ${Object.keys(snapCfg)[0]}.*Delete those snapshots`),
      );
      expect(rows).toHaveLength(0);
      expect(c.put).not.toHaveBeenCalled();
    }
  });

  it('accepts clean snapshots', async () => {
    const c = cluster(BASE_CFG);
    const base = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) => {
      if (/\/qemu\/200\/snapshot$/.test(url)) return ok([{ name: 'clean' }, { name: 'current' }]);
      if (/\/snapshot\/clean\/config$/.test(url)) return ok({ ...BASE_CFG, vmstate: 'local-lvm:vm-200-state-clean' });
      return base(url);
    });
    await expect(importGuest(ADMIN, { vmid: 200, owner: owner() })).resolves.toMatchObject({ vm: { proxmoxVmId: 200 } });
  });

  it('treats virtiofs and ivshmem as host-level', () => {
    expect(hostLevelKeys({ virtiofs0: 'dirid=x', ivshmem: 'size=32', parallel0: '/dev/parport0' }, 'qemu')).toEqual([
      'virtiofs0',
      'ivshmem',
      'parallel0',
    ]);
  });
});

describe('imports and the restart reconciler', () => {
  it('keeps the import in flight while it runs, records it as an import, and clears that once settled', async () => {
    const c = cluster(BASE_CFG);
    const seen: boolean[] = [];
    const put = c.put.getMockImplementation()!;
    c.put.mockImplementation((url: string, body: URLSearchParams) => {
      const id = rows[0]?.['id'] as string | undefined;
      if (id) seen.push(isInFlight(id));
      return put(url, body);
    });
    const { vm } = await importGuest(ADMIN, { vmid: 200, owner: owner() });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(isInFlight(vm.id)).toBe(false);
    expect(vm).toMatchObject({ opKind: null, opStartedAt: null, opUpid: null });
    expect(vi.mocked(prisma.virtualMachine.create).mock.calls[0]![0].data).toMatchObject({ opKind: 'import' });
  });

  const stuck = () => {
    const old = new Date(Date.now() - STUCK_AFTER_MS - 60_000);
    const row = {
      id: 'imp1', userId: 'u1', name: 'legacy-web', type: 'qemu', proxmoxVmId: 200, proxmoxNode: 'pve1',
      status: 'creating', holdReason: null, opKind: 'import', opStartedAt: old, opUpid: null, updatedAt: old,
    };
    rows.push(row);
    return row as never;
  };

  it('completes an interrupted import whose tag (written after isolation, as the last step) is on the guest', async () => {
    const c = cluster({ ...BASE_CFG, tags: `prod;web;${guestMarker('imp1')}` });
    expect(await reconcileCreatingVm(stuck(), asClient(c), new Date())).toBe('completed');
    expect(rows[0]).toMatchObject({ status: 'running', holdReason: null, opKind: null });
    expect(c.put).not.toHaveBeenCalled();
    expect(c.post).not.toHaveBeenCalled();
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('drops the row of an interrupted import whose guest was never tagged, leaving the guest importable', async () => {
    const c = cluster(BASE_CFG);
    expect(await reconcileCreatingVm(stuck(), asClient(c), new Date())).toBe('dropped');
    expect(rows).toHaveLength(0);
    expect(c.put).not.toHaveBeenCalled();
    expect(c.delete).not.toHaveBeenCalled();
  });
});
