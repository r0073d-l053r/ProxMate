import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

// The guest's address is read live from the guest agent; drive it per test.
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn().mockResolvedValue({}),
  getVmIps: vi.fn(),
}));
// The fake guest listens on loopback, which the real target filter refuses.
vi.mock('../src/lib/url-safety.js', () => ({ isLoopbackOrLinkLocal: () => false }));
vi.mock('../src/lib/crypto.js', () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    ideGuestSecret: { findUnique: vi.fn(), upsert: vi.fn() },
    virtualMachine: { update: vi.fn().mockResolvedValue({}) },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import { getVmIps } from '../src/services/proxmox.service.js';
import { proveIdeGuestTarget, clearIdeGuestProofs } from '../src/services/ide-guest-auth.service.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SECRET = 'vm1-secret';

let logins = 0;
let server: http.Server;
let port = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  clearIdeGuestProofs();
  logins = 0;
  // A code-server in SHA256 password mode holding SECRET.
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      logins++;
      const pw = (() => {
        try {
          return String(JSON.parse(body).password ?? '');
        } catch {
          return '';
        }
      })();
      if (sha(pw) === sha(SECRET)) {
        res.writeHead(302, { 'set-cookie': `code-server-session=${sha(SECRET)}; Path=/` }).end();
      } else res.writeHead(200).end('login');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  vi.stubEnv('IDE_GUEST_PORT', String(port));
  vi.stubEnv('IDE_TARGET_OVERRIDE', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((r) => server.close(() => r()));
});

const vm = (over: Record<string, unknown> = {}) =>
  ({
    id: 'vm1',
    type: 'qemu',
    status: 'running',
    ipAddress: '127.0.0.1',
    proxmoxNode: 'pve',
    proxmoxVmId: 101,
    ...over,
  }) as never;

describe('proveIdeGuestTarget — fresh address, running VM', () => {
  it('refuses a VM that is not running, without asking the agent or the guest', async () => {
    expect(await proveIdeGuestTarget(vm({ status: 'stopped' }), SECRET)).toBeNull();
    expect(vi.mocked(getVmIps)).not.toHaveBeenCalled();
    expect(logins).toBe(0);
  });

  it('refuses when the guest agent cannot report a current address', async () => {
    vi.mocked(getVmIps).mockResolvedValue({ ip: null, tailscaleIp: null } as never);
    expect(await proveIdeGuestTarget(vm(), SECRET)).toBeNull();
    expect(logins).toBe(0);
  });

  it('proves the guest at the address the agent reports now, and records it if it changed', async () => {
    vi.mocked(getVmIps).mockResolvedValue({ ip: '127.0.0.1', tailscaleIp: null } as never);
    const target = await proveIdeGuestTarget(vm({ ipAddress: '10.9.9.9' }), SECRET);
    expect(target).toBe(`http://127.0.0.1:${port}`);
    expect(vi.mocked(prisma.virtualMachine.update)).toHaveBeenCalledWith({
      where: { id: 'vm1' },
      data: { ipAddress: '127.0.0.1' },
    });
  });

  it('reuses a recent proof while the recorded IP is unchanged, and drops it when the IP changes', async () => {
    vi.mocked(getVmIps).mockResolvedValue({ ip: '127.0.0.1', tailscaleIp: null } as never);
    expect(await proveIdeGuestTarget(vm(), SECRET)).not.toBeNull();
    expect(await proveIdeGuestTarget(vm(), SECRET)).not.toBeNull();
    expect(vi.mocked(getVmIps)).toHaveBeenCalledTimes(1);
    expect(logins).toBe(1);

    // The recorded address moved: the cached proof no longer applies.
    vi.mocked(getVmIps).mockResolvedValue({ ip: null, tailscaleIp: null } as never);
    expect(await proveIdeGuestTarget(vm({ ipAddress: '10.0.0.77' }), SECRET)).toBeNull();
    expect(vi.mocked(getVmIps)).toHaveBeenCalledTimes(2);
  });

  it('a stopped VM also forgets its cached proof', async () => {
    vi.mocked(getVmIps).mockResolvedValue({ ip: '127.0.0.1', tailscaleIp: null } as never);
    expect(await proveIdeGuestTarget(vm(), SECRET)).not.toBeNull();
    expect(await proveIdeGuestTarget(vm({ status: 'stopped' }), SECRET)).toBeNull();
    expect(await proveIdeGuestTarget(vm(), SECRET)).not.toBeNull();
    expect(logins).toBe(2);
  });

  it('shares one agent read and one proof between concurrent cache misses', async () => {
    vi.mocked(getVmIps).mockResolvedValue({ ip: '127.0.0.1', tailscaleIp: null } as never);
    const results = await Promise.all(Array.from({ length: 8 }, () => proveIdeGuestTarget(vm(), SECRET)));
    expect(new Set(results)).toEqual(new Set([`http://127.0.0.1:${port}`]));
    expect(vi.mocked(getVmIps)).toHaveBeenCalledTimes(1);
    expect(logins).toBe(1);
  });

  it('re-proves in the background near expiry, serving the valid entry meanwhile, and extends it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = new Date('2026-10-19T12:00:00Z').getTime();
      vi.setSystemTime(t0);
      vi.mocked(getVmIps).mockResolvedValue({ ip: '127.0.0.1', tailscaleIp: null } as never);
      const target = await proveIdeGuestTarget(vm(), SECRET);
      expect(logins).toBe(1);

      // 30 s before the 5-minute expiry: answered at once from the cache, and a
      // background proof at the same target (no new agent read) starts.
      vi.setSystemTime(t0 + 5 * 60_000 - 30_000);
      expect(await proveIdeGuestTarget(vm(), SECRET)).toBe(target);
      await vi.waitFor(() => expect(logins).toBe(2));
      expect(vi.mocked(getVmIps)).toHaveBeenCalledTimes(1);

      // Past the original expiry, the extended entry still serves without a new proof.
      vi.setSystemTime(t0 + 5 * 60_000 + 60_000);
      expect(await proveIdeGuestTarget(vm(), SECRET)).toBe(target);
      expect(logins).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps serving until real expiry when the background re-proof fails, then fails closed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = new Date('2026-10-19T12:00:00Z').getTime();
      vi.setSystemTime(t0);
      vi.mocked(getVmIps).mockResolvedValue({ ip: '127.0.0.1', tailscaleIp: null } as never);
      const target = await proveIdeGuestTarget(vm(), SECRET);

      // The guest stops answering the proof.
      server.removeAllListeners('request');
      server.on('request', (_req, res) => {
        logins++;
        res.writeHead(200).end('login');
      });
      vi.setSystemTime(t0 + 5 * 60_000 - 30_000);
      expect(await proveIdeGuestTarget(vm(), SECRET)).toBe(target);
      await vi.waitFor(() => expect(logins).toBe(2));

      vi.setSystemTime(t0 + 5 * 60_000 + 1);
      expect(await proveIdeGuestTarget(vm(), SECRET)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses when the guest at the current address cannot prove the secret', async () => {
    vi.mocked(getVmIps).mockResolvedValue({ ip: '127.0.0.1', tailscaleIp: null } as never);
    expect(await proveIdeGuestTarget(vm(), 'a-different-vms-secret')).toBeNull();
  });
});
