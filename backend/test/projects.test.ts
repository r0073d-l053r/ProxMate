import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Projects group VMs by a `project:<name>` tag. The view is built from the DB
// alone and is scoped like the VMs list: a tenant sees their own VMs by project
// and VMs shared with them in one flat group with no tags; an admin sees every
// owner's VMs.

type Row = {
  id: string; userId: string; name: string; type: string; status: string;
  cpu: number; ram: number; storage: number; tags: string | null;
};
const VMS: Row[] = [
  { id: 'a1', userId: 'alice', name: 'web-1', type: 'qemu', status: 'running', cpu: 2, ram: 2048, storage: 20, tags: 'prod,project:shop' },
  { id: 'a2', userId: 'alice', name: 'web-2', type: 'qemu', status: 'stopped', cpu: 4, ram: 4096, storage: 40, tags: 'project:shop' },
  { id: 'a3', userId: 'alice', name: 'scratch', type: 'lxc', status: 'running', cpu: 1, ram: 512, storage: 8, tags: null },
  { id: 'b1', userId: 'bob', name: 'db', type: 'qemu', status: 'running', cpu: 8, ram: 8192, storage: 100, tags: 'project:secret-plan' },
  { id: 'b2', userId: 'bob', name: 'cache', type: 'qemu', status: 'stopped', cpu: 2, ram: 1024, storage: 10, tags: 'project:secret-plan' },
];
// bob shared one VM with alice as an operator.
const SHARES = [{ vmId: 'b1', userId: 'alice', role: 'operator' }];
const SAMPLES = [
  { vmId: 'a1', cpu: 0.5, mem: 1000 },
  { vmId: 'a1', cpu: 0.1, mem: 3000 },
  { vmId: 'a2', cpu: 0.9, mem: 2000 },
  { vmId: 'b1', cpu: 0.2, mem: 6000 },
  { vmId: 'b2', cpu: 0.4, mem: 500 },
];

type Where = { id?: { in: string[] }; userId?: string; OR?: Where[]; vmId?: { in: string[] } };
function matches(v: Row, w: Where | undefined): boolean {
  if (!w) return true;
  if (w.OR && !w.OR.some((o) => matches(v, o))) return false;
  if (w.id && !w.id.in.includes(v.id)) return false;
  if (w.userId !== undefined && v.userId !== w.userId) return false;
  return true;
}

const update = vi.fn(async () => ({}));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      findMany: vi.fn(async ({ where }: { where?: Where }) => VMS.filter((v) => matches(v, where)).map((v) => ({ ...v }))),
      update: (...a: unknown[]) => update(...(a as [])),
    },
    vmShare: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => SHARES.filter((s) => s.userId === where.userId)),
    },
    user: {
      findMany: vi.fn(async () => [
        { id: 'admin', email: 'admin@example.com', displayName: 'Admin', role: 'admin' },
        { id: 'alice', email: 'alice@example.com', displayName: 'Alice', role: 'user' },
        { id: 'bob', email: 'bob@example.com', displayName: 'Bob', role: 'user' },
      ]),
    },
    resourceSample: {
      groupBy: vi.fn(async ({ where }: { where: Where }) => {
        const by = new Map<string, { n: number; cpu: number; mem: number }>();
        for (const s of SAMPLES) {
          if (where.vmId && !where.vmId.in.includes(s.vmId)) continue;
          const a = by.get(s.vmId) ?? { n: 0, cpu: 0, mem: 0 };
          a.n += 1; a.cpu += s.cpu; a.mem += s.mem;
          by.set(s.vmId, a);
        }
        return [...by].map(([vmId, a]) => ({ vmId, _count: { _all: a.n }, _avg: { cpu: a.cpu / a.n, mem: a.mem / a.n } }));
      }),
    },
  },
}));

let caller = { id: 'alice', email: 'alice@example.com', displayName: 'Alice', role: 'user' };
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = caller;
    next();
  },
}));
vi.mock('../src/middleware/mfa.js', () => ({
  enforceMfaSetup: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const recordAudit = vi.fn(async () => undefined);
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: (...a: unknown[]) => recordAudit(...(a as [])) }));

