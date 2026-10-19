import { describe, it, expect, vi, beforeEach } from 'vitest';

// createMateState: the backup a run records must be the one its own vzdump task
// wrote, and a run that gives up waiting must not leave an unrecorded archive.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), update: vi.fn() },
    mateState: {
      create: vi.fn(async () => ({ id: 'ms1' })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'ms1', ...data })),
      findMany: vi.fn(async () => []),
      delete: vi.fn(),
    },
  },
}));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (key: string) => ({ backup_storage: 'backups' })[key] ?? null),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn(), waitForTask: vi.fn(actual.waitForTask) };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { guestMarker } from '../src/services/vm.service.js';
import { createMateState } from '../src/services/matestate.service.js';
import { fakeClient, asClient } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const OURS = 'backups:backup/vzdump-qemu-100-2026_10_19-03_00_05.vma.zst';

const row = { id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1', backupKeep: null } as never;

/** A fake PVE: guest 100 on pve1; `afterBackup` is the backup listing once vzdump ran. */
function fakePve(afterBackup: Array<{ volid: string; vmid: number }>) {
  const c = fakeClient();
  let ran = false;
  c.get.mockImplementation((url: string) => {
    if (url.startsWith('/cluster/resources')) return ok([{ type: 'qemu', vmid: 100, node: 'pve1' }, { type: 'node', node: 'pve1', status: 'online' }]);
    if (/\/qemu\/100\/config$/.test(url)) return ok({ name: 'web', tags: guestMarker('rowa') });
    if (url === '/nodes') return ok([{ node: 'pve1', status: 'online' }]);
    if (url.startsWith('/nodes/pve1/storage/backups/content')) return ok(ran ? afterBackup.map((b) => ({ ...b, size: 10, ctime: 1 })) : []);
    if (/\/tasks\/.*\/log$/.test(url)) {
      return ok([
        { n: 1, t: 'INFO: starting new backup job: vzdump 100 --storage backups --mode snapshot' },
        { n: 2, t: "INFO: creating vzdump archive '/mnt/pve/backups/dump/vzdump-qemu-100-2026_10_19-03_00_05.vma.zst'" },
      ]);
    }
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    return ok(null);
  });
  c.post.mockImplementation((url: string) => {
    if (url === '/nodes/pve1/vzdump') ran = true;
    return ok('UPID:pve1:backup');
  });
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a backup that outlives the wait (BUG-025)', () => {
  it('stops the vzdump task and removes the archive it wrote, so nothing unrecorded is left behind', async () => {
    const c = fakePve([{ volid: OURS, vmid: 100 }]);
    vi.mocked(pve.waitForTask).mockRejectedValueOnce(new Error('Proxmox task timed out'));

    await expect(createMateState(row)).rejects.toThrow(/timed out/);
    expect(c.delete).toHaveBeenCalledWith(`/nodes/pve1/tasks/${encodeURIComponent('UPID:pve1:backup')}`);
    expect(c.delete).toHaveBeenCalledWith(`/nodes/pve1/storage/backups/content/${encodeURIComponent(OURS)}`);
    expect(prisma.mateState.update).toHaveBeenCalledWith({ where: { id: 'ms1' }, data: { status: 'error' } });
  });

  it('never deletes a logged archive that is listed under another VMID (audit minor)', async () => {
    const c = fakePve([{ volid: OURS, vmid: 999 }]);
    vi.mocked(pve.waitForTask).mockRejectedValueOnce(new Error('Proxmox task timed out'));
    await expect(createMateState(row)).rejects.toThrow(/timed out/);
    expect(c.delete).not.toHaveBeenCalledWith(`/nodes/pve1/storage/backups/content/${encodeURIComponent(OURS)}`);
  });

  it('a finished backup whose volume could not be identified removes the archive its log names (audit minor)', async () => {
    const c = fakePve([{ volid: OURS, vmid: 100 }]);
    // The storage listing lags: the archive shows up only after the identification step.
    const get = c.get.getMockImplementation()!;
    let listings = 0;
    c.get.mockImplementation((url: string) => {
      if (url.startsWith('/nodes/pve1/storage/backups/content')) {
        listings++;
        return listings <= 2 ? ok([]) : get(url);
      }
      return get(url);
    });
    await expect(createMateState(row)).rejects.toThrow(/could not be identified/);
    expect(c.delete).toHaveBeenCalledWith(`/nodes/pve1/storage/backups/content/${encodeURIComponent(OURS)}`);
  });

  it('does not stop the task on other failures', async () => {
    const c = fakePve([{ volid: OURS, vmid: 100 }]);
    vi.mocked(pve.waitForTask).mockRejectedValueOnce(new Error('Proxmox task failed: job errors'));
    await expect(createMateState(row)).rejects.toThrow(/job errors/);
    expect(c.delete).not.toHaveBeenCalled();
  });
});

