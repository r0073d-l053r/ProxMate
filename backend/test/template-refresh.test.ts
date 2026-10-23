import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every Proxmox call the import pipeline makes, plus config + prisma, so the
// real refreshTemplate orchestration runs without network/DB.
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { template: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() } },
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn() }));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(async () => ({})),
  pickBestNode: vi.fn(async () => 'pve-0'),
  getImportStorages: vi.fn(async () => ['local']),
  getNextVmId: vi.fn(async () => 9100),
  downloadUrlToStorage: vi.fn(async () => 'UPID:dl'),
  createCloudInitVm: vi.fn(async () => 'UPID:create'),
  // The old template (9000) carries its template tag; the new build (9100) has none yet.
  getVmConfig: vi.fn(async (_node: string, vmid: number) =>
    vmid === 9000 ? { template: '1', tags: 'proxmate-template-t1' } : { scsi0: 'local:vm-9100-disk-0,size=8G' },
  ),
  primaryDiskSizeGb: vi.fn(() => 8),
  convertToTemplate: vi.fn(async () => undefined),
  deleteStorageVolume: vi.fn(async () => undefined),
  deleteVm: vi.fn(async () => 'UPID:del'),
  waitForTask: vi.fn(async () => undefined),
  pveMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  archFromImageUrl: vi.fn(() => 'amd64'),
  // No writable snippet storage in this fixture, so the guest-agent bake is skipped
  // (guestAgent stays null) and the build proceeds. Covered directly in
  // test/template-bake.test.ts.
  ensureCloudInitSnippet: vi.fn(async () => null),
  startVm: vi.fn(async () => 'UPID:start'),
  shutdownVm: vi.fn(async () => 'UPID:shutdown'),
  stopVm: vi.fn(async () => 'UPID:stop'),
  getVmStatus: vi.fn(async () => ({ status: 'stopped' })),
  guestAgentPing: vi.fn(async () => false),
  guestExecOutput: vi.fn(async () => ({ exitcode: 0, stdout: '', stderr: '' })),
  deleteVmConfigKeys: vi.fn(async () => undefined),
}));

import { prisma } from '../src/lib/prisma.js';
import { getConfig } from '../src/services/config.service.js';
import * as pve from '../src/services/proxmox.service.js';
import { refreshTemplate, addCloudImage } from '../src/services/template.service.js';
import { notify } from '../src/services/notify.service.js';

const findUnique = vi.mocked(prisma.template.findUnique);
const update = vi.mocked(prisma.template.update);
const deleteVm = vi.mocked(pve.deleteVm);
const defaultGetVmConfig = vi.mocked(pve.getVmConfig).getMockImplementation()!;

const cloudTpl = (over: Record<string, unknown> = {}) =>
  ({ id: 't1', name: 'Ubuntu 24.04', proxmoxVmId: 9000, proxmoxNode: 'pve-2', diskGb: 8, cloudInit: true, arch: 'amd64', sourceUrl: 'https://cloud.example/ubuntu.img', ...over }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pve.getVmConfig).mockImplementation(defaultGetVmConfig);
  vi.mocked(getConfig).mockImplementation(async (k: string) =>
    k === 'default_storage' ? 'ceph' : k === 'default_bridge' ? 'vmbr0' : k === 'iso_storage' ? 'local' : null,
  );
  update.mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 't1', ...args.data }) as never);
});