import projectRouter from '../src/routes/project.routes.js';
import {
  normalizeProjectName,
  projectOf,
  withProject,
  rollupProject,
  getProjectsView,
} from '../src/services/project.service.js';

let server: http.Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/projects', projectRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  update.mockClear();
  recordAudit.mockClear();
  caller = { id: 'alice', email: 'alice@example.com', displayName: 'Alice', role: 'user' };
});

const alice = { id: 'alice', email: 'alice@example.com', displayName: 'Alice', role: 'user' };
const admin = { id: 'admin', email: 'admin@example.com', displayName: 'Admin', role: 'admin' };

describe('project tags', () => {
  it('normalizes valid names and refuses the rest', () => {
    expect(normalizeProjectName('  Shop-2026 ')).toBe('shop-2026');
    expect(normalizeProjectName('a_b')).toBe('a_b');
    expect(normalizeProjectName('x'.repeat(32))).toBe('x'.repeat(32));
    for (const bad of ['', '   ', '-lead', '_lead', 'has space', 'a:b', 'a,b', 'x'.repeat(33), 'emoji✓']) {
      expect(normalizeProjectName(bad), bad).toBeNull();
    }
  });

  it('reads the project from the tag list, ignoring malformed project tags', () => {
    expect(projectOf('prod,project:shop')).toBe('shop');
    expect(projectOf('prod')).toBeNull();
    expect(projectOf(null)).toBeNull();
    expect(projectOf('project:,project:Bad Name')).toBeNull();
  });

  it('sets, replaces and clears the project while keeping the other tags', () => {
    expect(withProject('prod,web', 'shop')).toBe('prod,web,project:shop');
    expect(withProject('prod,project:old,web', 'new')).toBe('prod,web,project:new');
    expect(withProject('prod,project:old', null)).toBe('prod');
    expect(withProject('project:old', null)).toBeNull();
    expect(withProject(null, 'shop')).toBe('project:shop');
  });
});

describe('rollup math', () => {
  const rows = [
    { id: 'x', name: 'x', type: 'qemu', status: 'running', cpu: 2, ram: 2048, storage: 20, access: 'owner' as const },
    { id: 'y', name: 'y', type: 'qemu', status: 'stopped', cpu: 4, ram: 1024, storage: 30, access: 'owner' as const },
    { id: 'z', name: 'z', type: 'qemu', status: 'running', cpu: 1, ram: 512, storage: 5, access: 'owner' as const },
  ];

  it('totals allocation and counts running VMs', () => {
    const r = rollupProject('p', rows, new Map());
    expect([r.vmCount, r.running, r.cpu, r.ram, r.storage]).toEqual([3, 2, 7, 3584, 55]);
    expect(r.usage).toEqual({ samples: 0, avgCpuPct: 0, avgMemBytes: 0 });
  });

  it('weights CPU by sample count and sums per-VM average memory', () => {
    const stats = new Map([
      ['x', { samples: 3, avgCpu: 0.5, avgMem: 1000 }],
      ['y', { samples: 1, avgCpu: 0.1, avgMem: 500 }],
    ]);
    const r = rollupProject('p', rows, stats);
    // (0.5×3 + 0.1×1) / 4 = 0.4 → 40%
    expect(r.usage).toEqual({ samples: 4, avgCpuPct: 40, avgMemBytes: 1500 });
    expect(r.vms.find((v) => v.id === 'z')!.usage).toBeNull();
  });
});

