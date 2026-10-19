import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import express from 'express';

// The proxy's collaborators are driven per-test: who the session is, whether the
// caller may open this VM, and which guest secret (if any) ProxMate holds for it.
vi.mock('../src/services/auth.service.js', () => ({ verifyToken: vi.fn() }));
vi.mock('../src/services/vm.service.js', () => ({ getVmWithCap: vi.fn() }));
vi.mock('../src/services/ide.service.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/ide.service.js')>()),
  getIdeCapability: vi.fn(),
}));
vi.mock('../src/lib/crypto.js', () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.slice(4) }));
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { ideGuestSecret: { findUnique: vi.fn(), upsert: vi.fn().mockResolvedValue({}) } },
}));

import { prisma } from '../src/lib/prisma.js';
import { verifyToken } from '../src/services/auth.service.js';
import { getVmWithCap } from '../src/services/vm.service.js';
import { getIdeCapability } from '../src/services/ide.service.js';
import { mountIdeProxy } from '../src/services/ide-proxy.service.js';
import {
  proveIdeGuest,
  ideGuestCookieValue,
  clearIdeGuestProofs,
  saveIdeGuestSecret,
} from '../src/services/ide-guest-auth.service.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * A stand-in for code-server 4.128.0 in its SHA256 password mode
 * (`--auth password` + `HASHED_PASSWORD=<hex>`): the login POST answers the
 * matching password with `code-server-session=<hash>`; every other route needs
 * that exact cookie or redirects to ./login. `mode: 'none'` mimics `--auth none`
 * (login just redirects, everything is served) and `mode: 'any'` an unrelated
 * HTTP service that 200s everything.
 */
