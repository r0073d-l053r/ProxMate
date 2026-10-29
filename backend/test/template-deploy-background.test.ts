import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// POST /templates/deploy answers with the `creating` row as soon as it exists; the
// clone, configuration and start run in the background, still registered in flight
// and settled exactly as a create that ran inside the request.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    ideGuestSecret: { deleteMany: vi.fn() },
    ideGatewayToken: { deleteMany: vi.fn() },
    template: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', role: 'user', email: 'u1@example.com' };
    next();
  },
}));
vi.mock('../src/middleware/mfa.js', () => ({
  enforceMfaSetup: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn(), waitForTask: vi.fn() };
});

import templateRouter from '../src/routes/template.routes.js';
import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { notify } from '../src/services/notify.service.js';
import { isInFlight, resetInFlight } from '../src/lib/in-flight.js';
import { createFailureFor, resetCreateFailures } from '../src/lib/create-failures.js';
import { fakeClient, asClient } from './helpers.js';

const VMID = 101;
const vmRow = vi.mocked(prisma.virtualMachine);
const waitForTask = vi.mocked(pve.waitForTask);

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/templates', templateRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const user = { id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200 };
const template = { id: 't1', name: 'Debian 12', os: 'Debian 12', proxmoxVmId: 9000, proxmoxNode: 'pve1', cloudInit: false, diskGb: 5, arch: null, published: true };
const body = { templateId: 't1', name: 'app-01', cpu: 2, ram: 2048, storage: 5 };

/** A clone task that finishes only when the test says so. */
function controlledClone() {
  let finish!: () => void;
  let fail!: (err: Error) => void;
  const task = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  waitForTask.mockImplementationOnce(() => task);
  return { finish: () => finish(), fail: (err: Error) => fail(err) };
}

/** The guest config Proxmox reports at the new VMID (`null`: no guest there). */
let guestConfig: Record<string, string> | null;

function cluster() {
  const c = fakeClient();
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  c.get.mockImplementation((url: string) => {
    if (url === '/cluster/nextid') return ok(String(VMID));
    if (/\/qemu\/101\/config$/.test(url)) {
      if (!guestConfig) return Promise.reject(new Error(`Configuration file 'nodes/pve1/qemu-server/${VMID}.conf' does not exist`));
      return ok(guestConfig);
    }
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'clone failed' });
    return ok(null);
  });
  return c;
}

const post = (b: unknown) =>
  fetch(`${base}/templates/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

/** Let the background provision run until it waits on something again. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const updates = () => vmRow.update.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);

beforeEach(() => {
  vi.clearAllMocks();
  resetInFlight();
  resetCreateFailures();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  guestConfig = { scsi0: 'local-lvm:vm-101-disk-0,size=5G', net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0' };
  vi.mocked(pve.getClient).mockResolvedValue(asClient(cluster()));
  waitForTask.mockResolvedValue(undefined);
  vi.mocked(prisma.template.findUnique).mockResolvedValue(template as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
  vi.mocked(prisma.systemConfig.findUnique).mockImplementation(((args: { where: { key: string } }) =>
    Promise.resolve(args.where.key === 'isolation_enabled' ? { key: 'isolation_enabled', value: 'false' } : null)) as never);
  vmRow.findMany.mockResolvedValue([] as never);
  vmRow.findUnique.mockResolvedValue({ holdReason: null } as never);
  vmRow.create.mockImplementation(((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'vm1', type: 'qemu', ...args.data })) as never);
  vmRow.update.mockImplementation(((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'vm1', type: 'qemu', ...args.data })) as never);
  vmRow.updateMany.mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.$transaction).mockResolvedValue([] as never);
});

describe('POST /templates/deploy', () => {
  it('answers 201 with the creating row before the clone finishes, then runs it to running', async () => {
    const clone = controlledClone();

    const res = await post(body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { vm: { id: string; status: string }; status: string };
    expect(json.vm.id).toBe('vm1');
    expect(json.status).toBe('creating');

    // The clone is still running: the row is held in flight and nothing has been started.
    await settle();
    expect(isInFlight('vm1')).toBe(true);
    expect(updates().some((d) => d['status'] === 'running')).toBe(false);
    expect(updates().some((d) => d['opUpid'] === 'UPID:fake')).toBe(true); // recordOpTask

    clone.finish();
    await settle();
    expect(updates().at(-1)).toMatchObject({ status: 'running' });
    expect(isInFlight('vm1')).toBe(false);
  });

  it('settles a background clone failure like a failed create: the row is dropped and admins told', async () => {
    const clone = controlledClone();
    guestConfig = null; // the failed clone left no guest at the VMID

    expect((await post(body)).status).toBe(201);
    await settle();
    expect(isInFlight('vm1')).toBe(true);

    clone.fail(new pve.TaskFailedError('clone failed'));
    await settle();
    expect(prisma.$transaction).toHaveBeenCalled(); // deleteVmRow
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'vm.error', title: 'app-01' }));
    // The request has answered, so the reason is kept for the owner's next fetch.
    expect(createFailureFor('vm1', { id: 'u1', role: 'user' })).toBe(pve.pveMessage(new pve.TaskFailedError('clone failed')));
    expect(updates().some((d) => d['status'] === 'running')).toBe(false);
    expect(isInFlight('vm1')).toBe(false);
  });

  it('keeps a failed deploy whose guest exists in error', async () => {
    // The clone lands, then starting the guest fails.
    controlledClone().finish();
    waitForTask.mockImplementationOnce(() => Promise.reject(new Error('start failed')));

    expect((await post(body)).status).toBe(201);
    await settle();
    expect(updates().some((d) => d['status'] === 'error')).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(isInFlight('vm1')).toBe(false);
  });

  it('still answers 400 for an invalid request, before any row exists', async () => {
    const res = await post({ ...body, name: 'not valid!' });
    expect(res.status).toBe(400);
    expect(vmRow.create).not.toHaveBeenCalled();
  });

  it('still answers 400 for a cloud image without a way to log in', async () => {
    vi.mocked(prisma.template.findUnique).mockResolvedValue({ ...template, cloudInit: true } as never);
    expect((await post(body)).status).toBe(400);
    expect(vmRow.create).not.toHaveBeenCalled();
  });

  it('still answers 403 with the quota details, before any row exists', async () => {
    vmRow.findMany.mockResolvedValue([{ cpu: 8, ram: 1024, storage: 10 }] as never);
    const res = await post(body);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string; details: Record<string, unknown> };
    expect(json.error).toBe('Quota exceeded');
    expect(json.details['cpu']).toMatchObject({ used: 8, requested: 2, max: 8 });
    expect(vmRow.create).not.toHaveBeenCalled();
  });
});
