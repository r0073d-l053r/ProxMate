import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every Proxmox call the import pipeline makes, plus config + prisma, so the
// real refreshTemplate orchestration runs without network/DB.
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { template: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn() }));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(async () => ({})),
  pickBestNode: vi.fn(async () => 'pve-0'),
  getImportStorages: vi.fn(async () => ['local']),
  getNextVmId: vi.fn(async () => 9100),
  downloadUrlToStorage: vi.fn(async () => 'UPID:dl'),
  createCloudInitVm: vi.fn(async () => 'UPID:create'),
  getVmConfig: vi.fn(async () => ({ scsi0: 'local:vm-9100-disk-0,size=8G' })),
  primaryDiskSizeGb: vi.fn(() => 8),
  convertToTemplate: vi.fn(async () => undefined),
  deleteStorageVolume: vi.fn(async () => undefined),
  deleteVm: vi.fn(async () => 'UPID:del'),
  waitForTask: vi.fn(async () => undefined),
  pveMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  archFromImageUrl: vi.fn(() => 'amd64'),
}));

import { prisma } from '../src/lib/prisma.js';
import { getConfig } from '../src/services/config.service.js';
import * as pve from '../src/services/proxmox.service.js';
import { refreshTemplate } from '../src/services/template.service.js';

const findUnique = vi.mocked(prisma.template.findUnique);
const update = vi.mocked(prisma.template.update);
const deleteVm = vi.mocked(pve.deleteVm);

const cloudTpl = (over: Record<string, unknown> = {}) =>
  ({ id: 't1', name: 'Ubuntu 24.04', proxmoxVmId: 9000, proxmoxNode: 'pve-2', diskGb: 8, cloudInit: true, arch: 'amd64', sourceUrl: 'https://cloud.example/ubuntu.img', ...over }) as never;

beforeEach(() => {
  vi.clearAllMocks();
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