function fakeGuest(opts: { secret?: string; mode?: 'password' | 'none' | 'any' }) {
  const hash = opts.secret ? sha(opts.secret) : '';
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const mode = opts.mode ?? 'password';
    if (mode === 'any') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello from somewhere else');
      return;
    }
    if (req.url?.startsWith('/login')) {
      if (mode === 'none') {
        res.writeHead(302, { location: './' }).end();
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let pw = '';
        try {
          pw = String(JSON.parse(body).password ?? '');
        } catch {
          /* not json */
        }
        if (pw && sha(pw) === hash) {
          res.writeHead(302, { location: './', 'set-cookie': `code-server-session=${hash}; Path=/; HttpOnly; SameSite=Lax` }).end();
        } else {
          res.writeHead(200, { 'content-type': 'text/html' }).end('<form>login</form>');
        }
      });
      return;
    }
    const cookie = req.headers.cookie ?? '';
    if (mode === 'password' && !cookie.split(';').some((p) => p.trim() === `code-server-session=${hash}`)) {
      res.writeHead(302, { location: './login' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('workbench');
  });
  return { server, seen };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const servers: http.Server[] = [];
async function start(server: http.Server): Promise<string> {
  servers.push(server);
  return listen(server);
}

const OWNER = { id: 'u1', role: 'user' };
const VM = { id: 'vm1', userId: 'u1', type: 'qemu', status: 'running', ipAddress: '10.0.0.5' };

beforeEach(() => {
  vi.clearAllMocks();
  clearIdeGuestProofs();
  vi.mocked(verifyToken).mockResolvedValue(OWNER as never);
  vi.mocked(getVmWithCap).mockResolvedValue(VM as never);
  vi.mocked(getIdeCapability).mockResolvedValue({ available: true } as never);
});

afterEach(async () => {
  delete process.env['IDE_TARGET_OVERRIDE'];
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('proveIdeGuest — the guest must hold this VM’s secret', () => {
  it('accepts the code-server that was provisioned with the secret', async () => {
    const g = fakeGuest({ secret: 'vm1-secret' });
    expect(await proveIdeGuest(await start(g.server), 'vm1-secret')).toBe(true);
  });

  it("rejects another VM's code-server", async () => {
    const g = fakeGuest({ secret: 'some-other-vms-secret' });
    expect(await proveIdeGuest(await start(g.server), 'vm1-secret')).toBe(false);
  });

  it('rejects an install that runs without authentication', async () => {
    const g = fakeGuest({ mode: 'none' });
    expect(await proveIdeGuest(await start(g.server), 'vm1-secret')).toBe(false);
  });

  it('rejects an unrelated service that answers anything', async () => {
    const g = fakeGuest({ mode: 'any' });
    expect(await proveIdeGuest(await start(g.server), 'vm1-secret')).toBe(false);
  });

  it('rejects an unreachable target', async () => {
    expect(await proveIdeGuest('http://127.0.0.1:1', 'vm1-secret', 500)).toBe(false);
  });

  it('the guest cookie value is the sha256 hex code-server compares against', () => {
    expect(ideGuestCookieValue('abc')).toBe(sha('abc'));
    expect(ideGuestCookieValue('abc')).not.toContain('$argon');
  });

  it('stores the secret encrypted, keyed by VM', async () => {
    await saveIdeGuestSecret('vm1', 's3cret');
    expect(vi.mocked(prisma.ideGuestSecret.upsert)).toHaveBeenCalledWith({
      where: { vmId: 'vm1' },
      update: { secretEnc: 'enc:s3cret' },
      create: { vmId: 'vm1', secretEnc: 'enc:s3cret' },
    });
  });
});

describe('IDE proxy — guest authentication', () => {
  async function proxyApp(): Promise<string> {
    const app = express();
    mountIdeProxy(app);
    app.use((_req, res) => {
      res.status(404).end('fallthrough');
    });
    return start(http.createServer(app));
  }

  const get = (base: string) =>
    fetch(`${base}/api/ide/vm1/proxy/`, { headers: { cookie: 'proxmate_session=jwt' }, redirect: 'manual' });

  it('relays to the guest that proves the VM secret, with the guest cookie injected', async () => {
    const g = fakeGuest({ secret: 'vm1-secret' });
    process.env['IDE_TARGET_OVERRIDE'] = await start(g.server);
    vi.mocked(prisma.ideGuestSecret.findUnique).mockResolvedValue({ vmId: 'vm1', secretEnc: 'enc:vm1-secret' } as never);

    const r = await get(await proxyApp());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('workbench');
    const proxied = g.seen.find((h) => h.cookie?.includes('code-server-session'));
    expect(proxied?.cookie).toContain(`code-server-session=${sha('vm1-secret')}`);
  });

  it("refuses to relay to a guest that cannot prove this VM's secret", async () => {
    const other = fakeGuest({ mode: 'none' }); // e.g. a different VM's old install at that IP
    process.env['IDE_TARGET_OVERRIDE'] = await start(other.server);
    vi.mocked(prisma.ideGuestSecret.findUnique).mockResolvedValue({ vmId: 'vm1', secretEnc: 'enc:vm1-secret' } as never);

    const r = await get(await proxyApp());
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain('workbench');
    // Only the proof request reached it — nothing from the browser was relayed.
    expect(other.seen.every((h) => !h.cookie?.includes('proxmate_session'))).toBe(true);
  });

  it('refuses a VM that is not running, without contacting anything at its address', async () => {
    const g = fakeGuest({ secret: 'vm1-secret' });
    process.env['IDE_TARGET_OVERRIDE'] = await start(g.server);
    vi.mocked(prisma.ideGuestSecret.findUnique).mockResolvedValue({ vmId: 'vm1', secretEnc: 'enc:vm1-secret' } as never);
    vi.mocked(getVmWithCap).mockResolvedValue({ ...VM, status: 'stopped' } as never);

    const r = await get(await proxyApp());
    expect(r.status).toBe(409);
    expect(g.seen).toHaveLength(0);
  });

  it('refuses a held VM even when its recorded status is running, without contacting it (audit round 3)', async () => {
    const g = fakeGuest({ secret: 'vm1-secret' });
    process.env['IDE_TARGET_OVERRIDE'] = await start(g.server);
    vi.mocked(prisma.ideGuestSecret.findUnique).mockResolvedValue({ vmId: 'vm1', secretEnc: 'enc:vm1-secret' } as never);
    vi.mocked(getVmWithCap).mockResolvedValue({ ...VM, status: 'running', holdReason: 'Over quota after a restore.' } as never);

    const r = await get(await proxyApp());
    expect(r.status).toBe(409);
    expect(await r.text()).toMatch(/Over quota/);
    expect(g.seen).toHaveLength(0);
  });

  it('fails closed with a reinstall message when the install has no guest secret', async () => {
    const g = fakeGuest({ mode: 'none' });
    process.env['IDE_TARGET_OVERRIDE'] = await start(g.server);
    vi.mocked(prisma.ideGuestSecret.findUnique).mockResolvedValue(null as never);

    const r = await get(await proxyApp());
    expect(r.status).toBe(409);
    expect(await r.text()).toMatch(/reinstall/i);
    expect(g.seen).toHaveLength(0);
  });
});
