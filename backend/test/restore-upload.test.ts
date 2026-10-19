import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(),
  getBackupNodes: vi.fn(),
  extractBackupConfig: vi.fn(),
  pickBestNode: vi.fn(),
  getNextVmId: vi.fn(),
  restoreNewGuest: vi.fn(),
  waitForTask: vi.fn(),
  setVmName: vi.fn(),
  applyDefaultBridge: vi.fn(),
  configureVmIsolation: vi.fn(),
  readIsolationOptions: vi.fn(async () => ({ dnsServers: [] })),
  startVm: vi.fn(),
  deleteBackup: vi.fn(),
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn() }));
vi.mock('../src/services/download.service.js', () => ({ backupDir: vi.fn() }));
vi.mock('../src/services/matestate.service.js', () => ({ getBackupStorage: vi.fn() }));
vi.mock('../src/services/vm.service.js', () => ({
  assertWithinQuota: vi.fn(),
  acquireQuotaLock: vi.fn(async () => () => undefined),
  markClonedGuest: vi.fn(async () => undefined),
  settleFailedCreate: vi.fn(async () => undefined),
  syncRestoredGuest: vi.fn(async () => ({})),
}));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { getConfig } from '../src/services/config.service.js';
import { backupDir } from '../src/services/download.service.js';
import { getBackupStorage } from '../src/services/matestate.service.js';
import { assertWithinQuota, markClonedGuest, settleFailedCreate, syncRestoredGuest } from '../src/services/vm.service.js';
import {
  assertRestorableConfig,
  parseBackupConfig,
  restoreFromUpload,
  resolveUnderUploadDir,
  RestoreUploadError,
  VZDUMP_UPLOAD_RE,
  TEMP_UPLOAD_RE,
} from '../src/services/restore-upload.service.js';
import path from 'node:path';

const QEMU_CFG = `boot: order=scsi0
cores: 4
memory: 8192
name: web-01
net0: virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1
ide2: local:iso/debian.iso,media=cdrom
scsi0: local-lvm:vm-104-disk-0,size=32G
scsi1: local-lvm:vm-104-disk-1,size=512M
efidisk0: local-lvm:vm-104-disk-2,size=4M
[snap1]
scsi0: local-lvm:vm-104-disk-0,size=999G
`;

const LXC_CFG = `arch: amd64
unprivileged: 1
cores: 2
hostname: ct-1
memory: 1024
rootfs: local-lvm:vm-105-disk-0,size=8G
mp0: local-lvm:vm-105-disk-1,mp=/data,size=16G
`;

describe('parseBackupConfig', () => {
  it('reads cores/memory/name and sums disk sizes (skipping cdrom + snapshots)', () => {
    const cfg = parseBackupConfig(QEMU_CFG);
    expect(cfg.cores).toBe(4);
    expect(cfg.memoryMb).toBe(8192);
    expect(cfg.guestName).toBe('web-01');
    // 32G + 512M + 4M ≈ 32.5 GB → ceil 33; the [snap1] 999G disk must NOT count.
    expect(cfg.diskGb).toBe(33);
  });

  it('handles LXC configs (hostname, rootfs + mount points)', () => {
    const cfg = parseBackupConfig(LXC_CFG);
    expect(cfg.cores).toBe(2);
    expect(cfg.memoryMb).toBe(1024);
    expect(cfg.guestName).toBe('ct-1');
    expect(cfg.diskGb).toBe(24);
  });

  it('falls back to safe defaults on an empty config', () => {
    const cfg = parseBackupConfig('');
    expect(cfg).toEqual({ cores: 1, memoryMb: 512, diskGb: 0, guestName: null, unsizedDisk: false });
  });

  it('counts QEMU vCPUs as sockets x cores, or vcpus when set (BUG-028)', () => {
    expect(parseBackupConfig(`sockets: 4\n${QEMU_CFG}`).cores).toBe(16);
    expect(parseBackupConfig(`sockets: 4\nvcpus: 6\n${QEMU_CFG}`).cores).toBe(6);
  });

  it('reads memory written as a property string (BUG-028)', () => {
    expect(parseBackupConfig(QEMU_CFG.replace('memory: 8192', 'memory: current=65536')).memoryMb).toBe(65536);
  });

  it('flags a disk line with no size (BUG-028)', () => {
    expect(parseBackupConfig(`scsi2: local-lvm:vm-104-disk-5\n${QEMU_CFG}`).unsizedDisk).toBe(true);
    expect(parseBackupConfig(QEMU_CFG).unsizedDisk).toBe(false);
  });
});

