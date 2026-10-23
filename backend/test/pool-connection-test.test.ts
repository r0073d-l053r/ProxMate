import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The connection test with a resource pool configured, and the admin action that
// moves the guests ProxMate manages into it. A pool-scoped token is only a boundary
// when (a) the pool exists, (b) the guest privileges are granted there, (c) nothing
// still grants them on /, and (d) ProxMate's guests are actually in the pool.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn() },
    template: { findMany: vi.fn() },
  },
}));
const config: Record<string, string> = {};
vi.mock('../src/services/config.service.js', () => ({
  isSetupComplete: vi.fn(),
  getConfig: vi.fn(async (key: string) => config[key] ?? null),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/auth.service.js', () => ({ createSession: vi.fn() }));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(),
    getVersion: vi.fn(async () => '9.2.3'),
    getNodes: vi.fn(async () => [{ node: 'pve1', status: 'online' }]),
    getStorages: vi.fn(async () => [{ storage: 'local', type: 'dir' }]),
    getEffectivePermissions: vi.fn(async () => ({})),
    getClusterVmCount: vi.fn(async () => 3),
  };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { testProxmoxConnection } from '../src/services/setup.service.js';
import { moveManagedGuestsIntoPool } from '../src/services/guest-pool.service.js';
import { guestMarker, templateMarker } from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const perms = vi.mocked(pve.getEffectivePermissions);

const GUEST = {
  'VM.Audit': 1, 'VM.Allocate': 1, 'VM.Backup': 1, 'VM.Clone': 1, 'VM.Console': 1, 'VM.Migrate': 1,
  'VM.PowerMgmt': 1, 'VM.Snapshot': 1, 'VM.Snapshot.Rollback': 1,
  'VM.Config.CDROM': 1, 'VM.Config.CPU': 1, 'VM.Config.Cloudinit': 1, 'VM.Config.Disk': 1,
  'VM.Config.HWType': 1, 'VM.Config.Memory': 1, 'VM.Config.Network': 1, 'VM.Config.Options': 1,
  'VM.GuestAgent.Audit': 1, 'VM.GuestAgent.Unrestricted': 1,
  'Pool.Audit': 1, 'Pool.Allocate': 1,
};
const DATASTORE = { 'Datastore.AllocateSpace': 1, 'Datastore.AllocateTemplate': 1, 'Datastore.Audit': 1 };
/** What `deploy/proxmox-token.sh --pool proxmate` grants on 9.x, as /access/permissions reports it. */
const POOL_SCOPED = {
  '/': { 'Sys.Audit': 1 },
  '/nodes': { 'Sys.Audit': 1, 'Sys.AccessNetwork': 1 },
  '/storage': DATASTORE,
  '/storage/local': { ...DATASTORE, 'Datastore.Allocate': 1 },
  '/sdn/zones': { 'SDN.Audit': 1, 'SDN.Use': 1 },
  '/pool/proxmate': GUEST,
};
const FIREWALL_STEP = /Sys\.Modify on \/ is not granted, so ProxMate cannot enable the cluster firewall/;

interface Guest { vmid: number; name: string; tags?: string; pool?: string; template?: number; type?: string }

/** A cluster holding `guests`, with the pools in `pools`. */
function cluster(guests: Guest[], pools = ['proxmate']) {
  const c = fakeClient();
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  c.get.mockImplementation((url: string) => {
    if (url === '/pools') return ok(pools.map((poolid) => ({ poolid })));
    if (url === '/cluster/resources?type=vm') {
      return ok(guests.map((g) => ({ type: g.type ?? 'qemu', node: 'pve1', ...g })));
    }
    const m = /\/(?:qemu|lxc)\/(\d+)\/config$/.exec(url);
    if (m) return ok({ tags: guests.find((g) => g.vmid === Number(m[1]))?.tags ?? '' });
    return ok(null);
  });
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return c;
}

const rows = (list: Array<[string, number]>) =>
  vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue(
    list.map(([id, proxmoxVmId]) => ({ id, name: `vm-${id}`, proxmoxVmId, status: 'running' })) as never,
  );
const templates = (list: Array<[string, number]>) =>
  vi.mocked(prisma.template.findMany).mockResolvedValue(
    list.map(([id, proxmoxVmId]) => ({ id, name: `tpl-${id}`, proxmoxVmId })) as never,
  );

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(config)) delete config[k];
  config['proxmox_pool'] = 'proxmate';
  perms.mockResolvedValue(POOL_SCOPED);
  vi.mocked(pve.getVersion).mockResolvedValue('9.2.3');
  rows([['rowa', 100]]);
  templates([]);
});

