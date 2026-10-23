import { describe, it, expect, vi, beforeEach } from 'vitest';

const config: Record<string, string> = {};
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(async (k: string) => config[k] ?? null) }));

import { resetRestoredFirewall } from '../src/services/proxmox.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

// A restore brings back the archive's guest firewall (qemu-server.fw / pct.fw,
// which a container's rootfs can override). All of it is cleared before ProxMate
// writes its own isolation.

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
});

describe('resetRestoredFirewall', () => {
  it('removes every rule (highest first), IP set (members first) and alias, and stray options', async () => {
    const c = fakeClient();
    const base = '/nodes/pve1/lxc/200/firewall';
    const ok = (data: unknown) => Promise.resolve({ data: { data } });
    c.get.mockImplementation((url: string) => {
      if (url === `${base}/rules`) return ok([{ pos: 0 }, { pos: 2 }, { pos: 1 }]);
      if (url === `${base}/ipset`) return ok([{ name: 'trusted' }]);
      if (url === `${base}/ipset/trusted`) return ok([{ cidr: '0.0.0.0/0' }]);
      if (url === `${base}/aliases`) return ok([{ name: 'gw' }]);
      return ok(null);
    });
    await resetRestoredFirewall('pve1', 200, asClient(c), 'lxc');
    expect(c.delete.mock.calls.map((x) => x[0])).toEqual([
      `${base}/rules/2`,
      `${base}/rules/1`,
      `${base}/rules/0`,
      `${base}/ipset/trusted/0.0.0.0%2F0`,
      `${base}/ipset/trusted`,
      `${base}/aliases/gw`,
    ]);
    expect(c.put.mock.calls[0]![0]).toBe(`${base}/options`);
    expect(bodyOf(c.put.mock.calls[0]!)).toEqual({ delete: 'radv,log_level_in,log_level_out' });
  });

  it('with isolation off, also removes the archive\'s enable flag and policies (nothing rewrites them)', async () => {
    config['isolation_enabled'] = 'false';
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: [] } });
    await resetRestoredFirewall('pve1', 200, asClient(c), 'qemu');
    expect(bodyOf(c.put.mock.calls[0]!)).toEqual({ delete: 'radv,log_level_in,log_level_out,enable,policy_in,policy_out' });
  });
});
