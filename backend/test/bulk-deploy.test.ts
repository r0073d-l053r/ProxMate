import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';

// Bulk template deploys: the whole batch is judged against quota before anything
// is written or cloned, each copy gets its own VMID and goes through the single
// deploy path, and every copy's outcome is reported on its own.

const rows: Array<Record<string, unknown>> = [];
const USERS: Record<string, Record<string, unknown>> = {
  u1: { id: 'u1', email: 'u1@example.com', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200 },
  u2: { id: 'u2', email: 'u2@example.com', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200 },
  u3: { id: 'u3', email: 'u3@example.com', role: 'user', maxCpu: 1, maxRam: 1024, maxStorage: 10 },
  admin: { id: 'admin', email: 'admin@example.com', role: 'admin', maxCpu: 0, maxRam: 0, maxStorage: 0 },
};

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      findMany: vi.fn(async ({ where }: { where?: { userId?: string } } = {}) =>
        rows.filter((r) => !where?.userId || (r['userId'] === where.userId && !r['quotaExempt'])),
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
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r['id'] === where.id) ?? null),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows.splice(rows.findIndex((r) => r['id'] === where.id), 1);
      }),
    },
    template: { findMany: vi.fn(async () => []) },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => USERS[id]).filter(Boolean),
      ),
    },
    ideGuestSecret: { deleteMany: vi.fn(async () => ({})) },
    ideGatewayToken: { deleteMany: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  },
}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (key: string) => ({ isolation_enabled: 'false' })[key] ?? null),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import * as pve from '../src/services/proxmox.service.js';
import {
  planBatch,
  startTemplateBatch,
  waitForBatch,
  getBatch,
  BulkDeployError,
  expandNamePattern,
} from '../src/services/bulk-deploy.service.js';
import { BatchQuotaError, CreateOptionError, reserveVmIds, releaseVmId, nextVmId } from '../src/services/vm.service.js';
import { recordAudit } from '../src/services/audit.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const template = { id: 't1', name: 'Debian 12', os: 'Debian 12', proxmoxVmId: 9000, proxmoxNode: 'pve1', cloudInit: false, diskGb: 10, arch: null, published: true } as never;
const input = { cpu: 2, ram: 2048, storage: 10 };

/** Guests Proxmox already has (VMIDs refused by /cluster/nextid?vmid=). */
let used: Set<number>;
let failCloneOf: number | null;

function cluster() {
  const c = fakeClient();
  c.get.mockImplementation((url: string, opts?: { params?: { vmid?: number } }) => {
    if (url === '/cluster/nextid') {
      const asked = opts?.params?.vmid;
      if (asked === undefined) {
        let id = 100;
        while (used.has(id)) id += 1;
        return ok(String(id));
      }
      if (used.has(asked)) {
        return Promise.reject(new AxiosError('taken', '400', undefined, undefined, { status: 400 } as never));
      }
      return ok(String(asked));
    }
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    const cfg = /\/qemu\/(\d+)\/config$/.exec(url);
    if (cfg && !used.has(Number(cfg[1]))) return Promise.reject(new Error(`Configuration file for ${cfg[1]} does not exist`));
    if (cfg) return ok({ scsi0: `local-lvm:vm-${cfg[1]}-disk-0,size=10G`, net0: 'virtio,bridge=vmbr0,firewall=1' });
    return ok(null);
  });
  c.post.mockImplementation((url: string, body: URLSearchParams) => {
    if (/\/clone$/.test(url)) {
      const newid = Number(body.get('newid'));
      if (newid === failCloneOf) return Promise.reject(new Error('clone failed: storage full'));
      used.add(newid);
    }
    return ok('UPID:fake');
  });
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  rows.length = 0;
  used = new Set();
  failCloneOf = null;
});

const tenant = { id: 'u1', role: 'user', email: 'u1@example.com' };
const admin = { id: 'admin', role: 'admin', email: 'admin@example.com' };

