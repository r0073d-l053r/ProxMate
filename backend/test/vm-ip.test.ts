import { describe, it, expect, vi } from 'vitest';

// proxmox.service → config.service → prisma constructs a client at import; stub it.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { getVmIps, isTailscaleIp } from '../src/services/proxmox.service.js';
import { fakeClient, asClient } from './helpers.js';

const agent = (result: unknown) => ({ data: { data: { result } } });

describe('isTailscaleIp (CGNAT 100.64.0.0/10)', () => {
  it('accepts the range boundaries', () => {
    expect(isTailscaleIp('100.64.0.0')).toBe(true);
    expect(isTailscaleIp('100.101.102.103')).toBe(true);
    expect(isTailscaleIp('100.127.255.255')).toBe(true);
  });

  it('rejects everything outside it', () => {
    expect(isTailscaleIp('100.63.255.255')).toBe(false);
    expect(isTailscaleIp('100.128.0.0')).toBe(false);
    expect(isTailscaleIp('192.168.1.10')).toBe(false);
    expect(isTailscaleIp('10.0.0.1')).toBe(false);
    expect(isTailscaleIp('not-an-ip')).toBe(false);
  });
});

describe('getVmIps (QEMU guest agent)', () => {
  it('returns the first non-loopback IPv4, skipping lo and link-local', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue(
      agent([
        { name: 'lo', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '127.0.0.1' }] },
        {
          name: 'eth0',
          'ip-addresses': [
            { 'ip-address-type': 'ipv6', 'ip-address': 'fe80::5054:ff:fe12:3456' },
            { 'ip-address-type': 'ipv4', 'ip-address': '10.20.30.40' },
          ],
        },
      ]),
    );
    expect(await getVmIps('pve-1', 101, asClient(c))).toEqual({ ip: '10.20.30.40', tailscaleIp: null });
    expect(c.get.mock.calls[0]![0]).toBe('/nodes/pve-1/qemu/101/agent/network-get-interfaces');
  });

  it('reports the tailscale0 address separately — it never shadows the LAN IP', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue(
      agent([
        { name: 'lo', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '127.0.0.1' }] },
        // Tailscale listed BEFORE eth0 — the old first-IPv4-wins logic would have
        // shown 100.x as the VM's IP address.
        {
          name: 'tailscale0',
          'ip-addresses': [
            { 'ip-address-type': 'ipv4', 'ip-address': '100.101.102.103' },
            { 'ip-address-type': 'ipv6', 'ip-address': 'fd7a:115c:a1e0::abcd' },
          ],
        },
        { name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '192.168.50.148' }] },
      ]),
    );
    expect(await getVmIps('pve-1', 101, asClient(c))).toEqual({
      ip: '192.168.50.148',
      tailscaleIp: '100.101.102.103',
    });
  });

  it('classifies a CGNAT-range IPv4 as Tailscale regardless of interface name', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue(
      agent([
        { name: 'ts0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '100.64.0.9' }] },
        { name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '10.1.2.3' }] },
      ]),
    );
    expect(await getVmIps('pve-1', 101, asClient(c))).toEqual({ ip: '10.1.2.3', tailscaleIp: '100.64.0.9' });
  });

  it('still reports Tailscale when it is the only address (e.g. tailnet-only guest)', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue(
      agent([
        { name: 'tailscale0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '100.90.1.2' }] },
      ]),
    );
    expect(await getVmIps('pve-1', 101, asClient(c))).toEqual({ ip: null, tailscaleIp: '100.90.1.2' });
  });

  it('falls back to a global IPv6 when there is no IPv4', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue(
      agent([
        { name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv6', 'ip-address': '2001:db8::abcd' }] },
      ]),
    );
    expect(await getVmIps('pve-1', 101, asClient(c))).toEqual({ ip: '2001:db8::abcd', tailscaleIp: null });
  });

  it('returns nulls when only loopback/link-local addresses are present', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue(
      agent([
        { name: 'lo', 'ip-addresses': [{ 'ip-address-type': 'ipv6', 'ip-address': '::1' }] },
        { name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv6', 'ip-address': 'fe80::1' }] },
      ]),
    );
    expect(await getVmIps('pve-1', 101, asClient(c))).toEqual({ ip: null, tailscaleIp: null });
  });

  it('returns nulls when the agent is unreachable (rejects)', async () => {
    const c = fakeClient();
    c.get.mockRejectedValue(new Error('QEMU guest agent is not running'));
    expect(await getVmIps('pve-1', 101, asClient(c))).toEqual({ ip: null, tailscaleIp: null });
  });
});
