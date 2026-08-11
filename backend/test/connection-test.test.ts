import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/config.service.js', () => ({
  isSetupComplete: vi.fn(),
  getConfig: vi.fn(async () => null),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/auth.service.js', () => ({ createSession: vi.fn() }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(async () => ({}) as never),
    getVersion: vi.fn(async () => '9.2.3'),
    getNodes: vi.fn(async () => [{ node: 'pve', status: 'online' }]),
    getStorages: vi.fn(async () => [{ storage: 'local', type: 'dir' }]),
    getBridges: vi.fn(async () => []),
    getEffectivePermissions: vi.fn(async () => ({})),
    getClusterVmCount: vi.fn(async () => 3),
  };
});

import * as pve from '../src/services/proxmox.service.js';
import { testProxmoxConnection } from '../src/services/setup.service.js';

/**
 * B-34. The connection test used to ask for `/version` and `/nodes` and report success.
 * Both answer happily for a token with ZERO permissions, which is exactly how both of
 * this project's token failures shipped silently:
 *
 *  1. `pveum user token add` defaults `--privsep` to 1, so a fresh token has no rights
 *     until an ACL names it — and an ACL granted with `--users` is a silent no-op for a
 *     privsep token. Even a root@pam-owned token gets nothing automatically, because
 *     "root@pam!proxmate" is not the string "root@pam".
 *  2. A published least-privilege role omitted `VM.Audit`. The token authenticated, the
 *     test passed, and ProxMate showed zero VMs.
 *
 * Both present as an empty dashboard, which sends whoever debugs it at the network
 * layer instead of the ACL. Every failure here must therefore name the privilege.
 */

const perms = vi.mocked(pve.getEffectivePermissions);
const storages = vi.mocked(pve.getStorages);
const vmCount = vi.mocked(pve.getClusterVmCount);
const nodes = vi.mocked(pve.getNodes);
const version = vi.mocked(pve.getVersion);

/** Everything ProxMate wants, granted at the root — the healthy case. */
const FULL = {
  '/': {
    'VM.Audit': 1, 'VM.Allocate': 1, 'VM.Config.Disk': 1, 'VM.Config.Network': 1,
    'VM.Config.Cloudinit': 1, 'VM.PowerMgmt': 1, 'VM.Console': 1, 'VM.Clone': 1,
    'VM.Snapshot': 1, 'Datastore.Audit': 1, 'Datastore.AllocateSpace': 1, 'Sys.Audit': 1,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  version.mockResolvedValue('9.2.3');
  nodes.mockResolvedValue([{ node: 'pve', status: 'online' }] as never);
  storages.mockResolvedValue([{ storage: 'local', type: 'dir' }] as never);
  vmCount.mockResolvedValue(3);
  perms.mockResolvedValue(FULL);
});

describe('a healthy token', () => {
  it('reports what it can actually reach, with no warnings', async () => {
    const r = await testProxmoxConnection();
    expect(r).toMatchObject({ connected: true, version: '9.2.3', nodeCount: 1, vmCount: 3, storageCount: 1 });
    expect(r.warnings).toEqual([]);
  });
});

describe('the blind token — the failure this check exists for', () => {
  it('rejects a token with no permissions at all, and names privilege separation', async () => {
    perms.mockResolvedValue({}); // exactly what a --privsep 1 token returns

    // Before B-34 this returned { connected: true } and setup carried on.
    await expect(testProxmoxConnection()).rejects.toThrow(/privsep/i);
  });

  it('gives the actual fix, not just the diagnosis', async () => {
    perms.mockResolvedValue({});
    const err = await testProxmoxConnection().catch((e: Error) => e);
    expect(String(err)).toMatch(/pveum acl modify/);
    // The two traps that make people grant the ACL and still see nothing.
    expect(String(err)).toMatch(/--users/);
    expect(String(err)).toMatch(/root@pam/);
  });

  it('never reports connected:true when permissions are empty', async () => {
    perms.mockResolvedValue({});
    await expect(testProxmoxConnection()).rejects.toThrow();
  });
});