describe('planning a batch', () => {
  it('expands the name pattern per copy', async () => {
    expect(expandNamePattern('web-{n}', 3)).toBe('web-3');
    const plan = await planBatch(tenant, { namePattern: 'web-{n}', count: 3 });
    expect(plan.map((p) => p.name)).toEqual(['web-1', 'web-2', 'web-3']);
    expect(plan.every((p) => p.owner.id === 'u1')).toBe(true);
  });

  it('enforces the caps: 20 copies for a tenant, 50 for an admin', async () => {
    await expect(planBatch(tenant, { namePattern: 'w-{n}', count: 21 })).rejects.toBeInstanceOf(BulkDeployError);
    expect(await planBatch(tenant, { namePattern: 'w-{n}', count: 20 })).toHaveLength(20);
    expect(await planBatch(admin, { namePattern: 'w-{n}', count: 50 })).toHaveLength(50);
    await expect(planBatch(admin, { namePattern: 'w-{n}', count: 51 })).rejects.toThrow(/between 1 and 50/);
  });

  it('needs {n} for several copies, and valid names', async () => {
    await expect(planBatch(tenant, { namePattern: 'web', count: 2 })).rejects.toThrow(/needs \{n\}/);
    await expect(planBatch(tenant, { namePattern: 'web_{n}', count: 2 })).rejects.toThrow(/not a valid name/);
  });

  it('does not let a tenant deploy into other users’ accounts', async () => {
    await expect(planBatch(tenant, { namePattern: 'w-{n}', forUserIds: ['u2'] })).rejects.toBeInstanceOf(CreateOptionError);
    await expect(planBatch(tenant, { namePattern: 'w-{n}', count: 2, forUserId: 'u2' })).rejects.toBeInstanceOf(CreateOptionError);
    await expect(planBatch(tenant, { namePattern: 'w-{n}', count: 2, quotaExempt: true })).rejects.toBeInstanceOf(CreateOptionError);
  });

  it('gives an admin one copy per chosen user', async () => {
    const plan = await planBatch(admin, { namePattern: 'lab', forUserIds: ['u1', 'u2'] });
    expect(plan.map((p) => [p.owner.id, p.name])).toEqual([['u1', 'lab'], ['u2', 'lab']]);
    await expect(planBatch(admin, { namePattern: 'lab', forUserIds: ['u1', 'nobody'] })).rejects.toThrow(/No such user/);
  });
});

describe('deploying a batch', () => {
  it('refuses the whole batch when it does not fit, writing and cloning nothing', async () => {
    const c = cluster();
    const copies = await planBatch(tenant, { namePattern: 'web-{n}', count: 5 }); // 10 vCPU > 8
    const err = await startTemplateBatch(tenant, template, copies, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatchQuotaError);
    expect((err as BatchQuotaError).owners['u1@example.com']?.['cpu']).toMatchObject({ requested: 10, max: 8 });
    expect(rows).toHaveLength(0);
    expect(c.post).not.toHaveBeenCalled();
  });

  it('a per-user batch is refused as a whole when one user lacks quota', async () => {
    cluster();
    const copies = await planBatch(admin, { namePattern: 'lab', forUserIds: ['u1', 'u3'] });
    const err = await startTemplateBatch(admin, template, copies, input).catch((e: unknown) => e);
    expect(Object.keys((err as BatchQuotaError).owners)).toEqual(['u3@example.com']);
    expect(rows).toHaveLength(0);
  });

  it('deploys each copy on its own VMID and reports each result', async () => {
    const c = cluster();
    failCloneOf = 101;
    const copies = await planBatch(tenant, { namePattern: 'web-{n}', count: 3 });
    const batch = await startTemplateBatch(tenant, template, copies, input);
    // Reserved up front: every row exists (counting toward quota) before any clone.
    expect(batch.items.map((i) => [i.name, i.proxmoxVmId])).toEqual([
      ['web-1', 100],
      ['web-2', 101],
      ['web-3', 102],
    ]);
    expect(rows).toHaveLength(3);
    await waitForBatch(batch.id);

    const seen = getBatch(batch.id, tenant)!;
    expect(seen.items.map((i) => i.status)).toEqual(['done', 'failed', 'done']);
    expect(seen.items[1]!.error).toMatch(/storage full/);
    expect(seen.finishedAt).not.toBeNull();
    const clones = c.post.mock.calls.filter((x) => /\/clone$/.test(String(x[0]))).map((x) => bodyOf(x)['newid']);
    expect(clones.sort()).toEqual(['100', '101', '102']);
    // The failed copy left no guest, so its row is gone; the others are running.
    expect(rows.map((r) => [r['name'], r['status']])).toEqual([['web-1', 'running'], ['web-3', 'running']]);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'template.deploy_bulk_done', detail: expect.stringMatching(/^2\/3/) }));
    // Only the starter (or an admin) can read the batch.
    expect(getBatch(batch.id, { id: 'u2', role: 'user' })).toBeNull();
    expect(getBatch(batch.id, admin)).not.toBeNull();
  });

  it('puts an admin’s per-user copies into each account as admin-managed', async () => {
    cluster();
    const copies = await planBatch(admin, { namePattern: 'lab', forUserIds: ['u1', 'u2'] });
    const batch = await startTemplateBatch(admin, template, copies, { ...input, quotaExempt: true });
    await waitForBatch(batch.id);
    expect(rows.map((r) => [r['userId'], r['adminManaged'], r['quotaExempt']])).toEqual([
      ['u1', true, true],
      ['u2', true, true],
    ]);
  });

  it('skips a reserved VMID it finds taken when its turn comes', async () => {
    const c = cluster();
    // Four copies, three at a time: the fourth waits for a free slot.
    const copies = await planBatch(tenant, { namePattern: 'web-{n}', count: 4 });
    const batch = await startTemplateBatch(tenant, template, copies, { ...input, cpu: 1 });
    used.add(103); // something outside ProxMate took the fourth one's VMID meanwhile
    await waitForBatch(batch.id);
    const clones = c.post.mock.calls.filter((x) => /\/clone$/.test(String(x[0]))).map((x) => bodyOf(x)['newid']);
    expect(clones).toEqual(['100', '101', '102', '104']);
    expect(rows[3]).toMatchObject({ name: 'web-4', proxmoxVmId: 104, status: 'running' });
    expect(getBatch(batch.id, tenant)!.items[3]).toMatchObject({ status: 'done', proxmoxVmId: 104 });
  });
});

