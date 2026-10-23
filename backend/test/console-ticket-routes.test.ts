import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The console ticket mints decide each session's mode from the caller's
// capabilities and record it with the ticket: a Viewer share gets a view-only
// ticket and never an interactive one; Operators, Managers and owners keep
// interactive consoles. The browser has no say in either.

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', role: 'user', email: 'u1@example.com' };
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
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getVmConfig: vi.fn(async () => ({ serial0: 'socket' })) };
});
vi.mock('../src/services/vnc-proxy.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vnc-proxy.service.js')>();
  return {
    ...actual,
    requestVncProxy: vi.fn(async () => ({ ticket: `PVEVNC:vnc${Math.random()}`, port: '5900' })),
    requestTermProxy: vi.fn(async () => ({ ticket: `PVEVNC:term${Math.random()}`, port: '5901', user: 'root@pam' })),
  };
});
vi.mock('../src/services/vm.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vm.service.js')>();
  return {
    ...actual,
    resolveVmAccess: vi.fn(),
    requireOurGuest: vi.fn(async (vm: unknown) => vm),
  };
});

import vmRouter from '../src/routes/vm.routes.js';
import { resolveVmAccess } from '../src/services/vm.service.js';
import { recordAudit } from '../src/services/audit.service.js';
import { takeConsoleGrant, requestVncProxy } from '../src/services/vnc-proxy.service.js';
import { CAPS_BY_ROLE, ALL_CAPS, type ShareRole, type VmCap } from '../src/services/vm-share.service.js';

const ROW = {
  id: 'vm1', userId: 'owner', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1',
  status: 'running', ideState: null, deployState: null,
};
const resolve = vi.mocked(resolveVmAccess);
function as(role: ShareRole | 'owner' | 'admin') {
  const caps = role === 'owner' || role === 'admin' ? ALL_CAPS : CAPS_BY_ROLE[role];
  resolve.mockResolvedValue({ vm: ROW, access: role, caps } as never);
}

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
beforeEach(() => vi.clearAllMocks());

const post = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe.each([
  ['graphical', '/vms/vm1/console', 'vnc'],
  ['text', '/vms/vm1/serial', 'serial'],
] as const)('%s console ticket', (label, path, transport) => {
  it('a viewer gets a view-only ticket, recorded server-side', async () => {
    as('viewer');
    const res = await post(path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; port: string; viewOnly: boolean };
    expect(body.viewOnly).toBe(true);
    expect(takeConsoleGrant(body.ticket)).toEqual({ vmId: 'vm1', userId: 'u1', transport, port: body.port, mode: 'view' });
    expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(expect.objectContaining({
      action: 'vm.console_view_open', targetId: 'vm1', detail: `${label} console of web`,
    }));
  });

  it('a viewer cannot ask for an interactive ticket', async () => {
    as('viewer');
    const res = await post(`${path}?viewOnly=false`, { viewOnly: false, mode: 'interactive' });
    const body = (await res.json()) as { ticket: string; viewOnly: boolean };
    expect(body.viewOnly).toBe(true);
    expect(takeConsoleGrant(body.ticket)?.mode).toBe('view');
  });

  it.each(['operator', 'manager', 'owner', 'admin'] as const)('%s gets an interactive ticket', async (role) => {
    as(role);
    const res = await post(path, { viewOnly: true });
    const body = (await res.json()) as { ticket: string; viewOnly: boolean };
    expect(body.viewOnly).toBe(false);
    expect(takeConsoleGrant(body.ticket)?.mode).toBe('interactive');
    expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(expect.objectContaining({
      action: 'vm.console_open', detail: `${label} console of web`,
    }));
  });

  it('no ticket for a caller with neither console capability, or no access', async () => {
    resolve.mockResolvedValue({ vm: ROW, access: 'viewer', caps: new Set<VmCap>(['view']) } as never);
    expect((await post(path)).status).toBe(404);
    resolve.mockResolvedValue(null as never);
    expect((await post(path)).status).toBe(404);
    expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
  });
});

it('the graphical ticket mint still honours the deploy/IDE lock', async () => {
  resolve.mockResolvedValue({ vm: { ...ROW, deployState: 'deploying' }, access: 'viewer', caps: CAPS_BY_ROLE.viewer } as never);
  const res = await post('/vms/vm1/console');
  expect(res.status).toBe(409);
  expect(vi.mocked(requestVncProxy)).not.toHaveBeenCalled();
});
