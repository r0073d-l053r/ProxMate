import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../src/services/setup.service.js', () => ({
  isSetupComplete: vi.fn(async () => false),
  hasAdmin: vi.fn(async () => true),
  createAdmin: vi.fn(),
  saveProxmoxConfig: vi.fn(async () => undefined),
  testProxmoxConnection: vi.fn(async () => ({ connected: true })),
  getProxmoxResources: vi.fn(async () => ({ nodes: [] })),
  saveDefaults: vi.fn(async () => undefined),
  completeSetup: vi.fn(async () => undefined),
}));
vi.mock('../src/services/proxmox.service.js', () => ({ NETWORK_NAME_RE: /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/ }));
vi.mock('../src/services/auth.service.js', () => ({ verifySession: vi.fn() }));
vi.mock('../src/services/api-token.service.js', () => ({
  isApiToken: (t?: string) => !!t?.startsWith('pm_'),
  verifyApiToken: vi.fn(),
}));
vi.mock('../src/middleware/rate-limit.js', () => ({
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import setupRoutes from '../src/routes/setup.routes.js';
import * as setupService from '../src/services/setup.service.js';
import * as authService from '../src/services/auth.service.js';
import { SESSION_COOKIE } from '../src/lib/cookies.js';

const verifySession = vi.mocked(authService.verifySession);
const ADMIN = { id: 'a1', email: 'admin@x.y', role: 'admin', displayName: 'Admin' };
const USER = { id: 'u1', email: 'user@x.y', role: 'user', displayName: 'User' };

let server: http.Server | undefined;
let base = '';

beforeEach(async () => {
  vi.clearAllMocks();
  verifySession.mockImplementation(async (token: string) => {
    if (token === 'admin-session') return { user: ADMIN, csrfToken: 'csrf-a' } as never;
    if (token === 'user-session') return { user: USER, csrfToken: 'csrf-u' } as never;
    return null;
  });
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/setup', setupRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/setup`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function call(path: string, opts: { method?: string; session?: string; csrf?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.session) headers.cookie = `${SESSION_COOKIE}=${opts.session}`;
  if (opts.csrf) headers['x-csrf-token'] = opts.csrf;
  return fetch(`${base}${path}`, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

const PROXMOX = { host: 'https://pve.example:8006', tokenId: 'root@pam!pm', tokenSecret: 's', verifySsl: true };
const DEFAULTS = { storage: 'local-lvm', bridge: 'vmbr0', isoStorage: 'local' };

describe('setup steps after the admin exists', () => {
  it('rejects anonymous callers on every post-admin step and mints no session', async () => {
    const steps: Array<[string, string, unknown?]> = [
      ['/proxmox', 'POST', PROXMOX],
      ['/proxmox/test', 'POST'],
      ['/proxmox/resources', 'GET'],
      ['/defaults', 'POST', DEFAULTS],
      ['/complete', 'POST'],
    ];
    for (const [path, method, body] of steps) {
      const res = await call(path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.headers.get('set-cookie'), `${method} ${path}`).toBeNull();
    }
    expect(setupService.saveProxmoxConfig).not.toHaveBeenCalled();
    expect(setupService.testProxmoxConnection).not.toHaveBeenCalled();
    expect(setupService.getProxmoxResources).not.toHaveBeenCalled();
    expect(setupService.saveDefaults).not.toHaveBeenCalled();
    expect(setupService.completeSetup).not.toHaveBeenCalled();
  });

  it('rejects a signed-in non-admin', async () => {
    const res = await call('/complete', { session: 'user-session', csrf: 'csrf-u' });
    expect(res.status).toBe(403);
    expect(setupService.completeSetup).not.toHaveBeenCalled();
  });

  it('requires the CSRF header from the admin session cookie', async () => {
    const res = await call('/proxmox', { session: 'admin-session', body: PROXMOX });
    expect(res.status).toBe(403);
    expect(setupService.saveProxmoxConfig).not.toHaveBeenCalled();
  });

  it('lets the admin session run the steps and finish without minting a new session', async () => {
    const admin = { session: 'admin-session', csrf: 'csrf-a' };
    expect((await call('/proxmox', { ...admin, body: PROXMOX })).status).toBe(200);
    expect((await call('/proxmox/test', admin)).status).toBe(200);
    expect((await call('/proxmox/resources', { ...admin, method: 'GET' })).status).toBe(200);
    expect((await call('/defaults', { ...admin, body: DEFAULTS })).status).toBe(200);
    const done = await call('/complete', admin);
    expect(done.status).toBe(200);
    expect(done.headers.get('set-cookie')).toBeNull();
    expect(await done.json()).toMatchObject({ user: { id: 'a1', role: 'admin' }, redirectTo: '/' });
    expect(setupService.completeSetup).toHaveBeenCalledOnce();
  });
});
