import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { template: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() } },
}));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (k: string) =>
    ({ default_storage: 'ceph-vm', default_bridge: 'vmbr0', iso_storage: 'local' })[k] ?? null,
  ),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(async () => ({ put: vi.fn(async () => ({ data: { data: '' } })) })),
  pickBestNode: vi.fn(async () => 'pve-0'),
  getImportStorages: vi.fn(async () => ['local']),
  getNextVmId: vi.fn(async () => 9100),
  downloadUrlToStorage: vi.fn(async () => 'UPID:dl'),
  createCloudInitVm: vi.fn(async () => 'UPID:create'),
  getVmConfig: vi.fn(async () => ({ scsi0: 'ceph-vm:vm-9100-disk-0,size=8G' })),
  primaryDiskSizeGb: vi.fn(() => 8),
  convertToTemplate: vi.fn(async () => undefined),
  deleteStorageVolume: vi.fn(async () => undefined),
  deleteVm: vi.fn(async () => 'UPID:del'),
  waitForTask: vi.fn(async () => undefined),
  pveMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  archFromImageUrl: vi.fn(() => 'amd64'),
  getTemplates: vi.fn(async () => []),
  isCloudInitTemplate: vi.fn(() => true),
  ensureCloudInitSnippet: vi.fn(async () => 'local:snippets/proxmate-guest-agent.yaml'),
  startVm: vi.fn(async () => 'UPID:start'),
  shutdownVm: vi.fn(async () => 'UPID:shutdown'),
  stopVm: vi.fn(async () => 'UPID:stop'),
  getVmStatus: vi.fn(async () => ({ status: 'stopped' })),
  guestAgentPing: vi.fn(async () => true),
  guestExecOutput: vi.fn(async () => ({ exitcode: 0, stdout: '', stderr: '' })),
  deleteVmConfigKeys: vi.fn(async () => undefined),
}));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { addCloudImage } from '../src/services/template.service.js';

/**
 * B-41. The cloud-image importer downloaded an image, imported it as a disk and
 * converted it straight to a template — **without ever booting it**. There was no
 * point at which a package could be installed, so every template built through the UI
 * shipped without `qemu-guest-agent`.
 *
 * That is not cosmetic. ProxMate applies a cloud-init login password IN-GUEST through
 * the agent, never as `cipassword` (which would leave the crypt hash on the seed drive
 * and in /var/lib/cloud, both readable by the tenant for the life of the VM). A
 * template without the agent therefore cannot serve a password-only deploy at all.
 *
 * The build now boots the image once, lets cloud-init install the agent, and waits for
 * a ping as proof. The interesting half is the FAILURE POLICY: a cluster with no egress
 * cannot install anything on first boot, and that is exactly the deployment most likely
 * to need a working template. So the bake never fails the build — it records what
 * happened and the store shows it.
 */

const upsert = vi.mocked(prisma.template.upsert);
const ping = vi.mocked(pve.guestAgentPing);
const snippet = vi.mocked(pve.ensureCloudInitSnippet);
const exec = vi.mocked(pve.guestExecOutput);
const stop = vi.mocked(pve.stopVm);
const status = vi.mocked(pve.getVmStatus);
const convert = vi.mocked(pve.convertToTemplate);
const stripKeys = vi.mocked(pve.deleteVmConfigKeys);

const IMAGE = { name: 'debian-13', imageUrl: 'https://example.invalid/debian-13.qcow2', os: 'Debian 13' };

/** What the row would have been written with. */
const written = () => (upsert.mock.calls[0]![0] as { create: Record<string, unknown> }).create;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  snippet.mockResolvedValue('local:snippets/proxmate-guest-agent.yaml');
  ping.mockResolvedValue(true);
  exec.mockResolvedValue({ exitcode: 0, stdout: '', stderr: '' } as never);
  status.mockResolvedValue({ status: 'stopped' } as never);
  upsert.mockResolvedValue({ id: 't1' } as never);
});

/** addCloudImage polls on timers; drive them while it runs. */
async function build() {
  const p = addCloudImage(IMAGE);
  await vi.runAllTimersAsync();
  return p;
}

describe('a bake that works', () => {
  it('records guestAgent: true — the ping is the proof it installed AND runs', async () => {
    await build();
    expect(written()['guestAgent']).toBe(true);
  });

  it('wipes the cloud-init cache before the image becomes a template', async () => {
    // Without this the image carries THIS boot's cached user-data and instance state
    // into every clone ever made from it.
    await build();
    const cleaned = exec.mock.calls.find((c) => JSON.stringify(c[2]).includes('cloud-init'));
    expect(JSON.stringify(cleaned?.[2])).toContain('clean');
    expect(JSON.stringify(cleaned?.[2])).toContain('--seed');
    expect(exec.mock.invocationCallOrder[0]!).toBeLessThan(convert.mock.invocationCallOrder[0]!);
  });

  it('strips the bake-only config, and does so BEFORE converting', async () => {
    // convertToTemplate is irreversible — anything left on the VM is permanent.
    await build();
    expect(stripKeys).toHaveBeenCalledWith('pve-0', 9100, ['cicustom', 'ipconfig0'], expect.anything());
    expect(stripKeys.mock.invocationCallOrder[0]!).toBeLessThan(convert.mock.invocationCallOrder[0]!);
  });
});

describe('a bake that cannot work — the case the failure policy exists for', () => {
  it('still produces a template when the agent never answers, and records the failure', async () => {
    ping.mockResolvedValue(false); // no egress: cloud-init cannot install the package

    await build();

    expect(convert).toHaveBeenCalled(); // the build did NOT fail
    expect(written()['guestAgent']).toBe(false); // ...but the outcome is on the record
  });

  it('records unknown, not failure, when there is no snippet storage to bake with', async () => {
    snippet.mockResolvedValue(null);

    await build();

    expect(convert).toHaveBeenCalled();
    // null ≠ false: nothing was measured, so claiming the agent is absent would be a
    // lie that puts a scary badge on a template that may well be fine.
    expect(written()['guestAgent']).toBeNull();
    expect(pve.startVm).not.toHaveBeenCalled(); // and nothing was booted for no reason
  });

  it('survives the bake throwing outright', async () => {
    vi.mocked(pve.startVm).mockRejectedValueOnce(new Error('no such node'));

    await build();

    expect(convert).toHaveBeenCalled();
    expect(written()['guestAgent']).toBe(false);
  });

  it('force-stops a guest that ignores the clean shutdown', async () => {
    // A half-booted image that never gets an IP will not respond to ACPI either.
    ping.mockResolvedValue(false);
    status.mockResolvedValue({ status: 'running' } as never);

    await build();

    expect(stop).toHaveBeenCalled();
    expect(convert).toHaveBeenCalled();
  });
});
