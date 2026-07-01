import { describe, it, expect, vi } from 'vitest';

// Keep tests hermetic: prevent lib/prisma from constructing a real PrismaClient
// (proxmox.service → config.service → prisma) at import time.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import {
  createLxc,
  listLxcTemplates,
  getTemplateNodes,
  getLxcIpAddress,
  configureVmIsolation,
  restoreBackup,
  startVm,
  stopVm,
  shutdownVm,
  rebootVm,
  getVmStatus,
  deleteVm,
  getVmConfig,
  setVmResources,
  resizeDisk,
  getVmRrdData,
  waitForTask,
} from '../src/services/proxmox.service.js';
import { requestTermProxy } from '../src/services/vnc-proxy.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const NODE = 'pve-1';
const VMID = 200;

describe('createLxc (container create request)', () => {
  it('POSTs to /nodes/{node}/lxc with rootfs, firewalled NIC, template and start=0', async () => {
    const c = fakeClient();
    const upid = await createLxc(
      {
        node: NODE,
        vmid: VMID,
        hostname: 'ct-web',
        cores: 2,
        memory: 2048,
        diskGb: 20,
        storage: 'local-lvm',
        bridge: 'vmbr0',
        ostemplate: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
        password: 'hunter2!',
        sshPublicKeys: 'ssh-ed25519 AAAA you@host',
      },
      asClient(c),
    );

    expect(upid).toBe('UPID:fake');
    expect(c.post.mock.calls[0]![0]).toBe(`/nodes/${NODE}/lxc`);
    const body = bodyOf(c.post.mock.calls[0]!);
    expect(body).toMatchObject({
      vmid: String(VMID),
      hostname: 'ct-web',
      cores: '2',
      memory: '2048',
      swap: '512',
      rootfs: 'local-lvm:20',
      ostemplate: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
      unprivileged: '1',
      start: '0',
      password: 'hunter2!',
      'ssh-public-keys': 'ssh-ed25519 AAAA you@host',
    });
    // The NIC must carry firewall=1 so tenant isolation applies before boot.
    expect(body.net0).toBe('name=eth0,bridge=vmbr0,firewall=1,ip=dhcp');
  });

  it('omits credentials when none are supplied', async () => {
    const c = fakeClient();
    await createLxc(
      { node: NODE, vmid: VMID, hostname: 'ct', cores: 1, memory: 512, diskGb: 8, storage: 'local-lvm', bridge: 'vmbr0', ostemplate: 'local:vztmpl/x.tar.zst' },
      asClient(c),
    );
    const body = bodyOf(c.post.mock.calls[0]!);
    expect(body.password).toBeUndefined();
    expect(body['ssh-public-keys']).toBeUndefined();
  });
});

describe('listLxcTemplates', () => {
  it('scans vztmpl-capable storages on every node and dedupes by volid', async () => {
    const c = fakeClient();
    const volid = 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst';
    c.get.mockImplementation((url: string) => {
      if (url === '/nodes') return Promise.resolve({ data: { data: [{ node: 'pve-0' }, { node: 'pve-1' }] } });
      if (url === '/storage')
        return Promise.resolve({
          data: { data: [{ storage: 'local', content: 'vztmpl,iso' }, { storage: 'local-lvm', content: 'images' }] },
        });
      if (url.includes('/storage/local/content'))
        return Promise.resolve({ data: { data: [{ volid, size: 123 }] } });
      return Promise.resolve({ data: { data: [] } });
    });

    const templates = await listLxcTemplates(asClient(c));
    // Same volid reported on both nodes → deduped to one entry.
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ volid, storage: 'local', name: 'debian-12-standard_12.7-1_amd64.tar.zst' });
    // Only the vztmpl-capable storage ('local') is queried, never 'local-lvm'.
    expect(c.get.mock.calls.some((call) => String(call[0]).includes('/storage/local-lvm/content'))).toBe(false);
  });
});

describe('getTemplateNodes', () => {
  it('returns only the nodes that physically hold the template volume', async () => {
    const c = fakeClient();
    const volid = 'local:vztmpl/debian.tar.zst';
    c.get.mockImplementation((url: string) => {
      if (url === '/cluster/resources')
        return Promise.resolve({
          data: {
            data: [
              { type: 'node', status: 'online', node: 'pve-0' },
              { type: 'node', status: 'online', node: 'pve-1' },
            ],
          },
        });
      if (url.startsWith('/nodes/pve-0/storage/local/content'))
        return Promise.resolve({ data: { data: [{ volid }] } });
      if (url.startsWith('/nodes/pve-1/storage/local/content'))
        return Promise.resolve({ data: { data: [] } });
      return Promise.resolve({ data: { data: [] } });
    });

    expect(await getTemplateNodes(volid, asClient(c))).toEqual(['pve-0']);
  });
});

describe('getLxcIpAddress', () => {
  it('returns the first non-loopback IPv4, stripping the CIDR prefix', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: { data: [{ name: 'lo', inet: '127.0.0.1/8' }, { name: 'eth0', inet: '192.168.50.40/24' }] },
    });
    expect(await getLxcIpAddress(NODE, VMID, asClient(c))).toBe('192.168.50.40');
    expect(c.get.mock.calls[0]![0]).toBe(`/nodes/${NODE}/lxc/${VMID}/interfaces`);
  });

  it('returns null when interfaces are unavailable (container stopped)', async () => {
    const c = fakeClient();
    c.get.mockRejectedValue(new Error('not running'));
    expect(await getLxcIpAddress(NODE, VMID, asClient(c))).toBeNull();
  });
});

