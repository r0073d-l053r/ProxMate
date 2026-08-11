import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
  },
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { deployFromTemplate } from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

/**
 * The admin's "Default storage" and "Default network bridge" applied to guests that
 * are CLONED rather than created (B-37 / B-38).
 *
 * A template deploy is a clone, so `net0` and the disk are inherited verbatim from
 * the template and none of the create-time paths that honour these two settings ever
 * run. Both settings were accepted, saved, and then silently ignored for every
 * template deploy, duplicate and restore — verified live on 2026-08-11, where a
 * deploy with `vmbr9` + `ceph-vm` configured landed on `vmbr0` with a `tank:` disk.
 *
 * B-38 is the more serious half: it re-pins new guests to node-local storage, which
 * silently undoes the 2026-08-01 migratability fix. B-37 matters because network
 * placement is the load-bearing half of tenant isolation — a guest on the wrong
 * bridge is a guest outside the segment, whatever the firewall says.
 */

const NODE = 'pve-1';
const VMID = 101;
const CONFIG_URL = `/nodes/${NODE}/qemu/${VMID}/config`;

function withConfig(cfg: Record<string, string>) {
  const c = fakeClient();
  c.get.mockResolvedValue({ data: { data: cfg } });
  return c;
}

// ─── setVmBridge ──────────────────────────────────────────────

describe('setVmBridge', () => {
  it('moves a CLONE off the bridge it inherited from the template', async () => {
    const c = withConfig({ net0: 'virtio=BC:24:11:A1:55:3E,bridge=vmbr0,firewall=1' });

    await pve.setVmBridge(NODE, VMID, 'vmbr9', asClient(c));

    expect(c.put).toHaveBeenCalledTimes(1);
    expect(c.put.mock.calls[0]![0]).toBe(CONFIG_URL);
    expect(bodyOf(c.put.mock.calls[0]!)['net0']).toBe(
      'virtio=BC:24:11:A1:55:3E,bridge=vmbr9,firewall=1',
    );
  });

  it('preserves the MAC, the firewall flag and the VLAN tag', async () => {
    // Exactly the config the live 2026-08-11 deploy produced.
    const c = withConfig({ net0: 'virtio=BC:24:11:A1:55:3E,bridge=vmbr0,firewall=1,tag=100' });

    await pve.setVmBridge(NODE, VMID, 'vmbr9', asClient(c));

    const net0 = bodyOf(c.put.mock.calls[0]!)['net0']!;
    expect(net0).toBe('virtio=BC:24:11:A1:55:3E,bridge=vmbr9,firewall=1,tag=100');
  });

  it('is a no-op when the NIC is already on the bridge (no live re-plug)', async () => {
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr9,firewall=1' });

    await pve.setVmBridge(NODE, VMID, 'vmbr9', asClient(c));

    expect(c.put).not.toHaveBeenCalled();
  });

  it('adds a bridge to a NIC that names none', async () => {
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,firewall=1' });

    await pve.setVmBridge(NODE, VMID, 'vmbr9', asClient(c));

    expect(bodyOf(c.put.mock.calls[0]!)['net0']).toBe('virtio=AA:BB:CC:DD:EE:FF,firewall=1,bridge=vmbr9');
  });

  it('moves every NIC, not just the first', async () => {
    const c = withConfig({
      net0: 'virtio=AA:BB:CC:DD:EE:01,bridge=vmbr0',
      net1: 'virtio=AA:BB:CC:DD:EE:02,bridge=vmbr1',
      scsi0: 'tank:vm-101-disk-0,size=5G',
    });

    await pve.setVmBridge(NODE, VMID, 'vmbr9', asClient(c));

    expect(c.put).toHaveBeenCalledTimes(2);
    const written = c.put.mock.calls.map((call) => bodyOf(call));
    expect(written[0]!['net0']).toContain('bridge=vmbr9');
    expect(written[1]!['net1']).toContain('bridge=vmbr9');
  });

  it('does not touch a guest with no NIC at all', async () => {
    const c = withConfig({ scsi0: 'tank:vm-101-disk-0,size=5G' });

    await pve.setVmBridge(NODE, VMID, 'vmbr9', asClient(c));

    expect(c.put).not.toHaveBeenCalled();
  });

  it('works on an LXC (netN keys, /lxc/ path)', async () => {
    const c = withConfig({ net0: 'name=eth0,bridge=vmbr0,firewall=1,ip=dhcp' });

    await pve.setVmBridge(NODE, VMID, 'vmbr9', asClient(c), 'lxc');

    expect(c.put.mock.calls[0]![0]).toBe(`/nodes/${NODE}/lxc/${VMID}/config`);
    expect(bodyOf(c.put.mock.calls[0]!)['net0']).toBe('name=eth0,bridge=vmbr9,firewall=1,ip=dhcp');
  });

  it.each(['vm br0', 'vmbr0,firewall=0', 'bridge=vmbr0', '', '9vmbr'])(
    'refuses the name %j rather than corrupting the NIC line',
    async (bad) => {
      const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0' });

      await expect(pve.setVmBridge(NODE, VMID, bad, asClient(c))).rejects.toThrow(/Invalid bridge name/);
      expect(c.put).not.toHaveBeenCalled();
    },
  );
});

