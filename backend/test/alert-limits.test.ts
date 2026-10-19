import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Alert rules are bounded per VM, duplicates are refused, and the rules that fire
// for one VM in a tick produce one email and one webhook post, not one per rule.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    alertRule: {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'r-new', ...data })),
      findMany: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    user: { findUnique: vi.fn(async () => ({ email: 'owner@example.com' })) },
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', role: 'user' };
    next();
  },
  allowExpiredAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/middleware/mfa.js', () => ({
  enforceMfaSetup: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/services/audit.service.js', () => ({
  recordAudit: vi.fn(async () => undefined),
  listAuditForTarget: vi.fn(async () => []),
}));
vi.mock('../src/services/config.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/config.service.js')>()),
  getConfig: vi.fn(async () => null),
}));
vi.mock('../src/services/mail.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/mail.service.js')>()),
  isMailConfigured: vi.fn(async () => true),
  sendMail: vi.fn(async () => undefined),
}));
vi.mock('../src/services/notify.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/notify.service.js')>()),
  notifyWebhook: vi.fn(async () => undefined),
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/proxmox.service.js')>()),
  getClient: vi.fn(),
}));
vi.mock('../src/services/vm.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vm.service.js')>();
  return {
    ...actual,
    getVmWithCap: vi.fn(async () => ({ id: 'vm1', userId: 'u1', name: 'web' })),
  };
});

import vmRouter from '../src/routes/vm.routes.js';
import { prisma } from '../src/lib/prisma.js';
import { evaluateAlerts, MAX_ALERT_RULES_PER_VM } from '../src/services/alert.service.js';
import { sendMail } from '../src/services/mail.service.js';
import { notifyWebhook } from '../src/services/notify.service.js';
import * as pve from '../src/services/proxmox.service.js';
import { guestMarker } from '../src/services/vm.service.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/vms', vmRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.alertRule.count).mockResolvedValue(0);
  vi.mocked(prisma.alertRule.findFirst).mockResolvedValue(null);
});

const add = (body: unknown) =>
  fetch(`${base}/vms/vm1/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/vms/:id/alerts', () => {
  it('creates a rule under the cap', async () => {
    expect((await add({ metric: 'cpu', threshold: 90 })).status).toBe(201);
    expect(prisma.alertRule.create).toHaveBeenCalled();
  });

  it('refuses a rule beyond the per-VM cap', async () => {
    vi.mocked(prisma.alertRule.count).mockResolvedValue(MAX_ALERT_RULES_PER_VM);
    const res = await add({ metric: 'cpu', threshold: 90 });
    expect(res.status).toBe(409);
    expect(prisma.alertRule.create).not.toHaveBeenCalled();
  });

  it('refuses a duplicate metric/threshold on the same VM', async () => {
    vi.mocked(prisma.alertRule.findFirst).mockResolvedValue({ id: 'r1' } as never);
    const res = await add({ metric: 'down' });
    expect(res.status).toBe(409);
    expect(prisma.alertRule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { vmId: 'vm1', metric: 'down', threshold: 0 } }),
    );
    expect(prisma.alertRule.create).not.toHaveBeenCalled();
  });
});

describe('evaluateAlerts delivery', () => {
  it('sends one email and one webhook per VM however many of its rules fire', async () => {
    const vm = { id: 'vm1', name: 'web', userId: 'u1', proxmoxVmId: 100, proxmoxNode: 'pve1', status: 'running', type: 'qemu' };
    const long = new Date(Date.now() - 3_600_000);
    const rule = (id: string, metric: string, threshold: number) => ({
      id, vmId: 'vm1', userId: 'u1', metric, threshold, sustainedMin: 1, enabled: true,
      breachingSince: long, lastFiredAt: null, vm,
    });
    vi.mocked(prisma.alertRule.findMany).mockResolvedValue([
      rule('a', 'cpu', 10),
      rule('b', 'cpu', 20),
      rule('c', 'memory', 10),
    ] as never);
    vi.mocked(pve.getClient).mockResolvedValue({
      get: vi.fn(async () => ({
        data: { data: [{ type: 'qemu', vmid: 100, status: 'running', cpu: 0.9, mem: 9, maxmem: 10, tags: guestMarker('vm1') }] },
      })),
    } as never);

    const r = await evaluateAlerts();
    expect(r.fired).toBe(3);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(notifyWebhook).toHaveBeenCalledTimes(1);
    const mail = vi.mocked(sendMail).mock.calls[0]![0] as { text: string };
    expect(mail.text).toContain('High CPU');
    expect(mail.text).toContain('High memory');
  });
});