describe('kind-aware lifecycle uses the /lxc/ path segment', () => {
  it('power + status + delete + config + resize target /lxc/', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: { status: 'running' } } });

    await startVm(NODE, VMID, asClient(c), 'lxc');
    await stopVm(NODE, VMID, asClient(c), 'lxc');
    await shutdownVm(NODE, VMID, asClient(c), 'lxc');
    await rebootVm(NODE, VMID, asClient(c), 'lxc');
    await deleteVm(NODE, VMID, asClient(c), 'lxc');
    await getVmStatus(NODE, VMID, asClient(c), 'lxc');
    await setVmResources(NODE, VMID, 2, 1024, asClient(c), 'lxc');
    await resizeDisk(NODE, VMID, 'rootfs', 40, asClient(c), 'lxc');
    await getVmRrdData(NODE, VMID, 'hour', asClient(c), 'lxc');

    const seg = `/nodes/${NODE}/lxc/${VMID}`;
    expect(c.post.mock.calls.map((k) => k[0])).toEqual([
      `${seg}/status/start`,
      `${seg}/status/stop`,
      `${seg}/status/shutdown`,
      `${seg}/status/reboot`,
    ]);
    expect(c.delete.mock.calls[0]![0]).toBe(seg);
    expect(c.put.mock.calls.map((k) => k[0])).toEqual([`${seg}/config`, `${seg}/resize`]);
    expect(c.get.mock.calls.map((k) => k[0])).toContain(`${seg}/status/current`);
    // rootfs resize sends disk=rootfs
    expect(bodyOf(c.put.mock.calls[1]!)).toMatchObject({ disk: 'rootfs', size: '40G' });
  });

  it('getVmConfig defaults to qemu but reads /lxc/ when asked', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: { rootfs: 'local-lvm:subvol-200-disk-0,size=8G' } } });
    await getVmConfig(NODE, VMID, asClient(c), 'lxc');
    expect(c.get.mock.calls[0]![0]).toBe(`/nodes/${NODE}/lxc/${VMID}/config`);
  });
});

describe('configureVmIsolation (kind-aware firewall path)', () => {
  it('locks the container firewall down at /nodes/{node}/lxc/{vmid}/firewall', async () => {
    const c = fakeClient();
    await configureVmIsolation(NODE, VMID, {}, asClient(c), 'lxc');
    expect(c.put.mock.calls[0]![0]).toBe(`/nodes/${NODE}/lxc/${VMID}/firewall/options`);
    expect(c.post.mock.calls.every((call) => String(call[0]).startsWith(`/nodes/${NODE}/lxc/${VMID}/firewall/rules`))).toBe(true);
    // Same isolation policy as QEMU (default-deny in, RFC1918 drops + DNS allow).
    expect(bodyOf(c.put.mock.calls[0]!)).toMatchObject({ policy_in: 'DROP', macfilter: '1', ipfilter: '0' });
  });
});

describe('restoreBackup (kind-aware restore shape)', () => {
  it('restores a QEMU VM via archive= on POST /qemu', async () => {
    const c = fakeClient();
    await restoreBackup({ node: NODE, vmid: VMID, volid: 'store:backup/vzdump-qemu-200-x.vma.zst' }, asClient(c), 'qemu');
    expect(c.post.mock.calls[0]![0]).toBe(`/nodes/${NODE}/qemu`);
    expect(bodyOf(c.post.mock.calls[0]!)).toMatchObject({ archive: 'store:backup/vzdump-qemu-200-x.vma.zst', force: '1' });
  });

  it('restores an LXC container via ostemplate= + restore=1 on POST /lxc', async () => {
    const c = fakeClient();
    await restoreBackup({ node: NODE, vmid: VMID, volid: 'store:backup/vzdump-lxc-200-x.tar.zst' }, asClient(c), 'lxc');
    expect(c.post.mock.calls[0]![0]).toBe(`/nodes/${NODE}/lxc`);
    expect(bodyOf(c.post.mock.calls[0]!)).toMatchObject({
      vmid: String(VMID),
      ostemplate: 'store:backup/vzdump-lxc-200-x.tar.zst',
      restore: '1',
      force: '1',
    });
  });
});

describe('waitForTask tolerates task warnings', () => {
  it('resolves when a task finishes OK', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: { status: 'stopped', exitstatus: 'OK' } } });
    await expect(waitForTask(NODE, 'UPID:x', asClient(c))).resolves.toBeUndefined();
  });

  it('treats "WARNINGS: N" as success (LXC creates and vzdump commonly warn)', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: { status: 'stopped', exitstatus: 'WARNINGS: 1' } } });
    await expect(waitForTask(NODE, 'UPID:x', asClient(c))).resolves.toBeUndefined();
  });

  it('still throws on a genuine failure exitstatus', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({ data: { data: { status: 'stopped', exitstatus: 'unable to create CT' } } });
    await expect(waitForTask(NODE, 'UPID:x', asClient(c))).rejects.toThrow(/task failed/i);
  });
});

describe('console proxies are kind-aware', () => {
  it('requestTermProxy targets /lxc/{vmid}/termproxy for a container', async () => {
    const c = fakeClient();
    c.post.mockResolvedValue({ data: { data: { ticket: 'T', port: 5900, user: 'root@pam' } } });
    await requestTermProxy(NODE, VMID, asClient(c), 'lxc');
    expect(c.post.mock.calls[0]![0]).toBe(`/nodes/${NODE}/lxc/${VMID}/termproxy`);
  });
});