describe('getVmBridge', () => {
  it('reads the bridge off the first NIC', async () => {
    const c = withConfig({ net1: 'virtio=A,bridge=vmbr1', net0: 'virtio=B,bridge=vmbr9' });
    expect(await pve.getVmBridge(NODE, VMID, asClient(c))).toBe('vmbr9');
  });

  it('is null when there is no NIC', async () => {
    const c = withConfig({ scsi0: 'tank:vm-101-disk-0,size=5G' });
    expect(await pve.getVmBridge(NODE, VMID, asClient(c))).toBeNull();
  });
});

// ─── diskStorageOf ────────────────────────────────────────────

describe('diskStorageOf', () => {
  it('reads the pool off the primary disk', () => {
    expect(pve.diskStorageOf({ scsi0: 'tank:vm-104-disk-0,size=5G' })).toBe('tank');
  });

  it('ignores the cdrom / cloud-init drive', () => {
    expect(
      pve.diskStorageOf({ ide2: 'local:104/vm-104-cloudinit.qcow2,media=cdrom', scsi0: 'ceph-vm:vm-104-disk-0,size=5G' }),
    ).toBe('ceph-vm');
  });

  it('is null for a guest with no disk', () => {
    expect(pve.diskStorageOf({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0' })).toBeNull();
  });

  it('is null for a non-storage-backed volume', () => {
    expect(pve.diskStorageOf({ scsi0: 'none,media=disk' })).toBeNull();
  });
});

// ─── storageAvailableOn ───────────────────────────────────────

describe('storageAvailableOn', () => {
  const list = (rows: unknown[]) => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: rows } });
    return c;
  };

  it('is true when the node reports the pool', async () => {
    const c = list([{ storage: 'ceph-vm', type: 'rbd', active: 1 }]);
    expect(await pve.storageAvailableOn(NODE, 'ceph-vm', asClient(c))).toBe(true);
  });

  it('is false when the node reports other pools but not this one', async () => {
    const c = list([{ storage: 'tank', type: 'zfspool', active: 1 }]);
    expect(await pve.storageAvailableOn(NODE, 'ceph-vm', asClient(c))).toBe(false);
  });

  it('is true when the probe tells us nothing — a failed probe must not veto the setting', async () => {
    const empty = list([]);
    expect(await pve.storageAvailableOn(NODE, 'ceph-vm', asClient(empty))).toBe(true);

    const broken = fakeClient();
    broken.get.mockRejectedValue(new Error('403'));
    expect(await pve.storageAvailableOn(NODE, 'ceph-vm', asClient(broken))).toBe(true);
  });
});

// ─── applyDefaultBridge ───────────────────────────────────────

const findConfig = vi.mocked(prisma.systemConfig.findUnique);

/** Drive getConfig from a plain key→value map; anything absent reads as unset. */
function configuredAs(values: Record<string, string>) {
  findConfig.mockImplementation((args: { where: { key: string } }) => {
    const v = values[args.where.key];
    return (v === undefined ? null : { key: args.where.key, value: v, sensitive: false }) as never;
  });
}

describe('applyDefaultBridge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing when no default bridge is configured', async () => {
    configuredAs({});
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0' });

    await pve.applyDefaultBridge(NODE, VMID, asClient(c));

    expect(c.put).not.toHaveBeenCalled();
  });

  it('applies the configured bridge to a clone', async () => {
    configuredAs({ default_bridge: 'vmbr9' });
    const c = withConfig({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1' });

    await pve.applyDefaultBridge(NODE, VMID, asClient(c));

    expect(bodyOf(c.put.mock.calls[0]!)['net0']).toBe('virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr9,firewall=1');
  });
});

// ─── deployFromTemplate: the two settings, end to end ─────────