describe('which volume a backup records (BUG-026)', () => {
  const FOREIGN = 'backups:backup/vzdump-qemu-100-2000_01_01-00_00_00.vma.zst';

  it('records the archive its own vzdump task wrote, not another file for the same VMID that appeared meanwhile', async () => {
    // The foreign file sorts first in the listing.
    fakePve([{ volid: FOREIGN, vmid: 100 }, { volid: OURS, vmid: 100 }]);
    const ms = await createMateState(row);
    expect(ms.volid).toBe(OURS);
  });

  it('refuses to guess when the log names nothing and more than one new volume appeared', async () => {
    const c = fakePve([{ volid: FOREIGN, vmid: 100 }, { volid: OURS, vmid: 100 }]);
    const get = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) => (/\/tasks\/.*\/log$/.test(url) ? ok([]) : get(url)));
    await expect(createMateState(row)).rejects.toThrow(/could not be identified/);
    expect(prisma.mateState.update).toHaveBeenCalledWith({ where: { id: 'ms1' }, data: { status: 'error' } });
  });
});

describe('backups of a guest that may carry someone else\'s data (audit round 3)', () => {
  it('are refused for a row held for foreign volumes or unfinished provisioning', async () => {
    const { FOREIGN_VOLUME_MESSAGE, PROVISION_FAILED_MESSAGE } = await import('../src/services/vm.service.js');
    for (const holdReason of [FOREIGN_VOLUME_MESSAGE, PROVISION_FAILED_MESSAGE]) {
      const c = fakePve([{ volid: OURS, vmid: 100 }]);
      await expect(createMateState({ ...(row as object), status: 'error', holdReason } as never)).rejects.toThrow();
      expect(c.post.mock.calls.some((x) => x[0] === '/nodes/pve1/vzdump')).toBe(false);
    }
  });

  it('are refused when the live config references another guest\'s volume', async () => {
    const c = fakePve([{ volid: OURS, vmid: 100 }]);
    const get = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) =>
      /\/qemu\/100\/config$/.test(url)
        ? ok({ name: 'web', tags: guestMarker('rowa'), scsi1: 'local-lvm:vm-200-disk-0,size=10G' })
        : get(url),
    );
    await expect(createMateState(row)).rejects.toThrow(/aren't its own/);
    expect(c.post.mock.calls.some((x) => x[0] === '/nodes/pve1/vzdump')).toBe(false);
  });
});

describe('backupVolidFromLog', () => {
  it('maps a directory-storage archive path to its volid', () => {
    expect(
      pve.backupVolidFromLog(["INFO: creating vzdump archive '/var/lib/vz/dump/vzdump-lxc-101-2026_10_19-03_00_00.tar.zst'"], 'local'),
    ).toBe('local:backup/vzdump-lxc-101-2026_10_19-03_00_00.tar.zst');
  });

  it('maps a Proxmox Backup Server archive to its volid', () => {
    expect(
      pve.backupVolidFromLog(["INFO: creating Proxmox Backup Server archive 'vm/100/2026-10-19T03:00:00Z'"], 'pbs'),
    ).toBe('pbs:backup/vm/100/2026-10-19T03:00:00Z');
  });

  it('is null when the log names no archive', () => {
    expect(pve.backupVolidFromLog(['INFO: nothing here'], 'local')).toBeNull();
  });
});
