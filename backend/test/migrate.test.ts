import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import {
  migrateVm,
  getNodeImagesStorages,
  getVolumeStorages,
  passthroughBootReadiness,
} from '../src/services/proxmox.service.js';
import { fakeClient, asClient, bodyOf, GB } from './helpers.js';

describe('migrateVm', () => {
  it('sets online + with-local-disks for a live migration (works on local storage too)', async () => {
    const c = fakeClient();
    const upid = await migrateVm('pve-0', 100, 'pve-1', true, asClient(c));
    expect(upid).toBe('UPID:fake');
    expect(c.post).toHaveBeenCalledWith('/nodes/pve-0/qemu/100/migrate', expect.anything());
    const body = bodyOf(c.post.mock.calls[0]!);
    expect(body).toMatchObject({ target: 'pve-1', online: '1', 'with-local-disks': '1' });
  });

  it('omits online/with-local-disks for an offline (stopped) migration', async () => {
    const c = fakeClient();
    await migrateVm('pve-0', 100, 'pve-1', false, asClient(c));
    const body = bodyOf(c.post.mock.calls[0]!);
    expect(body['target']).toBe('pve-1');
    expect(body['online']).toBeUndefined();
    expect(body['with-local-disks']).toBeUndefined();
    expect(body['targetstorage']).toBeUndefined();
  });

  it('passes targetstorage on an offline migration (disk relocation)', async () => {
    const c = fakeClient();
    await migrateVm('pve-0', 100, 'pve-4', false, asClient(c), { targetstorage: 'local-zfs' });
    const body = bodyOf(c.post.mock.calls[0]!);
    expect(body).toMatchObject({ target: 'pve-4', targetstorage: 'local-zfs' });
    expect(body['online']).toBeUndefined();
  });

  it('passes targetstorage alongside with-local-disks on a live migration (NBD mirror works across storage types)', async () => {
    const c = fakeClient();
    await migrateVm('pve-0', 100, 'pve-4', true, asClient(c), { targetstorage: 'tank-files' });
    const body = bodyOf(c.post.mock.calls[0]!);
    expect(body).toMatchObject({ online: '1', 'with-local-disks': '1', targetstorage: 'tank-files' });
  });
});

describe('getNodeImagesStorages', () => {
  it('queries the node for enabled images storages and skips inactive ones', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          { storage: 'local-zfs', type: 'zfspool', shared: 0, active: 1, avail: 200 * GB },
          { storage: 'ceph', type: 'rbd', shared: 1, active: 1, avail: 900 * GB },
          { storage: 'broken', type: 'dir', shared: 0, active: 0, avail: 10 * GB },
        ],
      },
    });
    const out = await getNodeImagesStorages('pve-4', asClient(c));
    expect(c.get).toHaveBeenCalledWith('/nodes/pve-4/storage', { params: { enabled: 1, content: 'images' } });
    expect(out.map((s) => s.storage)).toEqual(['local-zfs', 'ceph']);
    expect(out[1]).toMatchObject({ shared: true, availBytes: 900 * GB });
  });
});

describe('getVolumeStorages', () => {
  it('collects storages from disk/EFI/TPM volumes and skips ISO cdroms + empty drives', () => {
    expect(
      getVolumeStorages({
        scsi0: 'tank:vm-108-disk-0,size=32G',
        scsi1: 'local-zfs:vm-108-disk-1,size=10G',
        efidisk0: 'tank:vm-108-disk-2,efitype=4m',
        tpmstate0: 'tank:vm-108-disk-3,version=v2.0',
        ide2: 'local:iso/debian.iso,media=cdrom',
        ide0: 'none',
        net0: 'virtio=AA:BB,bridge=vmbr0',
      }).sort(),
    ).toEqual(['local-zfs', 'tank']);
  });

  it('includes generated cloud-init drives — they migrate as volumes despite media=cdrom', () => {
    expect(
      getVolumeStorages({
        scsi0: 'ceph:vm-9-disk-0,size=32G',
        ide2: 'tank:vm-9-cloudinit,media=cdrom,size=4M',
      }).sort(),
    ).toEqual(['ceph', 'tank']);
  });
});

describe('passthroughBootReadiness', () => {
  it('is clean on q35 + OVMF + EFI disk', () => {
    const r = passthroughBootReadiness({ machine: 'q35', bios: 'ovmf', efidisk0: 'tank:vm-1,efitype=4m' });
    expect(r).toMatchObject({ q35: true, ovmf: true, efidisk: true, warnings: [] });
  });

  it('warns (never blocks) on i440fx/SeaBIOS guests', () => {
    const r = passthroughBootReadiness({});
    expect(r.q35).toBe(false);
    expect(r.ovmf).toBe(false);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
    expect(r.warnings.join(' ')).toMatch(/q35/);
    expect(r.warnings.join(' ')).toMatch(/OVMF/);
  });

  it('warns when OVMF is set but the EFI disk is missing', () => {
    const r = passthroughBootReadiness({ machine: 'pc-q35-8.1', bios: 'ovmf' });
    expect(r.q35).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/efidisk0/i);
  });
});