describe('VZDUMP_UPLOAD_RE', () => {
  it('accepts real vzdump names and rejects anything path-like or foreign', () => {
    expect(VZDUMP_UPLOAD_RE.test('vzdump-qemu-104-2026_07_03-03_00_00.vma.zst')).toBe(true);
    expect(VZDUMP_UPLOAD_RE.test('vzdump-lxc-105-2026_07_03-03_00_00.tar.zst')).toBe(true);
    expect(VZDUMP_UPLOAD_RE.test('vzdump-qemu-104-2026.vma')).toBe(true);
    expect(VZDUMP_UPLOAD_RE.test('../etc/passwd')).toBe(false);
    expect(VZDUMP_UPLOAD_RE.test('backup.zip')).toBe(false);
    expect(VZDUMP_UPLOAD_RE.test('vzdump-qemu-104-x.vma.zst.exe')).toBe(false);
  });
});

describe('resolveUnderUploadDir (path-injection sanitizer)', () => {
  beforeEach(() => {
    vi.mocked(backupDir).mockReturnValue('/nonexistent-test-mount');
  });

  it('resolves a clean vzdump basename under the upload root', () => {
    const out = resolveUnderUploadDir('vzdump-qemu-104-2026_07_03-03_00_00.vma.zst', VZDUMP_UPLOAD_RE);
    expect(out).not.toBeNull();
    expect(path.basename(out!)).toBe('vzdump-qemu-104-2026_07_03-03_00_00.vma.zst');
    expect(out!.startsWith(path.resolve('/nonexistent-test-mount'))).toBe(true);
  });

  it('reduces path-like input to its basename — traversal segments never survive', () => {
    // The basename of a traversal path is not a valid vzdump name → null.
    expect(resolveUnderUploadDir('../../etc/passwd', VZDUMP_UPLOAD_RE)).toBeNull();
    expect(resolveUnderUploadDir('..\\..\\windows\\system32\\config', VZDUMP_UPLOAD_RE)).toBeNull();
    // A valid-looking name buried in a path resolves to just the basename (contained).
    const out = resolveUnderUploadDir('/tmp/elsewhere/vzdump-qemu-1-x.vma.zst', VZDUMP_UPLOAD_RE);
    expect(out).toBe(path.resolve('/nonexistent-test-mount', 'vzdump-qemu-1-x.vma.zst'));
  });

  it('rejects anything that fails the expected pattern', () => {
    expect(resolveUnderUploadDir('backup.zip', VZDUMP_UPLOAD_RE)).toBeNull();
    expect(resolveUnderUploadDir('.proxmate-upload-0123456789abcdef.part', VZDUMP_UPLOAD_RE)).toBeNull();
    expect(resolveUnderUploadDir('vzdump-qemu-1-x.vma.zst', TEMP_UPLOAD_RE)).toBeNull();
    expect(resolveUnderUploadDir('.proxmate-upload-0123456789abcdef.part', TEMP_UPLOAD_RE)).not.toBeNull();
  });

  it('returns null when the feature is disabled (no mount)', () => {
    vi.mocked(backupDir).mockReturnValue(null);
    expect(resolveUnderUploadDir('vzdump-qemu-1-x.vma.zst', VZDUMP_UPLOAD_RE)).toBeNull();
  });
});