describe('a token missing one load-bearing read privilege', () => {
  it('names VM.Audit rather than saying "connection failed"', async () => {
    const { 'VM.Audit': _drop, ...rest } = FULL['/'];
    perms.mockResolvedValue({ '/': rest });

    const err = await testProxmoxConnection().catch((e: Error) => e);
    expect(String(err)).toMatch(/VM\.Audit is missing/);
    expect(String(err)).not.toMatch(/^Error: Connection failed/);
  });

  it('names Datastore.Audit, and calls out the PVEVMUser trap that causes it', async () => {
    const { 'Datastore.Audit': _drop, ...rest } = FULL['/'];
    perms.mockResolvedValue({ '/': rest });

    const err = await testProxmoxConnection().catch((e: Error) => e);
    expect(String(err)).toMatch(/Datastore\.Audit is missing/);
    expect(String(err)).toMatch(/PVEVMUser/);
  });

  it('points at the one diagnostic worth running first', async () => {
    perms.mockResolvedValue({ '/': { 'Datastore.Audit': 1 } });
    const err = await testProxmoxConnection().catch((e: Error) => e);
    expect(String(err)).toMatch(/pveum user token permissions/);
  });
});

describe('a privilege granted on a path that holds nothing', () => {
  it('fails when Datastore.Audit is held but no storage comes back', async () => {
    // Every cluster has at least `local`, so an empty list means a scoped grant.
    storages.mockResolvedValue([] as never);
    const err = await testProxmoxConnection().catch((e: Error) => e);
    expect(String(err)).toMatch(/no storages/);
    expect(String(err)).toMatch(/scoped to a path/);
  });

  it('WARNS rather than fails when VM.Audit is held but no guests are visible', async () => {
    // Deliberate deviation from a hard "≥1 VM row" gate: a brand-new cluster
    // genuinely has no guests, and rejecting that would be this check making the
    // opposite mistake to the one it exists to catch.
    vmCount.mockResolvedValue(0);

    const r = await testProxmoxConnection();
    expect(r.connected).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/no guests are visible/);
    expect(r.warnings.join(' ')).toMatch(/scoped to a path that excludes them/);
  });
});

describe('privileges that are not blocking but will bite later', () => {
  it('warns per missing operational privilege, naming what breaks', async () => {
    perms.mockResolvedValue({ '/': { 'VM.Audit': 1, 'Datastore.Audit': 1 } }); // read-only

    const r = await testProxmoxConnection();
    expect(r.connected).toBe(true); // a read-only token is a legitimate thing to point at ProxMate
    const all = r.warnings.join('\n');
    expect(all).toMatch(/VM\.Allocate is missing — creating and deleting guests will fail/);
    expect(all).toMatch(/VM\.PowerMgmt is missing/);
    expect(all).toMatch(/Datastore\.AllocateSpace is missing/);
    expect(all).toMatch(/Sys\.Audit is missing/);
  });

  it('accepts a correctly scoped least-privilege token granted on a pool, not the root', async () => {
    // Path-agnostic on purpose: a grant on /pool/students is a real grant, and
    // requiring it at "/" would reject exactly the token EDU is supposed to use.
    perms.mockResolvedValue({ '/pool/students': FULL['/'] });

    const r = await testProxmoxConnection();
    expect(r.connected).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

describe('heldPrivileges', () => {
  it('collects privileges across every path', () => {
    const held = pve.heldPrivileges({ '/': { 'VM.Audit': 1 }, '/storage/tank': { 'Datastore.Audit': 1 } });
    expect([...held].sort()).toEqual(['Datastore.Audit', 'VM.Audit']);
  });

  it('ignores privileges explicitly set to 0 rather than counting the key', () => {
    expect(pve.heldPrivileges({ '/': { 'VM.Audit': 0 } }).size).toBe(0);
  });

  it('is empty for an empty or absent map', () => {
    expect(pve.heldPrivileges({}).size).toBe(0);
    expect(pve.heldPrivileges(undefined as never).size).toBe(0);
  });
});
