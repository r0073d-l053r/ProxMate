import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

vi.mock('../src/services/auth.service.js', () => ({ verifyToken: vi.fn() }));
vi.mock('../src/services/vm.service.js', () => ({ getVmWithCap: vi.fn() }));
vi.mock('../src/services/ide.service.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/ide.service.js')>()),
  getIdeCapability: vi.fn(),
}));
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// The guest proof is covered in ide-guest-auth.test.ts; here the guest is trusted
// so the tests can focus on what crosses the proxy in each direction.
vi.mock('../src/services/ide-guest-auth.service.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/ide-guest-auth.service.js')>()),
  loadIdeGuestSecret: vi.fn().mockResolvedValue('vm1-secret'),
  proveIdeGuestTarget: vi.fn(async () => process.env['IDE_TARGET_OVERRIDE'] ?? null),
}));

import { verifyToken } from '../src/services/auth.service.js';
import { getVmWithCap } from '../src/services/vm.service.js';
import { getIdeCapability } from '../src/services/ide.service.js';
import { mountIdeProxy, handleIdeUpgrade, sanitizeGuestResponseHeaders } from '../src/services/ide-proxy.service.js';

/** Upstream response headers a guest could send back. */
const GUEST_RESPONSE_HEADERS = {
  'set-cookie': [
    'proxmate_session=planted; Path=/',
    'proxmate_csrf=planted; Path=/',
    'code-server-session=leak; Path=/',
    'editor_pref=dark; Path=/',
  ],
  'service-worker-allowed': '/',
  'x-guest': 'yes',
};

const servers: http.Server[] = [];
let seen: http.IncomingHttpHeaders[] = [];

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startGuest(): Promise<void> {
  const guest = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/plain', ...GUEST_RESPONSE_HEADERS }).end('workbench');
  });
  guest.on('upgrade', (req, socket) => {
    seen.push(req.headers);
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
    for (const c of GUEST_RESPONSE_HEADERS['set-cookie']) lines.push(`Set-Cookie: ${c}`);
    lines.push('Service-Worker-Allowed: /');
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    socket.end();
  });
  process.env['IDE_TARGET_OVERRIDE'] = `http://${await listen(guest)}`;
}

async function startProxy(): Promise<string> {
  const app = express();
  mountIdeProxy(app);
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    if (!handleIdeUpgrade(req, socket, head)) socket.destroy();
  });
  return listen(server);
}

const BROWSER_COOKIES = 'proxmate_session=jwt; proxmate_csrf=csrf; proxmate_sso=s; editor_pref=light; code-server-session=forged';

beforeEach(async () => {
  vi.clearAllMocks();
  seen = [];
  vi.mocked(verifyToken).mockResolvedValue({ id: 'u1', role: 'user' } as never);
  vi.mocked(getVmWithCap).mockResolvedValue({ id: 'vm1', userId: 'u1', type: 'qemu', status: 'running', ipAddress: '10.0.0.5' } as never);
  vi.mocked(getIdeCapability).mockResolvedValue({ available: true } as never);
  await startGuest();
});

afterEach(async () => {
  delete process.env['IDE_TARGET_OVERRIDE'];
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function cookieNames(header: string | undefined): string[] {
  return (header ?? '').split(';').map((p) => p.trim().split('=')[0]!).filter(Boolean);
}

describe('IDE proxy — HTTP headers', () => {
  async function get(): Promise<Response> {
    const base = await startProxy();
    return fetch(`http://${base}/api/ide/vm1/proxy/`, {
      headers: { cookie: BROWSER_COOKIES, authorization: 'Bearer pm_token' },
      redirect: 'manual',
    });
  }

  it("never forwards ProxMate's own cookies or Authorization to the guest", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    const h = seen[0]!;
    expect(cookieNames(h.cookie)).toEqual(['editor_pref', 'code-server-session']);
    expect(h.cookie).not.toContain('forged');
    expect(h.authorization).toBeUndefined();
  });

  it('drops guest Set-Cookie for ProxMate cookie names and Service-Worker-Allowed', async () => {
    const r = await get();
    const setCookies = r.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith('proxmate_'))).toBe(false);
    expect(setCookies.some((c) => c.startsWith('code-server-session'))).toBe(false);
    expect(setCookies).toContain('editor_pref=dark; Path=/');
    expect(r.headers.get('service-worker-allowed')).toBeNull();
    expect(r.headers.get('x-guest')).toBe('yes');
  });
});

describe('IDE proxy — WebSocket upgrade headers', () => {
  async function upgrade(): Promise<http.IncomingMessage> {
    const base = await startProxy();
    const [host, port] = base.split(':');
    return new Promise((resolve, reject) => {
      const req = http.request({
        host,
        port: Number(port),
        path: '/api/ide/vm1/proxy/stable/socket',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          cookie: BROWSER_COOKIES,
          authorization: 'Bearer pm_token',
        },
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve(res);
      });
      req.on('response', (res) => resolve(res));
      req.on('error', reject);
      req.end();
    });
  }

  it('strips ProxMate cookies on the way in and ProxMate Set-Cookie / Service-Worker-Allowed on the way out', async () => {
    const res = await upgrade();
    expect(res.statusCode).toBe(101);
    expect(cookieNames(seen[0]!.cookie)).toEqual(['editor_pref', 'code-server-session']);
    expect(seen[0]!.authorization).toBeUndefined();
    const setCookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(setCookies.some((c) => c.startsWith('proxmate_') || c.startsWith('code-server-session'))).toBe(false);
    expect(res.headers['service-worker-allowed']).toBeUndefined();
  });
});

describe('sanitizeGuestResponseHeaders — Set-Cookie name edge cases', () => {
  it('drops nameless cookies and ProxMate / code-server names hidden behind "=" or whitespace', () => {
    const headers = {
      'set-cookie': [
        '=proxmate_session=planted; Path=/',
        ' =\tproxmate_csrf=planted',
        '==code-server-session=x',
        '=just-a-value',
        '  proxmate_sso=planted',
        'editor_pref=dark; Path=/',
      ],
    };
    sanitizeGuestResponseHeaders(headers);
    expect(headers['set-cookie']).toEqual(['editor_pref=dark; Path=/']);
  });
});

describe('IDE proxy — VM owner only', () => {
  it('refuses an admin who does not own the VM, before contacting the guest', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ id: 'admin1', role: 'admin' } as never);
    const base = await startProxy();
    const r = await fetch(`http://${base}/api/ide/vm1/proxy/`, { headers: { cookie: BROWSER_COOKIES } });
    expect(r.status).toBe(403);
    expect(await r.text()).toMatch(/owner/i);
    expect(seen).toHaveLength(0);
  });

  it('refuses a sharee on the WebSocket path too', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ id: 'sharee1', role: 'user' } as never);
    const base = await startProxy();
    const [host, port] = base.split(':');
    const status = await new Promise<number>((resolve) => {
      const req = http.request({
        host,
        port: Number(port),
        path: '/api/ide/vm1/proxy/socket',
        headers: { connection: 'Upgrade', upgrade: 'websocket', cookie: BROWSER_COOKIES },
      });
      req.on('upgrade', (res, s) => {
        s.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.on('error', () => resolve(-1));
      req.end();
    });
    expect(status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});