describe('a copy removed while it waits', () => {
  it('is not cloned, and the others carry on', async () => {
    const c = cluster();
    const copies = await planBatch(tenant, { namePattern: 'web-{n}', count: 4 });
    const batch = await startTemplateBatch(tenant, template, copies, { ...input, cpu: 1 });
    rows.splice(3, 1); // the owner deleted web-4 before its turn
    await waitForBatch(batch.id);
    const clones = c.post.mock.calls.filter((x) => /\/clone$/.test(String(x[0]))).map((x) => bodyOf(x)['newid']);
    expect(clones).toEqual(['100', '101', '102']);
    expect(getBatch(batch.id, tenant)!.items.map((i) => i.status)).toEqual(['done', 'done', 'done', 'failed']);
    expect(getBatch(batch.id, tenant)!.items[3]!.error).toMatch(/removed before its turn/);
  });
});

describe('a guest tagged for a queued copy appearing at its VMID', () => {
  it('stops that copy and holds its row instead of moving it to another VMID', async () => {
    const c = cluster();
    const base = c.get.getMockImplementation()!;
    const copies = await planBatch(tenant, { namePattern: 'web-{n}', count: 4 });
    const batch = await startTemplateBatch(tenant, template, copies, { ...input, cpu: 1 });
    const fourth = rows[3]!;
    used.add(103);
    c.get.mockImplementation((url: string, opts?: unknown) =>
      url === '/cluster/resources?type=vm'
        ? ok([{ type: 'qemu', vmid: 103, node: 'pve1', tags: `proxmate-${String(fourth['id'])}` }])
        : base(url, opts),
    );
    await waitForBatch(batch.id);
    const clones = c.post.mock.calls.filter((x) => /\/clone$/.test(String(x[0]))).map((x) => bodyOf(x)['newid']);
    expect(clones).toEqual(['100', '101', '102']);
    expect(fourth).toMatchObject({ proxmoxVmId: 103, status: 'error' });
    expect(getBatch(batch.id, tenant)!.items[3]).toMatchObject({ status: 'failed', error: expect.stringMatching(/already exists at its VMID/) });
  });
});

describe('a row still being created', () => {
  it('is refused by every guest-changing path', async () => {
    cluster();
    const { requireOurGuest, STILL_CREATING_MESSAGE } = await import('../src/services/vm.service.js');
    await expect(
      requireOurGuest({ id: 'r', status: 'creating', holdReason: null, proxmoxVmId: 100, proxmoxNode: 'pve1' } as never, {
        allowAbsent: true,
        allowError: true,
      }),
    ).rejects.toThrow(STILL_CREATING_MESSAGE);
  });
});

describe('placing the copies of a batch', () => {
  it('counts copies already placed on a node, so they spread out', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const GB = 1024 ** 3;
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          { type: 'node', node: 'n1', status: 'online', maxcpu: 8, cpu: 0.1, maxmem: 32 * GB, mem: 4 * GB },
          { type: 'node', node: 'n2', status: 'online', maxcpu: 8, cpu: 0.1, maxmem: 32 * GB, mem: 5 * GB },
        ],
      },
    });
    const want = { cpu: 2, ramMb: 4096, storageGb: 10 };
    expect(await pve.pickBestNode(want, undefined, asClient(c))).toBe('n1');
    const pending = new Map([['n1', { cpu: 2, ramMb: 4096, storageGb: 10 }]]);
    expect(await pve.pickBestNode(want, undefined, asClient(c), undefined, undefined, pending)).toBe('n2');
  });
});

describe('VMID reservations', () => {
  it('keeps other creates off VMIDs a batch has reserved', async () => {
    const c = cluster();
    const ids = await reserveVmIds(2, asClient(c));
    expect(ids).toEqual([100, 101]);
    expect(await nextVmId(asClient(c))).toBe(102);
    for (const id of ids) releaseVmId(id);
    expect(await nextVmId(asClient(c))).toBe(100);
  });

  it('never hands the same VMID to two reservations running side by side', async () => {
    const c = cluster();
    const [a, b] = await Promise.all([reserveVmIds(3, asClient(c)), reserveVmIds(3, asClient(c))]);
    expect(new Set([...a!, ...b!]).size).toBe(6);
    for (const id of [...a!, ...b!]) releaseVmId(id);
  });
});
