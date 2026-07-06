import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import {
  migrateVm,
  getNodeImagesStorages,
  getVolumeStorages,
  passthroughBootReadiness,
  parseMigrationProgress,
  getMigrationProgress,
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

describe('parseMigrationProgress', () => {
  it('parses a single-disk mirror line into percent/bytes/ETA', () => {
    const p = parseMigrationProgress(['mirror-scsi0: transferred 128.0 MiB of 512.0 GiB (0.02%) in 10s']);
    expect(p).not.toBeNull();
    expect(p!.transferredBytes).toBe(128 * 1024 ** 2);
    expect(p!.totalBytes).toBe(512 * GB);
    expect(p!.elapsedSeconds).toBe(10);
    // percent this low needs no ETA yet (avoids a wild estimate off one sample).
    expect(p!.etaSeconds).toBeNull();
  });

  it('projects an ETA once there is enough progress to extrapolate from', () => {
    const p = parseMigrationProgress(['mirror-scsi0: transferred 10.0 GiB of 20.0 GiB (50.00%) in 1m 40s']);
    expect(p!.percent).toBe(50);
    expect(p!.elapsedSeconds).toBe(100);
    // Half done in 100s -> ~100s remaining.
    expect(p!.etaSeconds).toBe(100);
  });

  it('aggregates multiple disks transferring in parallel (sum bytes, max elapsed)', () => {
    const p = parseMigrationProgress([
      'mirror-scsi0: transferred 2.0 GiB of 8.0 GiB (25.00%) in 20s',
      'mirror-scsi1: transferred 1.0 GiB of 2.0 GiB (50.00%) in 30s',
    ]);
    expect(p!.transferredBytes).toBe(3 * GB);
    expect(p!.totalBytes).toBe(10 * GB);
    expect(p!.percent).toBe(30); // 3 of 10 GiB
    expect(p!.elapsedSeconds).toBe(30); // the slower/later-reporting disk
  });

  it('keeps only the LATEST line per drive — a later update supersedes an earlier one', () => {
    const p = parseMigrationProgress([
      'mirror-scsi0: transferred 1.0 GiB of 8.0 GiB (12.50%) in 5s',
      'mirror-scsi0: transferred 4.0 GiB of 8.0 GiB (50.00%) in 20s',
    ]);
    expect(p!.transferredBytes).toBe(4 * GB);
    expect(p!.percent).toBe(50);
    expect(p!.elapsedSeconds).toBe(20);
  });

  it('strips a leading log timestamp before matching', () => {
    const p = parseMigrationProgress(['2026-07-06 10:00:00 mirror-scsi0: transferred 1.0 GiB of 4.0 GiB (25.00%) in 10s']);
    expect(p).not.toBeNull();
    expect(p!.percent).toBe(25);
  });

  it('ignores unrelated log lines and returns null when nothing matches', () => {
    expect(
      parseMigrationProgress([
        'starting migration of VM 108 to node \'pve-4\' (192.168.50.249)',
        'found local disk \'tank:vm-108-disk-0\' (attached)',
        'copying local disk images',
      ]),
    ).toBeNull();
    expect(parseMigrationProgress([])).toBeNull();
  });
});

describe('getMigrationProgress', () => {
  it('returns null when no qmigrate task is active for this VM', async () => {
    const c = fakeClient();
    c.get.mockResolvedValueOnce({ data: { data: [] } }); // /cluster/tasks
    expect(await getMigrationProgress(108, asClient(c))).toBeNull();
    expect(c.get).toHaveBeenCalledWith('/cluster/tasks');
    expect(c.get).toHaveBeenCalledTimes(1); // never fetches a log with no active task
  });

  it('ignores tasks for other VMs, other types, or already finished', async () => {
    const c = fakeClient();
    c.get.mockResolvedValueOnce({
      data: {
        data: [
          { id: '999', type: 'qmigrate', node: 'pve', upid: 'UPID:other-vm', endtime: undefined },
          { id: '108', type: 'vzdump', node: 'pve', upid: 'UPID:backup', endtime: undefined },
          { id: '108', type: 'qmigrate', node: 'pve', upid: 'UPID:done', endtime: 12345 },
        ],
      },
    });
    expect(await getMigrationProgress(108, asClient(c))).toBeNull();
  });

  it('fetches the active task log and returns its parsed progress', async () => {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/cluster/tasks') {
        return Promise.resolve({
          data: { data: [{ id: '108', type: 'qmigrate', node: 'pve', upid: 'UPID:pve:migrate108:', endtime: undefined }] },
        });
      }
      if (url === '/nodes/pve/tasks/UPID%3Apve%3Amigrate108%3A/log') {
        return Promise.resolve({
          data: { data: [{ t: 'mirror-scsi0: transferred 6.0 GiB of 8.0 GiB (75.00%) in 1m 0s' }] },
        });
      }
      throw new Error(`unexpected GET ${url}`);
    });
    const p = await getMigrationProgress(108, asClient(c));
    expect(p).toMatchObject({ percent: 75, totalBytes: 8 * GB });
    // limit: 0 = Proxmox's "no limit" — start/limit page from the oldest line,
    // so a small limit would keep re-reading stale history on a long migration.
    expect(c.get).toHaveBeenCalledWith('/nodes/pve/tasks/UPID%3Apve%3Amigrate108%3A/log', { params: { limit: 0 } });
  });

  it('returns a zeroed placeholder when the task is active but has not logged progress yet', async () => {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/cluster/tasks') {
        return Promise.resolve({ data: { data: [{ id: '108', type: 'qmigrate', node: 'pve', upid: 'UPID:x', endtime: undefined }] } });
      }
      return Promise.resolve({ data: { data: [{ t: 'starting migration of VM 108 to node \'pve-4\'' }] } });
    });
    const p = await getMigrationProgress(108, asClient(c));
    expect(p).toEqual({ percent: 0, transferredBytes: 0, totalBytes: 0, elapsedSeconds: 0, etaSeconds: null });
  });

  it('requests the whole log (limit: 0) so a long migration is never stuck reading its oldest lines', async () => {
    // Regression test: Proxmox's start/limit paginate from the OLDEST line
    // (there's no "last N lines" mode, and no total-count to page back from),
    // so a fixed small limit would keep returning the same early lines forever
    // once a migration outlives it — observed live on a 512 GB transfer whose
    // log grew past 200 lines. Simulate that: 500 old lines, then the real
    // latest one at the end.
    const c = fakeClient();
    const oldLines = Array.from({ length: 500 }, (_, i) => `mirror-scsi0: transferred ${i}.0 MiB of 512.0 GiB (0.0${i}%) in ${i}s`);
    c.get.mockImplementation((url: string) => {
      if (url === '/cluster/tasks') {
        return Promise.resolve({ data: { data: [{ id: '108', type: 'qmigrate', node: 'pve', upid: 'UPID:pve:x:', endtime: undefined }] } });
      }
      return Promise.resolve({
        data: { data: [...oldLines, { t: 'mirror-scsi0: transferred 37.6 GiB of 512.0 GiB (7.34%) in 8m 11s' }].map((t) => (typeof t === 'string' ? { t } : t)) },
      });
    });
    const p = await getMigrationProgress(108, asClient(c));
    expect(p!.percent).toBe(7.3); // matches the LATEST line, not an early one from the log's start
    expect(c.get).toHaveBeenLastCalledWith(expect.stringContaining('/log'), { params: { limit: 0 } });
  });
});
