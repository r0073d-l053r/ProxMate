import { describe, it, expect } from 'vitest';
import { ensureIdePinhole, removeIdePinhole, ensureHostCpu } from '../src/services/proxmox.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const IDE_COMMENT = 'ProxMate IDE: reverse-proxy pinhole';

describe('ensureIdePinhole — managed, isolation-consistent :8080 hole', () => {
  it('adds ONE infra-scoped inbound tcp/:8080 ACCEPT when none exists', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: [] } });
    await ensureIdePinhole('pve', 109, { port: 8080, source: '192.168.50.228/32' }, asClient(c));

    expect(c.post).toHaveBeenCalledTimes(1);
    expect(c.post.mock.calls[0][0]).toBe('/nodes/pve/qemu/109/firewall/rules');
    const body = bodyOf(c.post.mock.calls[0]);
    expect(body).toMatchObject({
      enable: '1',
      type: 'in',
      action: 'ACCEPT',
      proto: 'tcp',
      dport: '8080',
      source: '192.168.50.228/32',
      comment: IDE_COMMENT,
    });
  });

  it('is idempotent — no POST when the pinhole already exists', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: [{ comment: IDE_COMMENT }] } });
    await ensureIdePinhole('pve', 109, { port: 8080, source: '10.9.9.9/32' }, asClient(c));
    expect(c.post).not.toHaveBeenCalled();
  });

  it('scopes the hole to the caller-supplied infra CIDR only (never opens it to tenants)', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: [] } });
    await ensureIdePinhole('pve-4', 108, { port: 8080, source: '192.168.50.228/32' }, asClient(c), 'qemu');
    // Not a /24, not 0.0.0.0 — the source is exactly what was asked for.
    expect(bodyOf(c.post.mock.calls[0]).source).toBe('192.168.50.228/32');
  });

  it('honours a non-default port', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: [] } });
    await ensureIdePinhole('pve', 109, { port: 9000, source: '10.0.0.0/8' }, asClient(c));
    expect(bodyOf(c.post.mock.calls[0]).dport).toBe('9000');
  });
});

describe('removeIdePinhole', () => {
  it('deletes only the managed rules, bottom-up so positions do not shift', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          { pos: 0, comment: 'ProxMate isolation: block local/private networks' },
          { pos: 1, comment: IDE_COMMENT },
          { pos: 2, comment: IDE_COMMENT },
        ],
      },
    });
    await removeIdePinhole('pve', 109, asClient(c));
    expect(c.delete.mock.calls.map((x) => x[0])).toEqual([
      '/nodes/pve/qemu/109/firewall/rules/2',
      '/nodes/pve/qemu/109/firewall/rules/1',
    ]);
  });

  it('is a no-op when there is nothing to remove', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: [{ pos: 0, comment: 'other' }] } });
    await removeIdePinhole('pve', 110, asClient(c));
    expect(c.delete).not.toHaveBeenCalled();
  });
});

describe('ensureHostCpu — expose AVX for OpenCode', () => {
  it('sets cpu=host when the VM uses the default (AVX-masking) model', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: { cpu: 'kvm64', memory: '8192' } } });
    const changed = await ensureHostCpu('pve', 109, asClient(c));
    expect(changed).toBe(true);
    expect(c.put).toHaveBeenCalledTimes(1);
    expect(c.put.mock.calls[0][0]).toBe('/nodes/pve/qemu/109/config');
    expect(bodyOf(c.put.mock.calls[0]).cpu).toBe('host');
  });

  it('sets cpu=host when no cpu model is configured at all', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: { memory: '8192' } } });
    expect(await ensureHostCpu('pve', 109, asClient(c))).toBe(true);
    expect(bodyOf(c.put.mock.calls[0]).cpu).toBe('host');
  });

  it('is a no-op when the VM already uses host (even with flags)', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: { cpu: 'host,flags=+aes' } } });
    expect(await ensureHostCpu('pve', 109, asClient(c))).toBe(false);
    expect(c.put).not.toHaveBeenCalled();
  });
});

// ─── Node AVX capability (the IDE relocate prerequisite) ──────────────────────
import { nodeHasAvx, getNodeAvxMap } from '../src/services/proxmox.service.js';

describe('nodeHasAvx', () => {
  it('finds avx as a whole word in the flags string', () => {
    expect(nodeHasAvx('fpu vme sse2 avx avx2 aes')).toBe(true);
    expect(nodeHasAvx('avx')).toBe(true);
  });
  it("does NOT match 'avx2' alone (the base instruction set is what Bun needs)", () => {
    expect(nodeHasAvx('fpu sse2 avx2 aes')).toBe(false);
  });
  it('returns unknown when the API omits the flags', () => {
    expect(nodeHasAvx(undefined)).toBe('unknown');
    expect(nodeHasAvx('')).toBe('unknown');
  });
});

describe('getNodeAvxMap', () => {
  it('maps each online node from cpuinfo.flags, failing open to unknown', async () => {
    const c = fakeClient();
    c.get.mockImplementation(async (url: string) => {
      if (url === '/cluster/resources') {
        return { data: { data: [
          { type: 'node', status: 'online', node: 'n-avx' },
          { type: 'node', status: 'online', node: 'n-old' },
          { type: 'node', status: 'online', node: 'n-mystery' },
          { type: 'node', status: 'offline', node: 'n-down' },
        ] } };
      }
      if (url === '/nodes/n-avx/status') return { data: { data: { cpuinfo: { flags: 'sse2 avx avx2' } } } };
      if (url === '/nodes/n-old/status') return { data: { data: { cpuinfo: { flags: 'fpu sse2' } } } };
      if (url === '/nodes/n-mystery/status') throw new Error('boom');
      throw new Error(`unexpected ${url}`);
    });
    const map = await getNodeAvxMap(asClient(c));
    expect(map.get('n-avx')).toBe(true);
    expect(map.get('n-old')).toBe(false);
    expect(map.get('n-mystery')).toBe('unknown');
    expect(map.has('n-down')).toBe(false); // offline nodes aren't probed
  });
});