const createVm = vi.mocked(prisma.virtualMachine.create);
const updateVm = vi.mocked(prisma.virtualMachine.update);
const findManyVm = vi.mocked(prisma.virtualMachine.findMany);
const getClient = vi.mocked(pve.getClient);

const user = { id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200 } as never;

const template = (over: Record<string, unknown> = {}) =>
  ({
    id: 't1',
    name: 'Debian 12',
    os: 'Debian 12',
    proxmoxVmId: 9000,
    proxmoxNode: NODE,
    cloudInit: false,
    diskGb: 5,
    ...over,
  }) as never;

const input = { name: 'app-01', cpu: 2, ram: 2048, storage: 5 };

/**
 * A cluster where template 9000 lives on `templateStorage` and node pve-1 offers
 * `nodeStorages`. The new guest is VMID 101.
 */
function fakeCluster(templateStorage: string, nodeStorages: string[]) {
  const c = fakeClient();
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  c.get.mockImplementation((url: string) => {
    if (url === '/cluster/nextid') return ok(String(VMID));
    if (/\/nodes\/[^/]+\/storage$/.test(url)) {
      return ok(nodeStorages.map((storage) => ({ storage, type: 'dir', active: 1 })));
    }
    if (/\/qemu\/9000\/config$/.test(url)) return ok({ scsi0: `${templateStorage}:base-9000-disk-0,size=5G` });
    if (/\/qemu\/101\/config$/.test(url)) {
      return ok({ scsi0: 'x:vm-101-disk-0,size=5G', net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1' });
    }
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    if (/\/firewall\/rules$/.test(url)) return ok([]);
    return ok(null);
  });
  return c;
}

const cloneBody = (c: ReturnType<typeof fakeClient>) =>
  bodyOf(c.post.mock.calls.find((x) => /\/qemu\/9000\/clone$/.test(String(x[0])))!);

describe('deployFromTemplate honours the admin defaults (B-37 / B-38)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyVm.mockResolvedValue([] as never);
    createVm.mockResolvedValue({ id: 'vm1', name: input.name, proxmoxVmId: VMID, proxmoxNode: NODE } as never);
    updateVm.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'vm1', ...args.data }) as never,
    );
  });

  it('puts the clone on the configured bridge, keeping its MAC and firewall flag', async () => {
    configuredAs({ default_bridge: 'vmbr9', default_storage: 'ceph-vm' });
    const c = fakeCluster('ceph-vm', ['ceph-vm']);
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), input);

    const nic = c.put.mock.calls.map(bodyOf).find((b) => b['net0'] !== undefined);
    expect(nic!['net0']).toBe('virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr9,firewall=1');
  });

  it('passes the configured storage on a cloud-image (full) clone', async () => {
    configuredAs({ default_storage: 'ceph-vm' });
    const c = fakeCluster('tank', ['tank', 'ceph-vm']);
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template({ cloudInit: true }), input);

    expect(cloneBody(c)).toMatchObject({ full: '1', storage: 'ceph-vm' });
  });

  it('full-clones a linked-clone template that is NOT on the configured pool', async () => {
    // The migratability case: template on node-local `tank`, default `ceph-vm`. A
    // linked clone cannot be placed off its base image, so the link is what gives way.
    configuredAs({ default_storage: 'ceph-vm' });
    const c = fakeCluster('tank', ['tank', 'ceph-vm']);
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), input);

    expect(cloneBody(c)).toMatchObject({ full: '1', storage: 'ceph-vm' });
  });

  it('stays linked when the template already lives on the configured pool', async () => {
    configuredAs({ default_storage: 'ceph-vm' });
    const c = fakeCluster('ceph-vm', ['ceph-vm']);
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), input);

    const body = cloneBody(c);
    expect(body['full']).toBe('0');
    expect(body['storage']).toBeUndefined();
  });

  it('stays linked when no default storage is configured at all', async () => {
    configuredAs({});
    const c = fakeCluster('tank', ['tank']);
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), input);

    const body = cloneBody(c);
    expect(body['full']).toBe('0');
    expect(body['storage']).toBeUndefined();
  });

  it('falls back to the template\'s storage when the node cannot see the configured pool', async () => {
    // Better a deploy that works on the wrong pool than a hard failure: the clone
    // runs on the node holding the template, and Proxmox rejects a pool it can't see.
    configuredAs({ default_storage: 'ceph-vm' });
    const c = fakeCluster('tank', ['tank']);
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), input);

    const body = cloneBody(c);
    expect(body['full']).toBe('0');
    expect(body['storage']).toBeUndefined();
  });
});
