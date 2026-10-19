import { describe, it, expect, vi } from 'vitest';

// A tenant NIC never carries VLAN trunks: they would let the guest reach segments
// other than the one isolation puts it on. Every NIC-touching isolation path
// removes them, whatever a restored archive or snapshot config says.

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { ensureNicFirewall, setVmVlanTag, withoutTrunks } from '../src/services/proxmox.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const withNics = (nics: Record<string, string>) => {
  const c = fakeClient();
  c.get.mockResolvedValue({ data: { data: nics } });
  return c;
};

describe('trunks on tenant NICs (audit round 2)', () => {
  it('withoutTrunks drops the option wherever it sits', () => {
    expect(withoutTrunks('virtio=AA,bridge=vmbr0,trunks=1;2;3,firewall=1')).toBe('virtio=AA,bridge=vmbr0,firewall=1');
    expect(withoutTrunks('virtio=AA,bridge=vmbr0,trunks=1-4094')).toBe('virtio=AA,bridge=vmbr0');
  });

  it('ensureNicFirewall strips trunks even when the firewall flag is already set', async () => {
    const c = withNics({ net0: 'virtio=AA,bridge=vmbr0,firewall=1,trunks=1-4094', net1: 'virtio=BB,bridge=vmbr0,firewall=1' });
    await ensureNicFirewall('pve1', 100, asClient(c));
    expect(c.put).toHaveBeenCalledTimes(1);
    expect(bodyOf(c.put.mock.calls[0]!)).toEqual({ net0: 'virtio=AA,bridge=vmbr0,firewall=1' });
  });

  it('setVmVlanTag strips trunks when the tag is already right, and when it sets one', async () => {
    const c = withNics({ net0: 'virtio=AA,bridge=vmbr0,tag=42,trunks=7', net1: 'virtio=BB,bridge=vmbr0,trunks=7' });
    await setVmVlanTag('pve1', 100, 42, asClient(c));
    expect(c.put.mock.calls.map((x) => bodyOf(x))).toEqual([
      { net0: 'virtio=AA,bridge=vmbr0,tag=42' },
      { net1: 'virtio=BB,bridge=vmbr0,tag=42' },
    ]);
  });
});
