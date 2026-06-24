import { describe, it, expect, vi } from 'vitest';

// Keep tests hermetic: prevent lib/prisma from constructing a real PrismaClient
// (proxmox.service → config.service → prisma) at import time.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { configureVmIsolation, ipv4NetworkCidr } from '../src/services/proxmox.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

describe('ipv4NetworkCidr', () => {
  it('computes the network address for a /24', () => {
    expect(ipv4NetworkCidr('192.168.50.122/24')).toBe('192.168.50.0/24');
  });

  it('handles /16 and /8 prefixes', () => {
    expect(ipv4NetworkCidr('10.20.30.40/16')).toBe('10.20.0.0/16');
    expect(ipv4NetworkCidr('10.20.30.40/8')).toBe('10.0.0.0/8');
  });

  it('handles a /32 (single host)', () => {
    expect(ipv4NetworkCidr('1.2.3.4/32')).toBe('1.2.3.4/32');
  });

  it('handles a /0', () => {
    expect(ipv4NetworkCidr('1.2.3.4/0')).toBe('0.0.0.0/0');
  });

  it('returns undefined for malformed input', () => {
    expect(ipv4NetworkCidr('not-an-ip')).toBeUndefined();
    expect(ipv4NetworkCidr('192.168.1.1')).toBeUndefined(); // no prefix
    expect(ipv4NetworkCidr('a.b.c.d/24')).toBeUndefined();
  });
});

describe('configureVmIsolation (per-VM firewall rule builder)', () => {
  const NODE = 'pve-1';
  const VMID = 101;
  const OPTIONS_URL = `/nodes/${NODE}/qemu/${VMID}/firewall/options`;
  const RULES_URL = `/nodes/${NODE}/qemu/${VMID}/firewall/rules`;

  it('sets a default-deny inbound policy with anti-spoofing on', async () => {
    const c = fakeClient();
    await configureVmIsolation(NODE, VMID, { gateway: '10.0.0.1' }, asClient(c));

    expect(c.put).toHaveBeenCalledTimes(1);
    expect(c.put.mock.calls[0]![0]).toBe(OPTIONS_URL);
    expect(bodyOf(c.put.mock.calls[0]!)).toMatchObject({
      enable: '1',
      policy_in: 'DROP',
      policy_out: 'ACCEPT',
      macfilter: '1',
      ipfilter: '1',
      dhcp: '1',
      ndp: '1',
    });
  });

  it('blocks every RFC1918 range and allows DNS only to the gateway', async () => {
    const c = fakeClient();
    await configureVmIsolation(NODE, VMID, { gateway: '10.0.0.1' }, asClient(c));

    const posts = c.post.mock.calls.map((call) => ({ url: call[0], body: bodyOf(call) }));
    // 3 RFC1918 drops + 2 DNS allows (tcp + udp), all to the rules endpoint.
    expect(posts).toHaveLength(5);
    expect(posts.every((p) => p.url === RULES_URL)).toBe(true);

    const drops = posts.filter((p) => p.body.action === 'DROP');
    expect(drops.map((p) => p.body.dest)).toEqual([
      '192.168.0.0/16',
      '172.16.0.0/12',
      '10.0.0.0/8',
    ]);
    expect(drops.every((p) => p.body.type === 'out')).toBe(true);

    const dns = posts.filter((p) => p.body.action === 'ACCEPT');
    expect(dns).toHaveLength(2);
    expect(dns.map((p) => p.body.proto).sort()).toEqual(['tcp', 'udp']);
    expect(dns.every((p) => p.body.dport === '53' && p.body.dest === '10.0.0.1')).toBe(true);
  });

  it('inserts DNS-allow AFTER the drops so (pos=0 prepend) DNS ends up evaluated first', async () => {
    const c = fakeClient();
    await configureVmIsolation(NODE, VMID, { gateway: '10.0.0.1' }, asClient(c));

    // Every rule is prepended at pos=0; Proxmox evaluates top-to-bottom, first
    // match wins. So the LAST-inserted rules (DNS) sit on top of the drops —
    // the gateway's own subnet (RFC1918) must not shadow DNS. This ordering is
    // the security-critical invariant of the isolation model.
    expect(c.post.mock.calls.every((call) => bodyOf(call).pos === '0')).toBe(true);
    const actions = c.post.mock.calls.map((call) => bodyOf(call).action);
    expect(actions).toEqual(['DROP', 'DROP', 'DROP', 'ACCEPT', 'ACCEPT']);
  });

  it('omits DNS rules when no gateway is known (still drops all RFC1918)', async () => {
    const c = fakeClient();
    await configureVmIsolation(NODE, VMID, {}, asClient(c));

    expect(c.post).toHaveBeenCalledTimes(3);
    expect(c.post.mock.calls.every((call) => bodyOf(call).action === 'DROP')).toBe(true);
  });
});
