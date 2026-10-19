import { describe, it, expect, vi, beforeEach } from 'vitest';

// The IDE pinhole a MateState restore re-opens must use the same port the IDE
// installer opens and code-server binds to — including when IDE_GUEST_PORT is
// set to something non-numeric, which keeps the default everywhere.

vi.hoisted(() => {
  process.env['IDE_GUEST_PORT'] = 'abc';
});

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    mateState: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (key: string) => ({ default_bridge: 'vmbr0', isolation_enabled: 'true', ide_ingress_cidr: '10.0.0.5/32' })[key] ?? null),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(),
    readIsolationOptions: vi.fn(async () => ({ dnsServers: [], vlanTag: 42 })),
    configureVmIsolation: vi.fn(async () => undefined),
    ensureIdePinhole: vi.fn(async () => undefined),
  };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { guestMarker } from '../src/services/vm.service.js';
import { restoreFromMateState } from '../src/services/matestate.service.js';
import { IDE_GUEST_PORT } from '../src/services/ide-provision.service.js';
import { fakeClient, asClient } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const VOLID = 'backups:backup/vzdump-qemu-100-2026_10_01-03_00_00.vma.zst';
const LIVE = {
  name: 'web', tags: guestMarker('rowa'), cores: '1', memory: '1024',
  scsi0: 'local-lvm:vm-100-disk-0,size=32G', net0: 'virtio=AA:BB,bridge=vmbr0,firewall=1',
};
const row = () =>
  ({
    id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1',
    cpu: 1, ram: 1024, storage: 32, hasPassthrough: false, quotaExempt: false, status: 'stopped', ideState: 'ready',
  }) as never;
const ms = { id: 'ms1', vmId: 'rowa', status: 'ready', volid: VOLID, proxmoxNode: 'pve1', storage: 'backups' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  const c = fakeClient();
  const cfg = { ...LIVE } as Record<string, string>;
  c.get.mockImplementation((url: string) => {
    if (url.startsWith('/cluster/resources'))
      return ok([{ type: 'qemu', vmid: 100, node: 'pve1', tags: cfg['tags'] }, { type: 'node', node: 'pve1', status: 'online' }]);
    if (/\/qemu\/100\/config$/.test(url)) return ok(cfg);
    if (/\/qemu\/100\/status\/current$/.test(url)) return ok({ status: 'stopped' });
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    if (url.startsWith('/nodes/pve1/vzdump/extractconfig'))
      return ok(Object.entries(LIVE).map(([k, v]) => `${k}: ${v}`).join('\n'));
    if (url.startsWith('/nodes/pve1/storage/backups/content')) return ok([{ volid: VOLID, vmid: 100 }]);
    return ok(null);
  });
  c.post.mockImplementation(() => ok('UPID:fake'));
  c.put.mockImplementation(() => ok(''));
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row());
  vi.mocked(prisma.virtualMachine.update).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ ...(row() as object), ...data }) as never,
  );
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200, accessExpiresAt: null,
  } as never);
  vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([] as never);
});

describe('MateState restore re-opens the IDE pinhole on the shared guest port', () => {
  it('a non-numeric IDE_GUEST_PORT re-opens 8080, the port the installer uses', async () => {
    await restoreFromMateState(row(), ms);
    expect(IDE_GUEST_PORT).toBe(8080);
    expect(pve.ensureIdePinhole).toHaveBeenCalledWith(
      'pve1', 100, { port: IDE_GUEST_PORT, source: '10.0.0.5/32' }, expect.anything(), 'qemu',
    );
  });
});