describe('refreshTemplate', () => {
  it('builds a new template VM, repoints the row, and deletes the old template', async () => {
    findUnique.mockResolvedValue(cloudTpl());

    await refreshTemplate('t1');

    // Row repointed at the new VMID with a refresh timestamp.
    const data = update.mock.calls[0]![0].data as { proxmoxVmId: number; proxmoxNode: string; refreshedAt: Date };
    expect(data.proxmoxVmId).toBe(9100);
    expect(data.proxmoxNode).toBe('pve-0');
    expect(data.refreshedAt).toBeInstanceOf(Date);

    // Old template VM (9000 on pve-2) removed — cloud images are full-cloned, so it's unreferenced.
    expect(deleteVm).toHaveBeenCalledWith('pve-2', 9000, expect.anything());
  });

  it('refuses a non-cloud-init template (no build)', async () => {
    findUnique.mockResolvedValue(cloudTpl({ cloudInit: false }));
    await expect(refreshTemplate('t1')).rejects.toThrow(/can be refreshed/i);
    expect(update).not.toHaveBeenCalled();
    expect(deleteVm).not.toHaveBeenCalled();
  });

  it('refuses a cloud template with no remembered source URL', async () => {
    findUnique.mockResolvedValue(cloudTpl({ sourceUrl: null }));
    await expect(refreshTemplate('t1')).rejects.toThrow(/can be refreshed/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('throws a clear error for an unknown template', async () => {
    findUnique.mockResolvedValue(null as never);
    await expect(refreshTemplate('nope')).rejects.toThrow(/not found/i);
  });
});

describe('refreshTemplate and the old template guest', () => {
  it('does not delete the old VMID when the guest there no longer carries this template\'s tag', async () => {
    findUnique.mockResolvedValue(cloudTpl());
    vi.mocked(pve.getVmConfig).mockImplementation(async (_node: string, vmid: number) =>
      vmid === 9000 ? { name: 'tenant-vm', tags: 'proxmate-rowb' } : { scsi0: 'local:vm-9100-disk-0,size=8G' },
    );
    await refreshTemplate('t1');
    expect(deleteVm).not.toHaveBeenCalledWith('pve-2', 9000, expect.anything());
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/9000/) }));
  });

  it('skips the delete quietly when the old guest is already gone', async () => {
    findUnique.mockResolvedValue(cloudTpl());
    vi.mocked(pve.getVmConfig).mockImplementation(async (_node: string, vmid: number) => {
      if (vmid === 9000) throw new Error('Configuration file does not exist');
      return { scsi0: 'local:vm-9100-disk-0,size=8G' };
    });
    await refreshTemplate('t1');
    expect(deleteVm).not.toHaveBeenCalledWith('pve-2', 9000, expect.anything());
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('cloud-image build VMID handling', () => {
  it('takes the VMID only after the image download finishes', async () => {
    findUnique.mockResolvedValue(cloudTpl());
    await refreshTemplate('t1');
    const dl = vi.mocked(pve.downloadUrlToStorage).mock.invocationCallOrder[0]!;
    const id = vi.mocked(pve.getNextVmId).mock.invocationCallOrder[0]!;
    expect(id).toBeGreaterThan(dl);
  });

  it('never deletes the VMID when its own create failed (the id may belong to another guest)', async () => {
    findUnique.mockResolvedValue(cloudTpl());
    vi.mocked(pve.createCloudInitVm).mockRejectedValueOnce(new Error('VM 9100 already exists'));
    await expect(refreshTemplate('t1')).rejects.toThrow(/already exists/);
    expect(deleteVm).not.toHaveBeenCalled();
  });

  it('cleans up its own half-built VM when a later step fails', async () => {
    findUnique.mockResolvedValue(cloudTpl());
    vi.mocked(pve.convertToTemplate).mockRejectedValueOnce(new Error('convert failed'));
    // The guest at the VMID carries the tag this build created it with.
    const tagged = () => (vi.mocked(pve.createCloudInitVm).mock.calls.at(-1)![0] as { tags: string }).tags;
    vi.mocked(pve.getVmConfig).mockImplementation(async () => ({ scsi0: 'local-lvm:vm-9100-disk-0,size=3G', tags: tagged() }));
    await expect(refreshTemplate('t1')).rejects.toThrow(/convert failed/);
    expect(tagged()).toMatch(/^proxmate-build-/);
    expect(deleteVm).toHaveBeenCalledWith('pve-0', 9100, expect.anything());
  });

  it('leaves a guest at the VMID alone unless it carries this build’s tag', async () => {
    findUnique.mockResolvedValue(cloudTpl());
    vi.mocked(pve.convertToTemplate).mockRejectedValueOnce(new Error('convert failed'));
    vi.mocked(pve.getVmConfig).mockImplementation(async () => ({ scsi0: 'local-lvm:vm-9100-disk-0,size=3G', tags: 'someone-else' }));
    await expect(refreshTemplate('t1')).rejects.toThrow(/convert failed/);
    expect(deleteVm).not.toHaveBeenCalled();
  });
});

describe('template ownership tag', () => {
  it('tags the rebuilt template guest as a template (never a machine)', async () => {
    findUnique.mockResolvedValue(cloudTpl());
    const put = vi.fn(async () => ({ data: { data: '' } }));
    vi.mocked(pve.getClient).mockResolvedValue({ put } as never);
    await refreshTemplate('t1');
    const call = (put.mock.calls as unknown as Array<[string, URLSearchParams]>).find((c) => c[0] === '/nodes/pve-0/qemu/9100/config');
    expect(call![1].get('tags')).toBe('proxmate-template-t1');
  });

  it('tags a newly built template guest when it is registered', async () => {
    vi.mocked(prisma.template.upsert).mockResolvedValue({ id: 'tnew', proxmoxVmId: 9100, proxmoxNode: 'pve-0' } as never);
    const put = vi.fn(async () => ({ data: { data: '' } }));
    vi.mocked(pve.getClient).mockResolvedValue({ put } as never);
    await addCloudImage({ name: 'Debian', imageUrl: 'https://cloud.example/debian.img' } as never);
    const call = (put.mock.calls as unknown as Array<[string, URLSearchParams]>).find((c) => c[0] === '/nodes/pve-0/qemu/9100/config');
    expect(call![1].get('tags')).toBe('proxmate-template-tnew');
  });
});