describe('restoreFromUpload', () => {
  const user = { id: 'u1', role: 'user' } as never;
  const FILENAME = 'vzdump-qemu-104-2026_07_03-03_00_00.vma.zst';
  const VOLID = `backups:backup/${FILENAME}`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backupDir).mockReturnValue('/nonexistent-test-mount');
    vi.mocked(getBackupStorage).mockResolvedValue('backups');
    vi.mocked(pve.getClient).mockResolvedValue({} as never);
    vi.mocked(pve.getBackupNodes).mockResolvedValue(['pve-0']);
    vi.mocked(pve.extractBackupConfig).mockResolvedValue(QEMU_CFG);
    vi.mocked(assertWithinQuota).mockResolvedValue(undefined);
    vi.mocked(getConfig).mockImplementation(async (key: string) =>
      key === 'default_storage' ? 'local-lvm' : key === 'isolation_enabled' ? 'true' : '',
    );
    vi.mocked(pve.pickBestNode).mockResolvedValue('pve-0');
    vi.mocked(pve.getNextVmId).mockResolvedValue(200);
    vi.mocked(prisma.virtualMachine.create).mockResolvedValue({ id: 'vm1' } as never);
    vi.mocked(prisma.virtualMachine.update).mockResolvedValue({ id: 'vm1', status: 'running' } as never);
    vi.mocked(pve.restoreNewGuest).mockResolvedValue('UPID:1');
    vi.mocked(pve.waitForTask).mockResolvedValue(undefined as never);
    vi.mocked(pve.setVmName).mockResolvedValue(undefined);
    vi.mocked(pve.configureVmIsolation).mockResolvedValue(undefined);
    vi.mocked(pve.startVm).mockResolvedValue('UPID:2');
    vi.mocked(pve.deleteBackup).mockResolvedValue(undefined);
  });

  it('rejects path-like or non-vzdump filenames outright', async () => {
    await expect(restoreFromUpload(user, { filename: '../evil.vma.zst', name: 'x' })).rejects.toThrow(
      RestoreUploadError,
    );
    await expect(restoreFromUpload(user, { filename: 'notabackup.zip', name: 'x' })).rejects.toThrow(
      RestoreUploadError,
    );
    expect(pve.restoreNewGuest).not.toHaveBeenCalled();
  });

  it('restores with volume remap + fresh MACs, isolates BEFORE starting, then deletes the archive', async () => {
    const vm = await restoreFromUpload(user, { filename: FILENAME, name: 'migrated-web' });

    expect(vm).toEqual({ id: 'vm1', status: 'running' });
    // Quota was checked from the archive's embedded config.
    expect(assertWithinQuota).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ cpu: 4, ram: 8192, storage: 33 }),
    );
    // Restore remaps volumes to the default pool, as a new (unique) guest.
    expect(pve.restoreNewGuest).toHaveBeenCalledWith(
      { node: 'pve-0', vmid: 200, volid: VOLID, storage: 'local-lvm' },
      expect.anything(),
      'qemu',
    );
    // B-37: the archive carries the OLD guest's bridge, which may not exist on this
    // cluster at all. `storage` above remaps the volumes; this is the network half.
    expect(pve.applyDefaultBridge).toHaveBeenCalledWith('pve-0', 200, expect.anything(), 'qemu');
    // The tenant-isolation invariant: firewall configured before first boot.
    const isolationOrder = vi.mocked(pve.configureVmIsolation).mock.invocationCallOrder[0]!;
    const startOrder = vi.mocked(pve.startVm).mock.invocationCallOrder[0]!;
    expect(isolationOrder).toBeLessThan(startOrder);
    // ...and placement before policy: the rules are written on the final bridge.
    expect(vi.mocked(pve.applyDefaultBridge).mock.invocationCallOrder[0]!).toBeLessThan(isolationOrder);
    // The uploaded archive is a transient carrier — removed after success.
    expect(pve.deleteBackup).toHaveBeenCalledWith('pve-0', 'backups', VOLID);
  });

  it('derives LXC restores from the filename', async () => {
    vi.mocked(pve.extractBackupConfig).mockResolvedValue(LXC_CFG);
    const lxcFile = 'vzdump-lxc-105-2026_07_03-03_00_00.tar.zst';
    await restoreFromUpload(user, { filename: lxcFile, name: 'migrated-ct' });
    expect(pve.restoreNewGuest).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'lxc');
  });

  it('cleans up the archive and never restores when quota is exceeded', async () => {
    vi.mocked(assertWithinQuota).mockRejectedValue(new Error('Quota exceeded'));
    await expect(restoreFromUpload(user, { filename: FILENAME, name: 'too-big' })).rejects.toThrow(
      'Quota exceeded',
    );
    expect(pve.restoreNewGuest).not.toHaveBeenCalled();
    expect(prisma.virtualMachine.create).not.toHaveBeenCalled();
    expect(pve.deleteBackup).toHaveBeenCalledWith('pve-0', 'backups', VOLID);
  });

  it('fails clearly when Proxmox cannot see the uploaded file', async () => {
    vi.mocked(pve.getBackupNodes).mockResolvedValue([]);
    await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(
      /isn't visible/,
    );
    expect(pve.restoreNewGuest).not.toHaveBeenCalled();
  });

  it('settles a failed restore task as "no guest created" (the row is then dropped or kept by identity)', async () => {
    const err = new Error('restore failed on node');
    vi.mocked(pve.waitForTask).mockRejectedValue(err);
    await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(
      'restore failed on node',
    );
    expect(settleFailedCreate).toHaveBeenCalledWith({ id: 'vm1' }, err, false);
  });

  it('settles a failure after the restore landed as "guest created", and tags the guest first', async () => {
    const err = new Error('start failed');
    vi.mocked(pve.startVm).mockRejectedValue(err);
    await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow('start failed');
    expect(markClonedGuest).toHaveBeenCalledWith({ id: 'vm1' }, expect.anything());
    expect(settleFailedCreate).toHaveBeenCalledWith({ id: 'vm1' }, err, true);
  });

  it('never restores an archive carrying a host device, and drops it (BUG-027)', async () => {
    vi.mocked(pve.extractBackupConfig).mockResolvedValue(`hostpci0: mapping=gpu0\n${QEMU_CFG}`);
    await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(RestoreUploadError);
    expect(pve.restoreNewGuest).not.toHaveBeenCalled();
    expect(pve.deleteBackup).toHaveBeenCalledWith('pve-0', 'backups', VOLID);
  });

  it('refuses an archive with an unsized disk, and charges sockets x cores (BUG-028)', async () => {
    vi.mocked(pve.extractBackupConfig).mockResolvedValue(`scsi2: local-lvm:vm-104-disk-5\n${QEMU_CFG}`);
    await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/no size/);
    expect(pve.restoreNewGuest).not.toHaveBeenCalled();

    vi.mocked(pve.extractBackupConfig).mockResolvedValue(`sockets: 2\n${QEMU_CFG}`);
    await restoreFromUpload(user, { filename: FILENAME, name: 'x' });
    expect(assertWithinQuota).toHaveBeenLastCalledWith(user, expect.objectContaining({ cpu: 8 }));
    expect(prisma.virtualMachine.create).toHaveBeenCalledWith({ data: expect.objectContaining({ cpu: 8 }) });
  });

  it('re-reads the restored guest (no PCI device approved) before it is started (BUG-027)', async () => {
    await restoreFromUpload(user, { filename: FILENAME, name: 'x' });
    expect(syncRestoredGuest).toHaveBeenCalledWith({ id: 'vm1' }, { approvedPci: [], client: expect.anything() });
    expect(vi.mocked(syncRestoredGuest).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(pve.startVm).mock.invocationCallOrder[0]!,
    );
  });
});