describe('connection test with a pool configured', () => {
  it('passes for a pool-scoped token whose guests are all in the pool, noting only the manual firewall step', async () => {
    cluster([{ vmid: 100, name: 'web', tags: guestMarker('rowa'), pool: 'proxmate' }]);
    const r = await testProxmoxConnection();
    expect(r.warnings).toEqual([expect.stringMatching(FIREWALL_STEP)]);
    expect(r.pool).toMatchObject({ name: 'proxmate', exists: true, missingOnPool: [], guestPrivilegesOnRoot: [], outside: [] });
  });

  it('fails when the pool does not exist (every create would be refused)', async () => {
    cluster([], ['other']);
    await expect(testProxmoxConnection()).rejects.toThrow(/pool "proxmate" does not exist.*pveum pool add proxmate/s);
  });

  it('only warns when the token cannot see whether the pool exists (no Pool.Audit)', async () => {
    const { 'Pool.Audit': _drop, ...guest } = GUEST;
    perms.mockResolvedValue({ ...POOL_SCOPED, '/pool/proxmate': guest });
    cluster([{ vmid: 100, name: 'web', tags: guestMarker('rowa'), pool: 'proxmate' }], []);
    const r = await testProxmoxConnection();
    expect(r.pool!.exists).toBeNull();
    expect(r.warnings.join('\n')).toMatch(/Could not confirm .* lacks Pool\.Audit on \/pool\/proxmate/);
  });

  it('names each guest privilege missing on the pool', async () => {
    const { 'VM.Snapshot': _a, 'VM.Console': _b, ...guest } = GUEST;
    // Granted elsewhere, so the path-agnostic generic check is satisfied.
    perms.mockResolvedValue({ ...POOL_SCOPED, '/pool/proxmate': guest, '/pool/other': { 'VM.Snapshot': 1, 'VM.Console': 1 } });
    cluster([{ vmid: 100, name: 'web', tags: guestMarker('rowa'), pool: 'proxmate' }]);
    const r = await testProxmoxConnection();
    expect(r.pool!.missingOnPool).toEqual(['VM.Console', 'VM.Snapshot']);
    expect(r.warnings.join('\n')).toMatch(/missing VM\.Console, VM\.Snapshot on \/pool\/proxmate/);
  });

  it('warns that the pool limits nothing while guest privileges are still granted on /', async () => {
    // The default script's grant: the role on / with propagation, so /vms has it too.
    perms.mockResolvedValue({ ...POOL_SCOPED, '/': { ...POOL_SCOPED['/'], ...GUEST }, '/vms': GUEST });
    cluster([{ vmid: 100, name: 'web', tags: guestMarker('rowa'), pool: 'proxmate' }]);
    const r = await testProxmoxConnection();
    expect(r.pool!.guestPrivilegesOnRoot).toContain('VM.Allocate');
    expect(r.pool!.guestPrivilegesOnRoot).not.toContain('Pool.Audit');
    expect(r.warnings.join('\n')).toMatch(/still holds guest privileges on \/.*limits nothing/);
  });

  it('inherits the pool answer from / when no ACL names the pool path', async () => {
    perms.mockResolvedValue({ '/': { ...POOL_SCOPED['/'], ...GUEST, ...POOL_SCOPED['/storage'], ...POOL_SCOPED['/sdn'] }, '/vms': GUEST, '/pool': GUEST });
    cluster([{ vmid: 100, name: 'web', tags: guestMarker('rowa'), pool: 'proxmate' }]);
    const r = await testProxmoxConnection();
    expect(r.pool!.missingOnPool).toEqual([]);
    expect(r.pool!.guestPrivilegesOnRoot.length).toBeGreaterThan(0);
  });

  it('lists managed guests outside the pool, and only those carrying their row\'s marker', async () => {
    rows([['rowa', 100], ['rowb', 300]]);
    templates([['t1', 9000]]);
    cluster([
      { vmid: 100, name: 'web', tags: guestMarker('rowa') }, // ours, in no pool
      { vmid: 101, name: 'unmarked' }, // not ProxMate's
      { vmid: 102, name: 'stray', tags: guestMarker('rowb') }, // rowb's marker, but rowb is VMID 300
      { vmid: 300, name: 'db', tags: guestMarker('rowb'), pool: 'proxmate' }, // ours, already in
      { vmid: 9000, name: 'debian', tags: templateMarker('t1'), pool: 'other', template: 1 }, // our template
    ]);
    const r = await testProxmoxConnection();
    expect(r.pool!.outside.map((g) => g.vmid)).toEqual([100, 9000]);
    expect(r.warnings.join('\n')).toMatch(/2 guest\(s\) ProxMate manages are not in the pool "proxmate"/);
    expect(r.warnings.join('\n')).toMatch(/Move managed guests into the pool/);
  });

  it('reports machines whose guest the token cannot see, with the root command that fixes it', async () => {
    rows([['rowa', 100], ['rowc', 105]]);
    cluster([{ vmid: 100, name: 'web', tags: guestMarker('rowa'), pool: 'proxmate' }]);
    const r = await testProxmoxConnection();
    expect(r.pool!.notVisible).toEqual([{ vmid: 105, name: 'vm-rowc' }]);
    expect(r.warnings.join('\n')).toMatch(/pveum pool modify proxmate --vms 105/);
  });
});

