import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { attachPci, detachPci, getPassthroughDevices, listPciMappings } from '../src/services/proxmox.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const NODE = 'pve-0';
const VMID = 100;

describe('getPassthroughDevices (parse hostpciN)', () => {
  it('parses mapping-based devices, sorted by index', () => {
    const devices = getPassthroughDevices({
      scsi0: 'local-lvm:vm-100-disk-0',
      hostpci1: 'mapping=nic,pcie=1',
      hostpci0: 'mapping=gpu0,pcie=1,x-vga=1',
      net0: 'virtio=AA:BB',
    });
    expect(devices).toEqual([
      { index: 0, slot: 'hostpci0', mapping: 'gpu0', raw: 'mapping=gpu0,pcie=1,x-vga=1' },
      { index: 1, slot: 'hostpci1', mapping: 'nic', raw: 'mapping=nic,pcie=1' },
    ]);
  });

  it('returns [] when no hostpci keys are present', () => {
    expect(getPassthroughDevices({ scsi0: 'x', net0: 'y' })).toEqual([]);
  });

  it('handles a raw (non-mapping) hostpci value', () => {
    const [d] = getPassthroughDevices({ hostpci0: '0000:01:00.0,pcie=1' });
    expect(d).toMatchObject({ index: 0, mapping: undefined });
  });
});

describe('attachPci / detachPci (config writes)', () => {
  it('attach sets hostpci{index}=mapping=<name>,pcie=1', async () => {
    const c = fakeClient();
    await attachPci(NODE, VMID, 0, 'gpu0', asClient(c));
    expect(c.put.mock.calls[0]![0]).toBe(`/nodes/${NODE}/qemu/${VMID}/config`);
    expect(bodyOf(c.put.mock.calls[0]!)).toEqual({ hostpci0: 'mapping=gpu0,pcie=1' });
  });

  it('detach deletes hostpci{index}', async () => {
    const c = fakeClient();
    await detachPci(NODE, VMID, 2, asClient(c));
    expect(bodyOf(c.put.mock.calls[0]!)).toEqual({ delete: 'hostpci2' });
  });
});

describe('listPciMappings', () => {
  it('maps id/description and derives nodes from string-form map entries', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          { id: 'gpu0', description: 'RTX', map: ['id=10de:1234,node=pve-0,path=0000:01:00.0', 'node=pve-1,path=0000:02:00.0'] },
          { id: 'nic', map: [{ node: 'pve-2', path: '0000:03:00.0' }] },
        ],
      },
    });
    const mappings = await listPciMappings(asClient(c));
    expect(c.get.mock.calls[0]![0]).toBe('/cluster/mapping/pci');
    expect(mappings[0]).toEqual({ id: 'gpu0', description: 'RTX', nodes: ['pve-0', 'pve-1'] });
    // Object-form map entries are parsed too.
    expect(mappings[1]).toEqual({ id: 'nic', description: undefined, nodes: ['pve-2'] });
  });

  it('returns [] when no mappings are defined', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: [] } });
    expect(await listPciMappings(asClient(c))).toEqual([]);
  });
});
