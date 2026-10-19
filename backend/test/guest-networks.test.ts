import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(async () => null) }));

import { getGuestNetworks, NETWORK_NAME_RE } from '../src/services/proxmox.service.js';
import { fakeClient, asClient } from './helpers.js';

/**
 * Issue #126: on a cluster that uses SDN only (no vmbrN for guests) the setup wizard's
 * network picker was empty, and since the default network is required, setup could
 * not be finished. Discovery asked the FIRST node for `?type=bridge`, which returns
 * Linux bridges and nothing else — no SDN VNets, no OVS bridges, and no word about a
 * bridge that exists on one node of an 8-node cluster but not the other seven.
 */

type Routes = Record<string, unknown[] | Error>;

/** A fake client answering GETs from a path → data table; unknown paths 404. */
function cluster(routes: Routes) {
  const c = fakeClient();
  c.get.mockImplementation(async (url: string) => {
    const hit = routes[url];
    if (hit === undefined || hit instanceof Error) throw hit ?? new Error(`404 ${url}`);
    return { data: { data: hit } };
  });
  return c;
}

const NODES = [
  { node: 'pve1', status: 'online' },
  { node: 'pve2', status: 'online' },
  { node: 'pve3', status: 'offline' },
];

describe('getGuestNetworks', () => {
  it('lists SDN VNets on a cluster with no Linux bridge at all (the #126 cluster)', async () => {
    const c = cluster({
      '/nodes': NODES,
      '/nodes/pve1/network?type=any_bridge': [],
      '/nodes/pve2/network?type=any_bridge': [],
      '/cluster/sdn/vnets': [
        { vnet: 'tenants', zone: 'evpn1', alias: 'Tenant VMs', type: 'vnet' },
        { vnet: 'lab', zone: 'vx1', type: 'vnet' },
      ],
      '/cluster/sdn/zones': [{ zone: 'evpn1', type: 'evpn' }, { zone: 'vx1', type: 'vxlan', nodes: 'pve2,pve3' }],
    });

    const nets = await getGuestNetworks(asClient(c));
    expect(nets).toEqual([
      // A zone restricted to some nodes only spans the ONLINE ones among them.
      { name: 'lab', kind: 'vnet', zone: 'vx1', nodes: ['pve2'] },
      { name: 'tenants', kind: 'vnet', zone: 'evpn1', comment: 'Tenant VMs', nodes: ['pve1', 'pve2'] },
    ]);
  });

  it('includes OVS bridges, which ?type=bridge never returned', async () => {
    const c = cluster({
      '/nodes': NODES,
      '/nodes/pve1/network?type=any_bridge': [{ iface: 'vmbr0', type: 'OVSBridge' }],
      '/nodes/pve2/network?type=any_bridge': [{ iface: 'vmbr0', type: 'OVSBridge' }],
    });
    expect(await getGuestNetworks(asClient(c))).toEqual([{ name: 'vmbr0', kind: 'ovs', nodes: ['pve1', 'pve2'] }]);
  });

  it('asks every online node and records where each bridge exists', async () => {
    const c = cluster({
      '/nodes': NODES,
      '/nodes/pve1/network?type=any_bridge': [
        { iface: 'vmbr0', type: 'bridge', comments: ' uplink \n' },
        { iface: 'vmbr9', type: 'bridge' },
      ],
      '/nodes/pve2/network?type=any_bridge': [{ iface: 'vmbr0', type: 'bridge' }],
    });

    const nets = await getGuestNetworks(asClient(c));
    expect(nets).toEqual([
      { name: 'vmbr0', kind: 'bridge', comment: 'uplink', nodes: ['pve1', 'pve2'] },
      // Only on pve1: a guest placed on pve2 with this bridge would fail to start.
      { name: 'vmbr9', kind: 'bridge', nodes: ['pve1'] },
    ]);
    // The offline node is not asked at all.
    expect(c.get).not.toHaveBeenCalledWith('/nodes/pve3/network?type=any_bridge');
  });

  it('merges a VNet reported both per node (PVE 8+ any_bridge) and by /cluster/sdn', async () => {
    const c = cluster({
      '/nodes': NODES,
      '/nodes/pve1/network?type=any_bridge': [{ iface: 'vmbr0', type: 'bridge' }, { iface: 'tenants', type: 'vnet' }],
      '/nodes/pve2/network?type=any_bridge': [{ iface: 'tenants', type: 'vnet' }],
      '/cluster/sdn/vnets': [{ vnet: 'tenants', zone: 'evpn1' }],
      '/cluster/sdn/zones': [{ zone: 'evpn1' }],
    });

    const nets = await getGuestNetworks(asClient(c));
    expect(nets.map((n) => n.name)).toEqual(['vmbr0', 'tenants']); // bridges first, no duplicate
    expect(nets[1]).toEqual({ name: 'tenants', kind: 'vnet', zone: 'evpn1', nodes: ['pve1', 'pve2'] });
  });

  it('still returns the bridges when SDN is unavailable or SDN.Audit is missing', async () => {
    const c = cluster({
      '/nodes': NODES,
      '/nodes/pve1/network?type=any_bridge': [{ iface: 'vmbr0', type: 'bridge' }],
      '/nodes/pve2/network?type=any_bridge': [{ iface: 'vmbr0', type: 'bridge' }],
      '/cluster/sdn/vnets': new Error('403 Permission check failed (/sdn, SDN.Audit)'),
      '/cluster/sdn/zones': new Error('403 Permission check failed (/sdn, SDN.Audit)'),
    });
    expect((await getGuestNetworks(asClient(c))).map((n) => n.name)).toEqual(['vmbr0']);
  });

  it('survives one node failing to answer', async () => {
    const c = cluster({
      '/nodes': NODES,
      '/nodes/pve1/network?type=any_bridge': new Error('timeout'),
      '/nodes/pve2/network?type=any_bridge': [{ iface: 'vmbr0', type: 'bridge' }],
    });
    expect(await getGuestNetworks(asClient(c))).toEqual([{ name: 'vmbr0', kind: 'bridge', nodes: ['pve2'] }]);
  });

  it('falls back to the unfiltered interface list when a release rejects any_bridge', async () => {
    const c = cluster({
      '/nodes': [{ node: 'pve1', status: 'online' }],
      '/nodes/pve1/network?type=any_bridge': new Error('400 type: value is not a valid enum'),
      '/nodes/pve1/network': [
        { iface: 'eno1', type: 'eth' },
        { iface: 'vmbr0', type: 'bridge' },
      ],
    });
    expect(await getGuestNetworks(asClient(c))).toEqual([{ name: 'vmbr0', kind: 'bridge', nodes: ['pve1'] }]);
  });

  it('ignores non-bridge interfaces and names a NIC line could not carry', async () => {
    const c = cluster({
      '/nodes': [{ node: 'pve1', status: 'online' }],
      '/nodes/pve1/network?type=any_bridge': [
        { iface: 'eno1', type: 'eth' },
        { iface: 'bond0', type: 'bond' },
        { iface: 'bad,name', type: 'bridge' },
        { iface: 'vmbr0', type: 'bridge' },
      ],
    });
    expect((await getGuestNetworks(asClient(c))).map((n) => n.name)).toEqual(['vmbr0']);
  });
});

describe('NETWORK_NAME_RE', () => {
  it('accepts Linux bridges, OVS bridges and SDN VNet IDs', () => {
    for (const ok of ['vmbr0', 'vmbr0.50', 'tenants', 'vnet1', 'br_lan-2']) expect(NETWORK_NAME_RE.test(ok)).toBe(true);
  });

  it('rejects anything that would corrupt a comma-separated netN line', () => {
    for (const bad of ['', '0vmbr', 'vmbr0,tag=5', 'a=b', 'vm br0', 'x'.repeat(33)]) {
      expect(NETWORK_NAME_RE.test(bad)).toBe(false);
    }
  });
});
