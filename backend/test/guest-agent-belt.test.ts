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
  return {
    ...actual,
    getClient: vi.fn(),
    snippetWriteConfig: vi.fn(() => null),
    ensureCloudInitSnippet: vi.fn(async () => null),
    nodesWithSnippet: vi.fn(async () => [] as string[]),
    cloudInitSnippetFile: vi.fn((ids: string[]) => `proxmate-${[...ids].sort().join('-')}.yaml`),
  };
});
vi.mock('../src/services/template.service.js', () => ({
  getOfferedFeatureIds: vi.fn(async () => ['docker', 'tailscale', 'guest-agent', 'superfile']),
  getBaseFeatureIds: vi.fn(async () => [] as string[]),
}));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { deployFromTemplate } from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

/**
 * B-39. ProxMate applies a cloud-init login password in-guest through the QEMU guest
 * agent — never as `cipassword`, which would write the crypt hash somewhere the
 * tenant can read it back. So a password request implies the agent, and the deploy
 * path adds the `guest-agent` cloud-init feature whenever one is asked for.
 *
 * That belt must never break the trousers. Installing the agent at deploy time needs
 * a snippet on the node AND working apt on first boot, and an isolated or air-gapped
 * deployment has neither — which is exactly why the recommended answer is a template
 * that already ships qemu-guest-agent. Found live on 2026-08-11: a deploy from an
 * agent-baked template FAILED OUTRIGHT because ProxMate insisted on also installing
 * the agent and could not find the snippet. The deploy would have worked perfectly.
 *
 * The rule these tests pin: a snippet missing for a feature somebody CHOSE is a hard
 * error (they would silently get a box without the software they picked); a snippet
 * missing for the auto-added agent is not (drop it and carry on — and if the agent
 * really is absent, `deploy.agent_missing` tells an admin when the window closes).
 */

// A password deploy stores the secret encrypted until the agent can apply it.
process.env['ENCRYPTION_KEY'] = 'a'.repeat(64);

const NODE = 'pve-1';
const VMID = 101;

const findConfig = vi.mocked(prisma.systemConfig.findUnique);
const createVm = vi.mocked(prisma.virtualMachine.create);
const updateVm = vi.mocked(prisma.virtualMachine.update);
const findManyVm = vi.mocked(prisma.virtualMachine.findMany);
const getClient = vi.mocked(pve.getClient);
const nodesWithSnippet = vi.mocked(pve.nodesWithSnippet);

const user = { id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200 } as never;

const template = {
  id: 't1',
  name: 'debian-13-trixie-agent',
  os: 'Debian 13',
  proxmoxVmId: 9100,
  proxmoxNode: NODE,
  cloudInit: true,
  diskGb: 3,
} as never;

const base = { name: 'app-01', cpu: 1, ram: 1024, storage: 3, username: 'debian' };

function fakeCluster() {
  const c = fakeClient();
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  c.get.mockImplementation((url: string) => {
    if (url === '/cluster/nextid') return ok(String(VMID));
    if (/\/nodes\/[^/]+\/storage$/.test(url)) return ok([]);
    if (/\/qemu\/\d+\/config$/.test(url)) {
      return ok({ scsi0: 'ceph-vm:vm-101-disk-0,size=3G', net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1' });
    }
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    if (/\/firewall\/rules$/.test(url)) return ok([]);
    return ok(null);
  });
  getClient.mockResolvedValue(asClient(c));
  return c;
}

/** The `cicustom` value ProxMate wrote onto the clone, if any. */
const vendorSnippetOf = (c: ReturnType<typeof fakeClient>) =>
  c.put.mock.calls.map(bodyOf).find((b) => b['cicustom'] !== undefined)?.['cicustom'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pve.snippetWriteConfig).mockReturnValue(null);
  vi.mocked(pve.ensureCloudInitSnippet).mockResolvedValue(null);
  vi.mocked(pve.cloudInitSnippetFile).mockImplementation((ids: string[]) => `proxmate-${[...ids].sort().join('-')}.yaml`);
  findConfig.mockResolvedValue(null as never);
  findManyVm.mockResolvedValue([] as never);
  createVm.mockResolvedValue({ id: 'vm1', name: base.name, proxmoxVmId: VMID, proxmoxNode: NODE } as never);
  updateVm.mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'vm1', ...args.data }) as never);
});

describe('the auto-added guest-agent feature', () => {
  it('does NOT fail a password-only deploy when no snippet exists — the live 2026-08-11 bug', async () => {
    nodesWithSnippet.mockResolvedValue([]); // nothing placed on any node
    const c = fakeCluster();

    // Before the fix this threw "The selected setup (guest-agent) isn't installed…"
    // and left the tenant with an errored deploy from a template that had the agent.
    await expect(deployFromTemplate(user, template, { ...base, password: 'pw' })).resolves.toBeTruthy();

    // No snippet referenced at all — nothing to point cloud-init at.
    expect(vendorSnippetOf(c)).toBeUndefined();
  });

  it('still uses the snippet when one IS available', async () => {
    nodesWithSnippet.mockResolvedValue([NODE]);
    const c = fakeCluster();

    await deployFromTemplate(user, template, { ...base, password: 'pw' });

    expect(vendorSnippetOf(c)).toContain('guest-agent');
  });

  it('is not added at all when no password was requested', async () => {
    nodesWithSnippet.mockResolvedValue([NODE]);
    const c = fakeCluster();

    await deployFromTemplate(user, template, base);

    expect(vendorSnippetOf(c)).toBeUndefined();
    expect(vi.mocked(pve.cloudInitSnippetFile)).not.toHaveBeenCalled();
  });
});

describe('a feature the tenant actually chose', () => {
  it('still fails hard when its snippet is missing — silently omitting it is worse', async () => {
    nodesWithSnippet.mockResolvedValue([]);
    fakeCluster();

    await expect(
      deployFromTemplate(user, template, { ...base, features: ['docker'] }),
    ).rejects.toThrow(/docker.*isn't installed on node/);
  });

  it('fails naming only the CHOSEN features, never the auto-added agent', async () => {
    // Both password and docker; nothing placed. The error an admin reads must point
    // at the snippet they need to add, not at one ProxMate added behind their back.
    nodesWithSnippet.mockResolvedValue([]);
    fakeCluster();

    await expect(
      deployFromTemplate(user, template, { ...base, password: 'pw', features: ['docker'] }),
    ).rejects.toThrow(/^The selected setup \(docker\) isn't installed/);
  });

  it('falls back to the chosen-only snippet when the combined one is absent', async () => {
    // `docker` is placed; `docker + guest-agent` is not. The tenant gets docker and
    // loses only the belt.
    nodesWithSnippet.mockImplementation(async (_storage: string, file: string) =>
      file === 'proxmate-docker.yaml' ? [NODE] : [],
    );
    const c = fakeCluster();

    await deployFromTemplate(user, template, { ...base, password: 'pw', features: ['docker'] });

    expect(vendorSnippetOf(c)).toContain('proxmate-docker.yaml');
    expect(vendorSnippetOf(c)).not.toContain('guest-agent');
  });
});