describe('getProjectsView scoping', () => {
  it("gives a tenant their own VMs by project, and never another tenant's project names", async () => {
    const view = await getProjectsView(alice);
    expect(view.owners).toHaveLength(1);
    expect(view.owners[0]!.owner.id).toBe('alice');
    const projects = view.owners[0]!.projects;
    expect(projects.map((p) => p.name)).toEqual(['shop', null]);
    expect(projects[0]!.vms.map((v) => v.id)).toEqual(['a1', 'a2']);
    expect(projects[0]).toMatchObject({ vmCount: 2, running: 1, cpu: 6, ram: 6144, storage: 60 });
    // a1: (0.5+0.1)/2 over 2 samples, a2: 0.9 over 1 → (0.6+0.9)/3 = 50%; mem 2000 + 2000.
    expect(projects[0]!.usage).toEqual({ samples: 3, avgCpuPct: 50, avgMemBytes: 4000 });

    const json = JSON.stringify(view);
    expect(json).not.toContain('secret-plan');
    expect(json).not.toContain('"b2"');
    expect(json).not.toContain('cache');
  });

  it('lists a shared VM only in the flat shared group, with the share role and no tags', async () => {
    const view = await getProjectsView(alice);
    expect(view.shared).not.toBeNull();
    expect(view.shared!.name).toBeNull();
    expect(view.shared!.vms).toEqual([
      expect.objectContaining({ id: 'b1', access: 'operator' }),
    ]);
    expect(view.shared!.vms[0]).not.toHaveProperty('tags');
    expect(view.owners.flatMap((o) => o.projects.flatMap((p) => p.vms)).map((v) => v.id)).not.toContain('b1');
  });

  it('gives a tenant with no VMs and no shares an empty view', async () => {
    const view = await getProjectsView({ id: 'carol', email: 'c@example.com', displayName: 'Carol', role: 'user' });
    expect(view).toEqual({ days: 7, owners: [], shared: null });
  });

  it('gives an admin every owner, grouped by owner then project', async () => {
    const view = await getProjectsView(admin);
    expect(view.shared).toBeNull();
    expect(view.owners.map((o) => o.owner.id)).toEqual(['alice', 'bob']);
    const bob = view.owners[1]!;
    expect(bob.projects.map((p) => p.name)).toEqual(['secret-plan']);
    expect(bob.projects[0]!.vms.every((v) => v.access === 'admin')).toBe(true);
    expect(bob.projects[0]!.usage.avgCpuPct).toBe(30);
  });

  it('clamps the usage window', async () => {
    expect((await getProjectsView(alice, 0)).days).toBe(1);
    expect((await getProjectsView(alice, Number.NaN)).days).toBe(7);
    expect((await getProjectsView(alice, 500)).days).toBe(90);
    expect((await getProjectsView(alice, 3)).days).toBe(3);
  });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/projects/assign', () => {
  it("moves the caller's own VMs and reports another tenant's as not found", async () => {
    const res = await post('/projects/assign', { ids: ['a3', 'b1'], project: ' Shop ' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: string; results: Array<{ id: string; ok: boolean; error?: string }> };
    expect(body.project).toBe('shop');
    expect(body.results).toEqual([{ id: 'a3', ok: true }, { id: 'b1', ok: false, error: 'not found' }]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 'a3' }, data: { tags: 'project:shop' } });
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it('does not let a sharee move a VM shared with them', async () => {
    const res = await post('/projects/assign', { ids: ['b1'], project: 'mine-now' });
    const body = (await res.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results[0]!.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('clears the project with null, keeping the other tags', async () => {
    const res = await post('/projects/assign', { ids: ['a1'], project: null });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { tags: 'prod' } });
  });

  it('lets an admin move any VM', async () => {
    caller = admin;
    const res = await post('/projects/assign', { ids: ['b2'], project: 'archive' });
    const body = (await res.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results[0]!.ok).toBe(true);
    expect(update).toHaveBeenCalledWith({ where: { id: 'b2' }, data: { tags: 'project:archive' } });
  });

  it('refuses an invalid project name', async () => {
    const res = await post('/projects/assign', { ids: ['a1'], project: 'bad name!' });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an empty id list', async () => {
    const res = await post('/projects/assign', { ids: [], project: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/projects', () => {
  it("returns the caller's scoped view", async () => {
    const res = await fetch(`${base}/projects?days=14`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; owners: Array<{ owner: { id: string } }> };
    expect(body.days).toBe(14);
    expect(body.owners.map((o) => o.owner.id)).toEqual(['alice']);
  });
});