describe('connection test: what a pool-scoped token still reaches outside the pool', () => {
  beforeEach(() => {
    cluster([{ vmid: 100, name: 'web', tags: guestMarker('rowa'), pool: 'proxmate' }]);
  });

  it('fails when VM.Allocate is held neither on the pool nor on /vms', async () => {
    const { 'VM.Allocate': _drop, ...guest } = GUEST;
    perms.mockResolvedValue({ ...POOL_SCOPED, '/pool/proxmate': guest, '/pool/other': { 'VM.Allocate': 1 } });
    await expect(testProxmoxConnection()).rejects.toThrow(/VM\.Allocate is missing on \/pool\/proxmate/);
  });

  it('says plainly that Sys.Modify on / means the pool does not fully contain the token', async () => {
    perms.mockResolvedValue({ ...POOL_SCOPED, '/': { 'Sys.Audit': 1, 'Sys.Modify': 1 } });
    const r = await testProxmoxConnection();
    const all = r.warnings.join('\n');
    expect(all).toMatch(/holds Sys\.Modify on \/, so the pool does not fully contain it/);
    expect(all).not.toMatch(FIREWALL_STEP);
    expect(all).not.toMatch(/Sys\.Modify is missing/);
  });

  it('warns about Datastore.Allocate granted on every storage', async () => {
    perms.mockResolvedValue({ ...POOL_SCOPED, '/storage': { ...DATASTORE, 'Datastore.Allocate': 1 } });
    const r = await testProxmoxConnection();
    expect(r.warnings.join('\n')).toMatch(/Datastore\.Allocate on \/storage, which lets it delete any volume/);
  });

  describe('the snippet storage', () => {
    beforeEach(() => {
      process.env['SNIPPET_DIR'] = '/snippets';
      process.env['SNIPPET_STORAGE'] = 'cephfs';
    });
    afterEach(() => {
      delete process.env['SNIPPET_DIR'];
      delete process.env['SNIPPET_STORAGE'];
      vi.mocked(pve.getStorages).mockResolvedValue([{ storage: 'local', type: 'dir' }] as never);
    });

    it('warns when its snippets content type is off and the token cannot turn it on', async () => {
      vi.mocked(pve.getStorages).mockResolvedValue([{ storage: 'cephfs', type: 'cephfs', content: 'iso,backup' }] as never);
      const r = await testProxmoxConnection();
      expect(r.warnings.join('\n')).toMatch(/snippet storage "cephfs" does not have the snippets content type/);
    });

    it('stays quiet once snippets are enabled there, without Datastore.Allocate', async () => {
      vi.mocked(pve.getStorages).mockResolvedValue([{ storage: 'cephfs', type: 'cephfs', content: 'snippets' }] as never);
      const r = await testProxmoxConnection();
      expect(r.warnings.join('\n')).not.toMatch(/snippet/);
    });
  });

  it('does not ask for the cluster firewall step once the firewall is on', async () => {
    const c = cluster([{ vmid: 100, name: 'web', tags: guestMarker('rowa'), pool: 'proxmate' }]);
    const base = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) =>
      url === '/cluster/firewall/options' ? Promise.resolve({ data: { data: { enable: 1 } } }) : base(url),
    );
    const r = await testProxmoxConnection();
    expect(r.warnings).toEqual([]);
  });

  it('never asks for Datastore.Allocate on the ISO or backup storage', async () => {
    config['iso_storage'] = 'nfs-iso';
    config['backup_storage'] = 'backups';
    const r = await testProxmoxConnection();
    expect(r.warnings.join('\n')).not.toMatch(/nfs-iso|backups/);
  });

  it('warns when cloud-image downloads have neither Sys.AccessNetwork nor Sys.Modify', async () => {
    perms.mockResolvedValue({ ...POOL_SCOPED, '/nodes': { 'Sys.Audit': 1 } });
    const r = await testProxmoxConnection();
    expect(r.warnings.join('\n')).toMatch(/Sys\.AccessNetwork is missing on \/nodes — importing cloud images/);
  });

  it('before Proxmox VE 8.2, asks for Sys.Modify on / for downloads instead', async () => {
    vi.mocked(pve.getVersion).mockResolvedValue('8.1.4');
    const r = await testProxmoxConnection();
    expect(r.warnings.join('\n')).toMatch(/Proxmox VE 8\.1\.4 checks Sys\.Audit and Sys\.Modify on \/ for cloud-image downloads/);
  });
});