describe('archive config keys an upload may not carry (BUG-027)', () => {
  it('refuses host devices, host paths, raw arguments, hook scripts and raw LXC keys', () => {
    const live = QEMU_CFG.split('[')[0];
    for (const extra of [
      'hostpci0: mapping=gpu0',
      'usb0: host=1234:5678',
      'serial0: /dev/ttyS0',
      'args: -device foo',
      'hookscript: local:snippets/x.sh',
    ]) {
      expect(() => assertRestorableConfig(`${live}${extra}\n`, 'qemu'), extra).toThrow(RestoreUploadError);
    }
    for (const extra of ['mp1: /srv/host,mp=/host', 'lxc.apparmor.profile: unconfined', 'dev0: /dev/kvm']) {
      expect(() => assertRestorableConfig(`${LXC_CFG}${extra}\n`, 'lxc'), extra).toThrow(RestoreUploadError);
    }
  });

  it('refuses a privileged container', () => {
    expect(() => assertRestorableConfig(LXC_CFG.replace('unprivileged: 1\n', ''), 'lxc')).toThrow(/privileged/);
  });

  it('accepts an ordinary guest (a serial socket console is fine)', () => {
    expect(() => assertRestorableConfig(`serial0: socket\n${QEMU_CFG}`, 'qemu')).not.toThrow();
    expect(() => assertRestorableConfig(LXC_CFG, 'lxc')).not.toThrow();
  });
});
