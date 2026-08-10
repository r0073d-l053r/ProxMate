import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { setVmVlanTag, getVmVlanTag } from '../src/services/proxmox.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

/**
 * Per-guest VLAN tagging.
 *
 * The per-VM firewall works at L3 and above, so it cannot stop a guest poisoning ARP,
 * answering DHCP, or advertising itself as an IPv6 router to anything sharing its
 * broadcast domain — an authorized pentest confirmed that live on 2026-07-18. The fix
 * is to stop the domain being shared. That makes this the load-bearing half of tenant
 * isolation, and these tests pin the parts that are easy to get subtly wrong.
 *
 * The critical case is `applies to a CLONE, whose net0 came from the template`: guests
 * deployed from a template never run the create-time code that builds a netN string,
 * so a tag applied only there would silently miss every tenant VM.
 */

const NODE = 'pve-1';
const VMID = 101;
const CONFIG_URL = `/nodes/${NODE}/qemu/${VMID}/config`;

function withConfig(cfg: Record<string, string>) {
  const c = fakeClient();
  c.get.mockResolvedValue({ data: { data: cfg } });
  return c;
}

describe('setVmVlanTag', () => {
  it('applies to a CLONE, whose net0 came from the template untagged', async () => {
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1' });

    await setVmVlanTag(NODE, VMID, 42, asClient(c));

    expect(c.put).toHaveBeenCalledTimes(1);
    expect(c.put.mock.calls[0]![0]).toBe(CONFIG_URL);
    expect(bodyOf(c.put.mock.calls[0]!)['net0']).toBe(
      'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1,tag=42',
    );
  });

  it('preserves the firewall flag and MAC rather than rebuilding the NIC', async () => {
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1' });

    await setVmVlanTag(NODE, VMID, 7, asClient(c));

    const net0 = bodyOf(c.put.mock.calls[0]!)['net0']!;
    expect(net0).toContain('firewall=1');
    expect(net0).toContain('AA:BB:CC:DD:EE:FF');
    expect(net0).toContain('bridge=vmbr0');
  });

  it('retags a guest that is already on a different VLAN', async () => {
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=10' });

    await setVmVlanTag(NODE, VMID, 20, asClient(c));

    expect(bodyOf(c.put.mock.calls[0]!)['net0']).toBe('virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=20');
  });

  it('is idempotent — no write when the tag is already correct', async () => {
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=42' });

    await setVmVlanTag(NODE, VMID, 42, asClient(c));

    expect(c.put).not.toHaveBeenCalled();
  });

  it('strips the tag when passed null, without mangling the rest of the NIC', async () => {
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=42,firewall=1' });

    await setVmVlanTag(NODE, VMID, null, asClient(c));

    expect(bodyOf(c.put.mock.calls[0]!)['net0']).toBe('virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1');
  });

  it('does nothing when asked to strip a tag that is not there', async () => {
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0' });

    await setVmVlanTag(NODE, VMID, null, asClient(c));

    expect(c.put).not.toHaveBeenCalled();
  });

  it('tags every NIC, not just the first', async () => {
    const c = withConfig({
      net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0',
      net1: 'virtio=11:22:33:44:55:66,bridge=vmbr1',
    });

    await setVmVlanTag(NODE, VMID, 5, asClient(c));

    expect(c.put).toHaveBeenCalledTimes(2);
    const written = c.put.mock.calls.map((call) => bodyOf(call));
    expect(written.map((b) => Object.keys(b)[0]).sort()).toEqual(['net0', 'net1']);
    expect(written.every((b) => Object.values(b)[0]!.includes('tag=5'))).toBe(true);
  });

  it('ignores non-NIC config keys', async () => {
    const c = withConfig({
      net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0',
      scsi0: 'ceph-vm:vm-101-disk-0,size=32G',
      ide2: 'ceph-vm:vm-101-cloudinit,media=cdrom',
    });

    await setVmVlanTag(NODE, VMID, 5, asClient(c));

    expect(c.put).toHaveBeenCalledTimes(1);
    expect(Object.keys(bodyOf(c.put.mock.calls[0]!))).toEqual(['net0']);
  });

  it.each([0, 4095, -1, 1.5, 99999])('refuses the invalid VLAN id %s rather than writing it', async (bad) => {
    // Proxmox would reject these at start time, long after the deploy "succeeded".
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0' });

    await expect(setVmVlanTag(NODE, VMID, bad, asClient(c))).rejects.toThrow(/VLAN tag/i);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('accepts the boundary ids 1 and 4094', async () => {
    for (const ok of [1, 4094]) {
      const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0' });
      await setVmVlanTag(NODE, VMID, ok, asClient(c));
      expect(bodyOf(c.put.mock.calls[0]!)['net0']).toContain(`tag=${ok}`);
    }
  });
});

describe('getVmVlanTag', () => {
  it('reads the tag off the first NIC', async () => {
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=42' });
    expect(await getVmVlanTag(NODE, VMID, asClient(c))).toBe(42);
  });

  it('returns null for an untagged guest', async () => {
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0' });
    expect(await getVmVlanTag(NODE, VMID, asClient(c))).toBeNull();
  });

  it('returns null for a guest with no NIC at all', async () => {
    const c = withConfig({ scsi0: 'ceph-vm:vm-101-disk-0,size=32G' });
    expect(await getVmVlanTag(NODE, VMID, asClient(c))).toBeNull();
  });
});