describe('connection test without a pool configured', () => {
  it('reports no pool section for the default, root-granted token', async () => {
    delete config['proxmox_pool'];
    perms.mockResolvedValue({ ...POOL_SCOPED, '/': { ...POOL_SCOPED['/'], ...GUEST }, '/vms': GUEST });
    cluster([]);
    const r = await testProxmoxConnection();
    expect(r.pool).toBeUndefined();
    expect(r.warnings.join('\n')).not.toMatch(/pool/i);
  });

  it('points at the pool setting when the token is scoped to a pool ProxMate does not use', async () => {
    delete config['proxmox_pool'];
    cluster([]);
    const r = await testProxmoxConnection();
    expect(r.warnings.join('\n')).toMatch(/granted only on \/pool\/proxmate, but no Proxmox pool is set/);
  });
});

describe('moveManagedGuestsIntoPool', () => {
  it('moves only guests whose own config carries their row\'s ProxMate marker', async () => {
    rows([['rowa', 100], ['rowb', 300], ['rowd', 104]]);
    templates([['t1', 9000]]);
    const c = cluster([
      { vmid: 100, name: 'web', tags: guestMarker('rowa') },
      { vmid: 101, name: 'unmarked' },
      { vmid: 102, name: 'stray', tags: guestMarker('rowb') },
      { vmid: 104, name: 'ct', tags: guestMarker('rowd'), type: 'lxc', pool: 'proxmate' },
      { vmid: 9000, name: 'debian', tags: templateMarker('t1'), pool: 'other', template: 1 },
    ]);

    const r = await moveManagedGuestsIntoPool();

    expect(r).toEqual({
      pool: 'proxmate',
      moved: [
        { vmid: 100, name: 'web', template: false, from: null },
        { vmid: 9000, name: 'debian', template: true, from: 'other' },
      ],
      failed: [],
    });
    // One request per guest.
    expect(c.put.mock.calls.map((x) => bodyOf(x))).toEqual([
      { poolid: 'proxmate', vms: '100', 'allow-move': '1' },
      { poolid: 'proxmate', vms: '9000', 'allow-move': '1' },
    ]);
  });

  it('reports a refused guest and still moves the others', async () => {
    rows([['rowa', 100], ['rowb', 101]]);
    const c = cluster([
      { vmid: 100, name: 'web', tags: guestMarker('rowa'), pool: 'locked' },
      { vmid: 101, name: 'db', tags: guestMarker('rowb') },
    ]);
    c.put.mockImplementation((_url: string, body: URLSearchParams) =>
      body.get('vms') === '100'
        ? Promise.reject(new Error('Permission check failed (/pool/locked, Pool.Allocate)'))
        : Promise.resolve({ data: { data: '' } }),
    );
    const r = await moveManagedGuestsIntoPool();
    expect(r.moved.map((g) => g.vmid)).toEqual([101]);
    expect(r.failed).toEqual([
      { vmid: 100, name: 'web', template: false, from: 'locked', error: 'Permission check failed (/pool/locked, Pool.Allocate)' },
    ]);
  });

  it('leaves a guest alone when its config no longer carries the marker the listing showed', async () => {
    const c = cluster([{ vmid: 100, name: 'web', tags: guestMarker('rowa') }]);
    const base = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) =>
      /\/qemu\/100\/config$/.test(url) ? Promise.resolve({ data: { data: { tags: 'something-else' } } }) : base(url),
    );
    const r = await moveManagedGuestsIntoPool();
    expect(r.moved).toEqual([]);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('does nothing when every managed guest is already in the pool', async () => {
    const c = cluster([{ vmid: 100, name: 'web', tags: guestMarker('rowa'), pool: 'proxmate' }]);
    expect((await moveManagedGuestsIntoPool()).moved).toEqual([]);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('refuses without a configured pool', async () => {
    delete config['proxmox_pool'];
    cluster([]);
    await expect(moveManagedGuestsIntoPool()).rejects.toThrow(/No Proxmox pool is configured/);
  });
});
