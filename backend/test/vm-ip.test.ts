import { describe, it, expect, vi } from 'vitest';

// proxmox.service → config.service → prisma constructs a client at import; stub it.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { getVmIpAddress } from '../src/services/proxmox.service.js';
import { fakeClient, asClient } from './helpers.js';

const agent = (result: unknown) => ({ data: { data: { result } } });

describe('getVmIpAddress (QEMU guest agent)', () => {
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
    expect(await getVmIpAddress('pve-1', 101, asClient(c))).toBe('10.20.30.40');
    expect(c.get.mock.calls[0]![0]).toBe('/nodes/pve-1/qemu/101/agent/network-get-interfaces');
  });

  it('falls back to a global IPv6 when there is no IPv4', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue(
      agent([
        { name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv6', 'ip-address': '2001:db8::abcd' }] },
      ]),
    );
    expect(await getVmIpAddress('pve-1', 101, asClient(c))).toBe('2001:db8::abcd');
  });

  it('returns null when only loopback/link-local addresses are present', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue(
      agent([
        { name: 'lo', 'ip-addresses': [{ 'ip-address-type': 'ipv6', 'ip-address': '::1' }] },
        { name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv6', 'ip-address': 'fe80::1' }] },
      ]),
    );
    expect(await getVmIpAddress('pve-1', 101, asClient(c))).toBeNull();
  });

  it('returns null when the agent is unreachable (rejects)', async () => {
    const c = fakeClient();
    c.get.mockRejectedValue(new Error('QEMU guest agent is not running'));
    expect(await getVmIpAddress('pve-1', 101, asClient(c))).toBeNull();
  });
});
