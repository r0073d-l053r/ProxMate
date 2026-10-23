import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { create: vi.fn(), update: vi.fn(), count: vi.fn(), findMany: vi.fn(async () => []) },
  },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getGuestPool: vi.fn(async () => undefined),
  getClient: vi.fn(),
  getBackupNodes: vi.fn(),
  storagePlacement: vi.fn(),
  extractBackupConfig: vi.fn(),
  pickBestNode: vi.fn(),
  getNextVmId: vi.fn(),
  restoreNewGuest: vi.fn(),
  waitForTask: vi.fn(),
  setVmName: vi.fn(),
  applyDefaultBridge: vi.fn(),
  getVmConfig: vi.fn(),
  listGuestVolumes: vi.fn(async () => new Set(['local-lvm:vm-200-disk-0'])),
  snippetWriteConfig: vi.fn(() => ({ dir: '/snip', storage: 'shared-snip' })),
  configureVmIsolation: vi.fn(),
  readIsolationOptions: vi.fn(async () => ({ dnsServers: [] })),
  startVm: vi.fn(),
  deleteBackup: vi.fn(),
  deleteVm: vi.fn(async () => 'UPID:del'),
  resetRestoredFirewall: vi.fn(async () => undefined),
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn() }));
vi.mock('../src/services/download.service.js', () => ({ backupDir: vi.fn() }));
vi.mock('../src/services/matestate.service.js', () => ({ getBackupStorage: vi.fn() }));
vi.mock('../src/services/vm.service.js', () => ({
  assertWithinQuota: vi.fn(),
  acquireQuotaLock: vi.fn(async () => () => undefined),
  markClonedGuest: vi.fn(async () => undefined),
  settleFailedCreate: vi.fn(async () => ({ following: false })),
  syncRestoredGuest: vi.fn(async () => ({})),
  assertOwnVolumes: vi.fn(async () => undefined),
  recordOpTask: vi.fn(async () => undefined),
  OP_SETTLED: { opKind: null, opStartedAt: null, opUpid: null },
  // No reservations held: the next VMID is whatever Proxmox hands out.
  nextVmId: vi.fn(async (client: unknown) => (await import('../src/services/proxmox.service.js')).getNextVmId(client as never)),
  reserveVmIds: vi.fn(),
  releaseVmId: vi.fn(),
}));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { getConfig } from '../src/services/config.service.js';
import { backupDir } from '../src/services/download.service.js';
import { getBackupStorage } from '../src/services/matestate.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';
import {
  assertWithinQuota,
  markClonedGuest,
  settleFailedCreate,
  syncRestoredGuest,
  reserveVmIds,
  releaseVmId,
} from '../src/services/vm.service.js';
import { buildVma } from './vzdump-fixtures.js';
import {
  assertRestorableConfig,
  ownCicustom,
  parseBackupConfig,
  restoreFromUpload,
  neutraliseRestoredGuest,
  renameArchiveForVmid,
  cleanupUploadedArchive,
  promoteUpload,
  resolveUnderUploadDir,
  sweepStaleUploads,
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

  let client: ReturnType<typeof fakeClient>;
  /** What Proxmox reports for the restored guest (read back before it is used). */
  let restored: { config: Record<string, unknown>; pending: unknown[]; snapshots: unknown[] };
  beforeEach(() => {
    vi.clearAllMocks();
    client = fakeClient();
    restored = { config: {}, pending: [], snapshots: [{ name: 'current' }] };
    client.get.mockImplementation((url: string) => {
      const ok = (data: unknown) => Promise.resolve({ data: { data } });
      if (url.endsWith('/config')) {
        const lxc = url.includes('/lxc/');
        return ok({
          ...(lxc
            ? { arch: 'amd64', hostname: 'ct-1', unprivileged: 1, rootfs: 'local-lvm:vm-200-disk-0,size=8G' }
            : { name: 'web-01', cores: 4, scsi0: 'local-lvm:vm-200-disk-0,size=32G' }),
          ...restored.config,
        });
      }
      if (url.endsWith('/pending')) return ok(restored.pending);
      if (url.endsWith('/snapshot')) return ok(restored.snapshots);
      return ok(null);
    });
    vi.mocked(backupDir).mockReturnValue('/nonexistent-test-mount');
    vi.mocked(getBackupStorage).mockResolvedValue('backups');
    vi.mocked(pve.getClient).mockResolvedValue(asClient(client));
    vi.mocked(pve.getVmConfig).mockResolvedValue({
      name: 'web-01',
      onboot: '1',
      cicustom: 'vendor=local:snippets/not-ours.yaml',
      net0: 'e1000=AA:BB:CC:DD:EE:FF,bridge=vmbr9,firewall=0,trunks=1-4094,rate=5',
      net1: 'bogus=11:22:33:44:55:66,bridge=vmbr9',
    });
    vi.mocked(pve.readIsolationOptions).mockResolvedValue({ dnsServers: [], vlanTag: 42 });
    vi.mocked(pve.getBackupNodes).mockResolvedValue(['pve-0']);
    vi.mocked(pve.extractBackupConfig).mockResolvedValue(QEMU_CFG);
    vi.mocked(assertWithinQuota).mockResolvedValue(undefined);
    vi.mocked(getConfig).mockImplementation(async (key: string) =>
      key === 'default_storage' ? 'local-lvm' : key === 'isolation_enabled' ? 'true' : key === 'default_bridge' ? 'vmbr0' : '',
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
    // The archive's NICs are rebuilt from scratch (audit minor): model kept (unknown
    // models become virtio), no MAC (Proxmox generates a fresh one), the default
    // bridge, the isolation VLAN and the firewall flag — nothing else from the archive.
    // Protection/autostart go first — before the volume check (audit round 3).
    const stripIdx = client.put.mock.calls.findIndex((x) => bodyOf(x)['delete'] === 'onboot' && !bodyOf(x)['net0']);
    expect(stripIdx).toBeGreaterThanOrEqual(0);
    const { assertOwnVolumes } = await import('../src/services/vm.service.js');
    expect(client.put.mock.invocationCallOrder[stripIdx]!).toBeLessThan(vi.mocked(assertOwnVolumes).mock.invocationCallOrder[0]!);
    const nicPut = client.put.mock.calls.find((x) => String(x[0]) === '/nodes/pve-0/qemu/200/config' && bodyOf(x)['net0']);
    expect(bodyOf(nicPut!)).toEqual({
      net0: 'e1000,bridge=vmbr0,firewall=1,tag=42',
      net1: 'virtio,bridge=vmbr0,firewall=1,tag=42',
      delete: 'onboot,cicustom',
    });
    // The tenant-isolation invariant: firewall configured before first boot.
    const isolationOrder = vi.mocked(pve.configureVmIsolation).mock.invocationCallOrder[0]!;
    const startOrder = vi.mocked(pve.startVm).mock.invocationCallOrder[0]!;
    expect(isolationOrder).toBeLessThan(startOrder);
    // ...and placement before policy: the rules are written on the final bridge.
    expect(client.put.mock.invocationCallOrder[client.put.mock.calls.indexOf(nicPut!)]!).toBeLessThan(isolationOrder);
    // The uploaded archive is a transient carrier — removed after success.
    expect(pve.deleteBackup).toHaveBeenCalledWith('pve-0', 'backups', VOLID);
  });

  it('a successful restore keeps the archive while another row still restores from it', async () => {
    vi.mocked(prisma.virtualMachine.count).mockResolvedValue(1 as never);
    await restoreFromUpload(user, { filename: FILENAME, name: 'migrated-web' });
    expect(prisma.virtualMachine.count).toHaveBeenCalledWith({
      where: { opArchive: VOLID, id: { not: 'vm1' }, OR: [{ status: 'creating' }, { opUpid: { not: null } }] },
    });
    expect(pve.deleteBackup).not.toHaveBeenCalled();
    vi.mocked(prisma.virtualMachine.count).mockReset();
  });

  it('a failure before the restore keeps the archive while another row still restores from it', async () => {
    vi.mocked(pve.pickBestNode).mockRejectedValueOnce(new Error('no node fits'));
    vi.mocked(prisma.virtualMachine.count).mockResolvedValue(1 as never);
    await expect(restoreFromUpload(user, { filename: FILENAME, name: 'migrated-web' })).rejects.toThrow(/no node fits/);
    expect(prisma.virtualMachine.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ opArchive: VOLID }) }),
    );
    expect(pve.deleteBackup).not.toHaveBeenCalled();
    // With nothing else using it, the same failure removes it.
    vi.mocked(pve.pickBestNode).mockRejectedValueOnce(new Error('no node fits'));
    vi.mocked(prisma.virtualMachine.count).mockResolvedValue(0 as never);
    await expect(restoreFromUpload(user, { filename: FILENAME, name: 'migrated-web' })).rejects.toThrow(/no node fits/);
    expect(pve.deleteBackup).toHaveBeenCalledWith('pve-0', 'backups', VOLID);
    vi.mocked(prisma.virtualMachine.count).mockReset();
  });

  describe('with a Proxmox pool configured', () => {
    let dir: string;
    const RENAMED = 'vzdump-qemu-200-2026_07_03-03_00_00.vma.zst';
    const write = async (name: string, data: Buffer | string) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(dir, name), data);
    };
    beforeEach(async () => {
      const { mkdtemp } = await import('node:fs/promises');
      const os = await import('node:os');
      const zlib = await import('node:zlib');
      dir = await mkdtemp(path.join(os.tmpdir(), 'pm-upload-'));
      await write(FILENAME, zlib.zstdCompressSync(buildVma({ 'qemu-server.conf': QEMU_CFG })));
      await markUploadedFor(FILENAME);
      vi.mocked(backupDir).mockReturnValue(dir);
      vi.mocked(pve.getGuestPool).mockResolvedValue('proxmate');
      vi.mocked(pve.storagePlacement).mockResolvedValue({ nodes: ['pve-0'], shared: true });
      vi.mocked(reserveVmIds).mockResolvedValue([200]);
    });
    afterEach(async () => {
      vi.mocked(pve.getGuestPool).mockResolvedValue(undefined);
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    });
    const markUploadedFor = (name: string) => write(`.proxmate-uploaded.${name}`, '');
    const exists = async (name: string) => (await import('node:fs')).existsSync(path.join(dir, name));

    it('never asks Proxmox about the archive before its guest exists, and restores the renamed one into the pool', async () => {
      await restoreFromUpload(user, { filename: FILENAME, name: 'migrated-web' });
      const volid = `backups:backup/${RENAMED}`;
      // The listing and extractconfig check access by the archive's VMID: not used.
      expect(pve.getBackupNodes).not.toHaveBeenCalled();
      expect(pve.extractBackupConfig).not.toHaveBeenCalled();
      // The config came from the file: the quota check saw the archive's sizes.
      expect(assertWithinQuota).toHaveBeenCalledWith(user, expect.objectContaining({ cpu: 4, ram: 8192, storage: 33 }));
      expect(pve.restoreNewGuest).toHaveBeenCalledWith(
        { node: 'pve-0', vmid: 200, volid, storage: 'local-lvm', pool: 'proxmate' },
        expect.anything(),
        'qemu',
      );
      expect(pve.deleteBackup).toHaveBeenCalledWith('pve-0', 'backups', volid);
      expect(await exists(FILENAME)).toBe(false);
      expect(await exists(`.proxmate-uploaded.${RENAMED}`)).toBe(false);
    });

    it('records the renamed archive on the row, so a restart can still remove it', async () => {
      await restoreFromUpload(user, { filename: FILENAME, name: 'migrated-web' });
      expect(vi.mocked(prisma.virtualMachine.create).mock.calls[0]![0].data).toMatchObject({
        opKind: 'restore-upload',
        opArchive: `backups:backup/${RENAMED}`,
        proxmoxVmId: 200,
      });
    });

    it('reserves the VMID before renaming, and releases it when done', async () => {
      await restoreFromUpload(user, { filename: FILENAME, name: 'migrated-web' });
      expect(reserveVmIds).toHaveBeenCalledWith(1, expect.anything());
      expect(pve.getNextVmId).not.toHaveBeenCalled();
      expect(releaseVmId).toHaveBeenCalledWith(200);
    });

    it('releases the VMID and removes the archive when a later step fails', async () => {
      vi.mocked(assertWithinQuota).mockRejectedValueOnce(new Error('over quota'));
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/over quota/);
      expect(releaseVmId).toHaveBeenCalledWith(200);
      expect(await exists(RENAMED)).toBe(false);
      expect(await exists(FILENAME)).toBe(false);
    });

    it('removes the upload when the reservation itself fails', async () => {
      vi.mocked(reserveVmIds).mockRejectedValueOnce(new Error('Could not find enough free VMIDs on the cluster.'));
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/free VMIDs/);
      expect(await exists(FILENAME)).toBe(false);
      expect(releaseVmId).not.toHaveBeenCalled();
    });

    it('removes a restored guest whose real config differs from what the archive header said', async () => {
      restored.config = { hostpci0: '01:00.0' };
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/won't restore/);
      expect(pve.deleteVm).toHaveBeenCalledWith('pve-0', 200, expect.anything(), 'qemu');
      expect(pve.startVm).not.toHaveBeenCalled();
      expect(releaseVmId).toHaveBeenCalledWith(200);
      expect(await exists(RENAMED)).toBe(false);
    });

    it('treats every unused disk on the restored guest as foreign', async () => {
      const { assertOwnVolumes } = await import('../src/services/vm.service.js');
      await restoreFromUpload(user, { filename: FILENAME, name: 'migrated-web' });
      expect(assertOwnVolumes).toHaveBeenCalledWith({ id: 'vm1' }, expect.anything(), expect.any(Set), { unusedAreForeign: true });
    });

    it('refuses a backup storage local to each of several nodes', async () => {
      vi.mocked(pve.storagePlacement).mockResolvedValue({ nodes: ['pve-0', 'pve-1'], shared: false });
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/need a shared backup storage/);
      expect(pve.restoreNewGuest).not.toHaveBeenCalled();
      expect(await exists(RENAMED)).toBe(false);
    });

    it('refuses an archive it cannot read, and removes it', async () => {
      await write(FILENAME, 'not a zstd stream');
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toBeInstanceOf(RestoreUploadError);
      expect(pve.restoreNewGuest).not.toHaveBeenCalled();
      expect(await exists(RENAMED)).toBe(false);
    });

    it('never replaces a file that already has the new name, and discards this upload', async () => {
      await write(RENAMED, 'someone else');
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/upload was discarded/);
      expect(await exists(FILENAME)).toBe(false);
      expect(await exists(RENAMED)).toBe(true);
      expect((await import('node:fs')).readFileSync(path.join(dir, RENAMED), 'utf8')).toBe('someone else');
    });
  });

  describe('sweepStaleUploads', () => {
    let dir: string;
    beforeEach(async () => {
      const { mkdtemp } = await import('node:fs/promises');
      const os = await import('node:os');
      dir = await mkdtemp(path.join(os.tmpdir(), 'pm-sweep-'));
      vi.mocked(backupDir).mockReturnValue(dir);
      vi.mocked(prisma.virtualMachine.count).mockResolvedValue(0 as never);
    });
    afterEach(async () => {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    });
    const put = async (name: string, ageMs: number) => {
      const { writeFile, utimes } = await import('node:fs/promises');
      const full = path.join(dir, name);
      await writeFile(full, 'x');
      const t = (Date.now() - ageMs) / 1000;
      await utimes(full, t, t);
    };
    const left = async () => (await (await import('node:fs/promises')).readdir(dir)).sort();
    const H = 60 * 60 * 1000;

    it('removes only old archives ProxMate marked as its uploads, and stalled temp files', async () => {
      await put('vzdump-qemu-300-a.vma.zst', 8 * H); // old upload
      await put('.proxmate-uploaded.vzdump-qemu-300-a.vma.zst', 8 * H);
      await put('vzdump-qemu-301-b.vma.zst', 8 * H); // a real backup: no marker
      await put('vzdump-qemu-302-c.vma.zst', 1 * H); // a recent upload
      await put('.proxmate-uploaded.vzdump-qemu-302-c.vma.zst', 1 * H);
      await put('.proxmate-upload-0123456789abcdef.part', 8 * H); // stalled upload
      await put('.proxmate-upload-fedcba9876543210.part', 0); // still being written
      expect(await sweepStaleUploads()).toBe(2);
      expect(await left()).toEqual([
        '.proxmate-upload-fedcba9876543210.part',
        '.proxmate-uploaded.vzdump-qemu-302-c.vma.zst',
        'vzdump-qemu-301-b.vma.zst',
        'vzdump-qemu-302-c.vma.zst',
      ]);
    });

    it('keeps an old upload whose restore target is still being created (keyed by the noted VMID)', async () => {
      const { writeFile, utimes } = await import('node:fs/promises');
      await put('vzdump-qemu-104-a.vma.zst', 8 * H); // the tenant's original VMID in the name
      const marker = path.join(dir, '.proxmate-uploaded.vzdump-qemu-104-a.vma.zst');
      await writeFile(marker, '512');
      const t = (Date.now() - 8 * H) / 1000;
      await utimes(marker, t, t);
      vi.mocked(prisma.virtualMachine.count).mockResolvedValue(1 as never);
      expect(await sweepStaleUploads()).toBe(0);
      expect(prisma.virtualMachine.count).toHaveBeenCalledWith({ where: { proxmoxVmId: 512, OR: [{ status: 'creating' }, { opUpid: { not: null } }] } });
      expect((await left()).length).toBe(2);
    });

    it('also keeps an archive a held row still carrying its task records (its follower may come back)', async () => {
      await put('vzdump-qemu-300-b.vma.zst', 8 * H);
      await put('.proxmate-uploaded.vzdump-qemu-300-b.vma.zst', 8 * H);
      vi.mocked(prisma.virtualMachine.count).mockResolvedValue(0 as never);
      vi.mocked(prisma.virtualMachine.findMany).mockResolvedValueOnce([
        { opArchive: 'backups:backup/vzdump-qemu-300-b.vma.zst' },
      ] as never);
      expect(await sweepStaleUploads()).toBe(0);
      expect(prisma.virtualMachine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { opArchive: { not: null }, OR: [{ status: 'creating' }, { opUpid: { not: null } }] } }),
      );
      expect((await left()).length).toBe(2);
    });

    it('a settled row never removes an archive another row still needs', async () => {
      const volid = 'backups:backup/vzdump-qemu-300-c.vma.zst';
      vi.mocked(prisma.virtualMachine.count).mockResolvedValueOnce(1 as never);
      await cleanupUploadedArchive(volid, 'pve-0', 'rowa');
      expect(prisma.virtualMachine.count).toHaveBeenCalledWith({
        where: { opArchive: volid, id: { not: 'rowa' }, OR: [{ status: 'creating' }, { opUpid: { not: null } }] },
      });
      expect(pve.deleteBackup).not.toHaveBeenCalled();
      vi.mocked(prisma.virtualMachine.count).mockResolvedValueOnce(0 as never);
      await cleanupUploadedArchive(volid, 'pve-0', 'rowa');
      expect(pve.deleteBackup).toHaveBeenCalledWith('pve-0', 'backups', volid);
    });

    it('keeps an old upload a machine still creating records as its archive (left to the restart reconciler)', async () => {
      // Without a pool the archive keeps its original VMID, so only opArchive ties it to the row.
      await put('vzdump-qemu-300-a.vma.zst', 8 * H);
      await put('.proxmate-uploaded.vzdump-qemu-300-a.vma.zst', 8 * H);
      vi.mocked(prisma.virtualMachine.count).mockResolvedValue(0 as never);
      vi.mocked(prisma.virtualMachine.findMany).mockResolvedValueOnce([
        { opArchive: 'backups:backup/vzdump-qemu-300-a.vma.zst' },
      ] as never);
      expect(await sweepStaleUploads()).toBe(0);
      expect((await left()).length).toBe(2);
    });

    it('notes the restore target in the marker of a default-mode upload', async () => {
      const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
      const os = await import('node:os');
      const up = await mkdtemp(path.join(os.tmpdir(), 'pm-note-'));
      vi.mocked(backupDir).mockReturnValue(up);
      await writeFile(path.join(up, FILENAME), 'x');
      await writeFile(path.join(up, `.proxmate-uploaded.${FILENAME}`), '');
      let noted = '';
      vi.mocked(prisma.virtualMachine.create).mockImplementationOnce((async () => {
        noted = await readFile(path.join(up, `.proxmate-uploaded.${FILENAME}`), 'utf8');
        return { id: 'vm1' };
      }) as never);
      await restoreFromUpload(user, { filename: FILENAME, name: 'x' });
      expect(noted).toBe('200');
    });
  });

  it('derives LXC restores from the filename', async () => {
    vi.mocked(pve.extractBackupConfig).mockResolvedValue(LXC_CFG);
    const lxcFile = 'vzdump-lxc-105-2026_07_03-03_00_00.tar.zst';
    await restoreFromUpload(user, { filename: lxcFile, name: 'migrated-ct' });
    expect(pve.restoreNewGuest).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'lxc');
  });

  it('clamps a restored container\'s swap to ProxMate\'s default (audit round 2)', async () => {
    vi.mocked(pve.extractBackupConfig).mockResolvedValue(LXC_CFG);
    vi.mocked(pve.getVmConfig).mockResolvedValue({ hostname: 'ct-1', swap: '65536', net0: 'name=eth0,bridge=vmbr9,ip=10.0.0.5/24' });
    await restoreFromUpload(user, { filename: 'vzdump-lxc-105-2026_07_03-03_00_00.tar.zst', name: 'ct' });
    const put = client.put.mock.calls.find((x) => String(x[0]) === '/nodes/pve-0/lxc/200/config');
    expect(bodyOf(put!)).toMatchObject({ swap: '512', net0: 'name=eth0,bridge=vmbr0,firewall=1,ip=dhcp,tag=42' });
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
    expect(settleFailedCreate).toHaveBeenCalledWith({ id: 'vm1' }, err, false, { task: expect.objectContaining({ node: 'pve-0', upid: 'UPID:1' }) });
  });

  it('leaves the archive to the follower while a timed-out restore task may still be reading it (audit MAJOR 1)', async () => {
    vi.mocked(pve.waitForTask).mockRejectedValue(new Error('Proxmox task timed out'));
    vi.mocked(settleFailedCreate).mockResolvedValueOnce({ following: true });
    await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/timed out/);
    expect(pve.deleteBackup).not.toHaveBeenCalled();
    // Before the late guest is tied to the row, it gets the same rebuild, volume
    // check, isolation and re-sync as an on-time restore (audit round 2).
    const task = vi.mocked(settleFailedCreate).mock.calls[0]![3]!.task as {
      beforeTag: () => Promise<void>;
      afterTask: () => Promise<void>;
    };
    const { assertOwnVolumes } = await import('../src/services/vm.service.js');
    await task.beforeTag();
    expect(client.put).toHaveBeenCalledWith('/nodes/pve-0/qemu/200/config', expect.any(URLSearchParams));
    expect(assertOwnVolumes).toHaveBeenCalledWith(
      { id: 'vm1' },
      expect.anything(),
      new Set(['local-lvm:vm-200-disk-0']),
      { unusedAreForeign: false },
    );
    expect(pve.configureVmIsolation).toHaveBeenCalled();
    expect(syncRestoredGuest).toHaveBeenCalledWith({ id: 'vm1' }, { approvedPci: [], client: expect.anything() });
    // The follower's cleanup is the archive removal.
    await task.afterTask();
    expect(pve.deleteBackup).toHaveBeenCalledWith('pve-0', 'backups', VOLID);
  });

  it('settles a failure after the restore landed as "guest created", and tags the guest first', async () => {
    const err = new Error('start failed');
    vi.mocked(pve.startVm).mockRejectedValue(err);
    await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow('start failed');
    expect(markClonedGuest).toHaveBeenCalledWith({ id: 'vm1' }, expect.anything());
    expect(settleFailedCreate).toHaveBeenCalledWith({ id: 'vm1' }, err, true, { task: expect.objectContaining({ node: 'pve-0', upid: 'UPID:1' }) });
  });

  describe('the restored guest is checked as Proxmox holds it, not as the archive claimed', () => {
    it.each([
      ['a container device the rootfs pct.conf added', 'lxc', { dev0: '/dev/sda' }],
      ['raw lxc keys', 'lxc', { lxc: [['lxc.mount.entry', '/ host none bind']] }],
      ['a privileged container', 'lxc', { unprivileged: 0 }],
      ['a host PCI device', 'qemu', { hostpci0: '01:00.0' }],
      ['raw QEMU arguments', 'qemu', { args: '-device foo' }],
      ['a hook script', 'qemu', { hookscript: 'local:snippets/x.pl' }],
    ])('removes a guest restored with %s, drops the row and never starts it', async (_label, kind, extra) => {
      restored.config = extra;
      const file = kind === 'lxc' ? 'vzdump-lxc-105-2026_07_03-03_00_00.tar.zst' : FILENAME;
      if (kind === 'lxc') vi.mocked(pve.extractBackupConfig).mockResolvedValue(LXC_CFG);
      await expect(restoreFromUpload(user, { filename: file, name: 'x' })).rejects.toThrow(/settings ProxMate won't restore/);
      expect(pve.deleteVm).toHaveBeenCalledWith('pve-0', 200, expect.anything(), kind);
      expect(markClonedGuest).not.toHaveBeenCalled();
      expect(pve.startVm).not.toHaveBeenCalled();
      // The guest is gone, so the row is settled as "no guest created".
      expect(settleFailedCreate).toHaveBeenCalledWith({ id: 'vm1' }, expect.anything(), false, { task: undefined });
    });

    it('drops protection and autostart before removing the guest, so the delete is not refused', async () => {
      restored.config = { protection: 1, onboot: 1, dev0: '/dev/sda' };
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/won't restore/);
      const protIdx = client.put.mock.calls.findIndex((x) => bodyOf(x)['delete'] === 'protection');
      expect(protIdx).toBeGreaterThanOrEqual(0);
      expect(client.put.mock.calls.some((x) => bodyOf(x)['delete'] === 'onboot')).toBe(true);
      expect(client.put.mock.invocationCallOrder[protIdx]!).toBeLessThan(vi.mocked(pve.deleteVm).mock.invocationCallOrder[0]!);
    });

    it('removes a guest whose config could not be read back (fail closed)', async () => {
      const base = client.get.getMockImplementation()!;
      client.get.mockImplementation((url: string) =>
        url.endsWith('/pending') ? Promise.reject(new Error('Proxmox responded 500')) : base(url),
      );
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/500/);
      expect(pve.deleteVm).toHaveBeenCalledWith('pve-0', 200, expect.anything(), 'qemu');
      expect(pve.startVm).not.toHaveBeenCalled();
    });

    it('clears the archive\'s guest firewall before isolation is applied', async () => {
      await restoreFromUpload(user, { filename: FILENAME, name: 'x' });
      expect(pve.resetRestoredFirewall).toHaveBeenCalledWith('pve-0', 200, expect.anything(), 'qemu');
      expect(vi.mocked(pve.resetRestoredFirewall).mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked(pve.configureVmIsolation).mock.invocationCallOrder[0]!,
      );
    });

    it('drops autostart and protection right after the task, before the check and the firewall reset', async () => {
      await restoreFromUpload(user, { filename: FILENAME, name: 'x' });
      const strip = client.put.mock.calls.findIndex((x) => bodyOf(x)['delete'] === 'onboot');
      expect(strip).toBeGreaterThanOrEqual(0);
      const checked = client.get.mock.calls.findIndex((x) => String(x[0]).endsWith('/pending'));
      expect(client.put.mock.invocationCallOrder[strip]!).toBeLessThan(client.get.mock.invocationCallOrder[checked]!);
      expect(client.put.mock.invocationCallOrder[strip]!).toBeLessThan(vi.mocked(pve.resetRestoredFirewall).mock.invocationCallOrder[0]!);
    });

    it('neutralises (without deleting) a guest that passed the check when a later step fails', async () => {
      vi.mocked(pve.startVm).mockRejectedValueOnce(new Error('start failed'));
      restored.config = { net0: 'virtio=AA:BB,bridge=vmbr0,firewall=1' };
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow('start failed');
      expect(pve.deleteVm).not.toHaveBeenCalled();
      expect(client.put.mock.calls.map(bodyOf)).toContainEqual({ net0: 'virtio=AA:BB,bridge=vmbr0,firewall=1,link_down=1' });
    });

    it('refuses pending changes and snapshots too', async () => {
      restored.pending = [{ key: 'hostpci0', pending: '01:00.0' }];
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/pending changes to "hostpci0"/);
      restored.pending = [];
      restored.snapshots = [{ name: 'evil' }, { name: 'current' }];
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/snapshots/);
    });

    it('holds the row (guest kept, never started) when the guest cannot be removed', async () => {
      restored.config = { hostpci0: '01:00.0' };
      vi.mocked(pve.deleteVm).mockRejectedValueOnce(new Error('locked'));
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/won't restore/);
      expect(settleFailedCreate).toHaveBeenCalledWith({ id: 'vm1' }, expect.anything(), true, { task: expect.anything() });
      expect(pve.startVm).not.toHaveBeenCalled();
    });

    it('never tags a late-finishing guest that fails the check, and removes it', async () => {
      vi.mocked(pve.waitForTask).mockRejectedValueOnce(new Error('Proxmox task timed out'));
      await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toThrow(/timed out/);
      const task = vi.mocked(settleFailedCreate).mock.calls[0]![3]!.task as { verify: () => Promise<void> };
      restored.config = { dev0: '/dev/sda', onboot: 1 };
      await expect(task.verify()).rejects.toMatchObject({ guestRemoved: true });
      expect(client.put.mock.calls.some((x) => bodyOf(x)['delete'] === 'onboot')).toBe(true);
      expect(pve.deleteVm).toHaveBeenCalledWith('pve-0', 200, expect.anything(), 'qemu');
      expect(markClonedGuest).not.toHaveBeenCalled();
    });
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

  it('checks volume ownership right after the restore, and never starts a guest that fails it (audit round 2)', async () => {
    const { ForeignVolumeError } = await vi.importActual<typeof import('../src/services/vm.service.js')>('../src/services/vm.service.js');
    const { assertOwnVolumes } = await import('../src/services/vm.service.js');
    vi.mocked(assertOwnVolumes).mockRejectedValueOnce(new ForeignVolumeError(['scsi1']));
    await expect(restoreFromUpload(user, { filename: FILENAME, name: 'x' })).rejects.toBeInstanceOf(ForeignVolumeError);
    expect(pve.startVm).not.toHaveBeenCalled();
    expect(settleFailedCreate).toHaveBeenCalledWith({ id: 'vm1' }, expect.any(ForeignVolumeError), true, expect.anything());
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

  it('checks every section of the archive config, not only the first', () => {
    expect(() => assertRestorableConfig(`${LXC_CFG}[PENDING]\nmemory: 2048\n`, 'lxc')).toThrow(/pending changes/);
    expect(() => assertRestorableConfig(`${LXC_CFG}[snap]\nlxc.mount.entry: / host none\n`, 'lxc')).toThrow(RestoreUploadError);
    expect(() => assertRestorableConfig(`${LXC_CFG}[not a section]\n`, 'lxc')).toThrow(/section/);
    expect(() => assertRestorableConfig(`${LXC_CFG}Dev0: /dev/sda\n`, 'lxc')).toThrow(/line/);
    expect(() => assertRestorableConfig(`${LXC_CFG}garbage without a colon\n`, 'lxc')).toThrow(/line/);
    // A snapshot's vmstate must be a storage volume too.
    expect(() => assertRestorableConfig(`${QEMU_CFG}vmstate: /dev/sdb\n`, 'qemu')).toThrow(/not a storage volume/);
    // A snapshot section's own keys are fine.
    expect(() =>
      assertRestorableConfig(`${QEMU_CFG}snaptime: 1700000000\nvmstate: local-lvm:vm-104-state-snap1\n`, 'qemu'),
    ).not.toThrow();
    expect(() => assertRestorableConfig(`#a description line\n${LXC_CFG}`, 'lxc')).not.toThrow();
    // A disk line naming its volume with file=/volume= is checked like a bare one.
    expect(() => assertRestorableConfig(`${QEMU_CFG.split('[')[0]}scsi3: file=/dev/sdb,size=1G\n`, 'qemu')).toThrow(/not a storage volume/);
    expect(() => assertRestorableConfig(`${LXC_CFG}mp1: volume=/srv/host,mp=/x\n`, 'lxc')).toThrow(/not a storage volume/);
    expect(() =>
      assertRestorableConfig(`${QEMU_CFG.split('[')[0]}scsi3: local-lvm:vm-104-disk-9,file=/dev/sdb,size=1G\n`, 'qemu'),
    ).toThrow(/not a storage volume/);
    expect(() => assertRestorableConfig(`${LXC_CFG}mp1: volume=local-lvm:vm-105-disk-2,mp=/x,size=1G\n`, 'lxc')).not.toThrow();
  });

  it('accepts every config shape ProxMate itself produces (audit round 2)', () => {
    const shapes: Array<[string, 'qemu' | 'lxc', string]> = [
      ['QEMU ISO create', 'qemu', [
        'agent: 1', 'boot: order=scsi0;ide2', 'cores: 2', 'ide2: local:iso/debian-12.iso,media=cdrom',
        'memory: 2048', 'meta: creation-qemu=8.1.2,ctime=1700000000', 'name: web', 'net0: virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1',
        'ostype: l26', 'scsi0: local-lvm:vm-104-disk-0,size=32G', 'scsihw: virtio-scsi-pci',
        'smbios1: uuid=0b6b1f6c-0000-4000-8000-000000000000', 'sockets: 1', 'tags: proxmate-abc', 'vmgenid: 0b6b1f6c-0000-4000-8000-000000000001',
      ].join('\n')],
      ['cloud-init deploy', 'qemu', [
        'agent: enabled=1', 'bios: ovmf', 'boot: order=scsi0', 'cicustom: vendor=shared-snip:snippets/proxmate-docker-tailscale.yaml',
        'ciuser: admin', 'cores: 4', 'cpu: host', 'description: Debian 12 cloud image', 'efidisk0: local-lvm:vm-104-disk-1,efitype=4m,size=4M',
        'ide2: local-lvm:vm-104-cloudinit,media=cdrom', 'ipconfig0: ip=dhcp', 'machine: q35', 'memory: 4096', 'name: app',
        'net0: virtio=BC:24:11:00:00:02,bridge=vmbr0,firewall=1,tag=42', 'scsi0: local-lvm:vm-104-disk-0,discard=on,size=20G',
        'scsihw: virtio-scsi-single', 'serial0: socket', 'sshkeys: ssh-ed25519%20AAAAC3Nz%20me', 'vga: serial0',
      ].join('\n')],
      ['rescue mode', 'qemu', [
        'boot: order=ide3', 'cores: 1', 'ide3: local:iso/systemrescue.iso,media=cdrom', 'memory: 1024', 'name: web',
        'net0: virtio=BC:24:11:00:00:03,bridge=vmbr0,firewall=1', 'scsi0: local-lvm:vm-104-disk-0,size=32G', 'vga: std',
      ].join('\n')],
      ['LXC create', 'lxc', [
        'arch: amd64', 'cores: 2', 'hostname: ct', 'memory: 1024', 'swap: 512',
        'net0: name=eth0,bridge=vmbr0,firewall=1,hwaddr=BC:24:11:00:00:04,ip=dhcp,type=veth',
        'ostype: debian', 'rootfs: local-lvm:vm-105-disk-0,size=8G', 'unprivileged: 1', 'tags: proxmate-def',
      ].join('\n')],
    ];
    for (const [label, kind, text] of shapes) {
      expect(() => assertRestorableConfig(text, kind), label).not.toThrow();
    }
  });

  it('keeps only ProxMate-produced snippets in cicustom (audit round 2)', () => {
    expect(ownCicustom('vendor=shared-snip:snippets/proxmate-docker.yaml')).toBe(true);
    expect(ownCicustom('vendor=local:snippets/proxmate-docker.yaml')).toBe(false); // not SNIPPET_STORAGE
    expect(ownCicustom('user=shared-snip:snippets/evil.yaml')).toBe(false);
    expect(ownCicustom('vendor=shared-snip:snippets/proxmate-docker.yaml,network=shared-snip:snippets/proxmate-x.yaml')).toBe(false);
  });

  it('refuses a privileged container', () => {
    expect(() => assertRestorableConfig(LXC_CFG.replace('unprivileged: 1\n', ''), 'lxc')).toThrow(/privileged/);
  });

  it('refuses anything outside the allowlist, and disallowed values of allowed keys (audit minor)', () => {
    const live = QEMU_CFG.split('[')[0];
    for (const extra of [
      'virtiofs0: share1',
      'scsi5: /dev/sdb,size=10G',
      'scsi5: local-lvm:0,import-from=/root/disk.qcow2,size=10G',
      'numa0: cpus=0-3,hostnodes=0,memory=1024',
      'numa: 2',
      'affinity: 0-3',
      'rng0: source=/dev/hwrng',
      'template: 1',
      'something-new: 1',
    ]) {
      expect(() => assertRestorableConfig(`${live}${extra}\n`, 'qemu'), extra).toThrow(RestoreUploadError);
    }
    expect(() => assertRestorableConfig(`${LXC_CFG}features: nesting=1,keyctl=1\n`, 'lxc')).toThrow(RestoreUploadError);
    expect(() => assertRestorableConfig(`${LXC_CFG}features: nesting=1\n`, 'lxc')).not.toThrow();
  });

  it('accepts an ordinary guest (a serial socket console is fine)', () => {
    expect(() => assertRestorableConfig(`serial0: socket\n${QEMU_CFG}`, 'qemu')).not.toThrow();
    expect(() => assertRestorableConfig(LXC_CFG, 'lxc')).not.toThrow();
  });
});

describe('renameArchiveForVmid', () => {
  it('replaces only the VMID, keeping the rest of a valid name', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const os = await import('node:os');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pm-rename-'));
    try {
      vi.mocked(backupDir).mockReturnValue(dir);
      await writeFile(path.join(dir, 'vzdump-lxc-7-2026_01_01-00_00_00.tar.zst'), 'x');
      const renamed = await renameArchiveForVmid('vzdump-lxc-7-2026_01_01-00_00_00.tar.zst', 4321);
      expect(renamed).toBe('vzdump-lxc-4321-2026_01_01-00_00_00.tar.zst');
      expect(VZDUMP_UPLOAD_RE.test(renamed)).toBe(true);
      expect(existsSync(path.join(dir, renamed))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses anything that is not a plain vzdump name in the upload directory', async () => {
    vi.mocked(backupDir).mockReturnValue('/nonexistent-test-mount');
    await expect(renameArchiveForVmid('../vzdump-qemu-1-x.vma', 2)).rejects.toThrow(RestoreUploadError);
    await expect(renameArchiveForVmid('notabackup.zip', 2)).rejects.toThrow(RestoreUploadError);
  });
});

describe('promoteUpload', () => {
  it('never replaces an existing backup, and keeps the temp file for the caller to drop', async () => {
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const os = await import('node:os');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pm-promote-'));
    try {
      const temp = path.join(dir, '.proxmate-upload-0123456789abcdef.part');
      const final = path.join(dir, 'vzdump-qemu-1-x.vma.zst');
      await writeFile(temp, 'upload');
      await writeFile(final, 'a real backup');
      expect(await promoteUpload(temp, final)).toBe(false);
      expect(await readFile(final, 'utf8')).toBe('a real backup');
      expect(existsSync(temp)).toBe(true);

      await rm(final);
      expect(await promoteUpload(temp, final)).toBe(true);
      expect(await readFile(final, 'utf8')).toBe('upload');
      expect(existsSync(temp)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('neutraliseRestoredGuest', () => {
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  const guest = (cfg: Record<string, unknown>) => {
    const c = fakeClient();
    c.get.mockImplementation(() => ok(cfg));
    return c;
  };
  const deletes = (c: ReturnType<typeof fakeClient>) =>
    c.put.mock.calls.map((x) => bodyOf(x)['delete']).filter((d): d is string => d !== undefined);

  beforeEach(() => {
    vi.mocked(pve.deleteVm).mockReset().mockResolvedValue('UPID:del');
    vi.mocked(pve.waitForTask).mockReset().mockResolvedValue(undefined as never);
  });

  it('drops protection and autostart, then deletes the guest', async () => {
    const c = guest({});
    expect(await neutraliseRestoredGuest('pve1', 200, 'lxc', asClient(c), { keys: ['dev0'], destroy: true })).toBe(true);
    expect(deletes(c)).toEqual(['protection', 'onboot', 'startup']);
    expect(pve.deleteVm).toHaveBeenCalledWith('pve1', 200, expect.anything(), 'lxc');
  });

  it('when the delete fails: removes each refused key, reverts pending changes and takes every NIC down', async () => {
    vi.mocked(pve.deleteVm).mockRejectedValueOnce(new Error('VM is locked'));
    const c = guest({
      net0: 'name=eth0,bridge=vmbr9,ip=dhcp',
      net1: 'name=eth1,bridge=vmbr9,link_down=0',
      net2: 'name=eth2,bridge=vmbr0,link_down=1',
    });
    const gone = await neutraliseRestoredGuest('pve1', 200, 'lxc', asClient(c), {
      keys: ['dev0', 'unprivileged', 'features'],
      pendingKeys: ['hookscript'],
      destroy: true,
    });
    expect(gone).toBe(false);
    expect(deletes(c)).toEqual(['protection', 'onboot', 'startup', 'dev0', 'features']); // never unprivileged
    expect(c.put.mock.calls.map(bodyOf)).toContainEqual({ revert: 'hookscript' });
    const nics = c.put.mock.calls.map(bodyOf).filter((b) => Object.keys(b).some((k) => /^net\d+$/.test(k)));
    expect(nics).toEqual([
      { net0: 'name=eth0,bridge=vmbr9,ip=dhcp,link_down=1' },
      { net1: 'name=eth1,bridge=vmbr9,link_down=1' },
    ]);
  });

  it('keeps the guest when asked (the tenant\'s own machine), neutralised the same way', async () => {
    const c = guest({ net0: 'virtio=AA:BB,bridge=vmbr0' });
    expect(await neutraliseRestoredGuest('pve1', 100, 'qemu', asClient(c), { keys: ['args'], destroy: false })).toBe(false);
    expect(pve.deleteVm).not.toHaveBeenCalled();
    expect(deletes(c)).toEqual(['protection', 'onboot', 'startup', 'args']);
    expect(c.put.mock.calls.map(bodyOf)).toContainEqual({ net0: 'virtio=AA:BB,bridge=vmbr0,link_down=1' });
  });

  it('keeps going when Proxmox refuses one change', async () => {
    vi.mocked(pve.deleteVm).mockRejectedValueOnce(new Error('locked'));
    const c = guest({});
    c.put.mockImplementation((_u: string, b: URLSearchParams) =>
      b.get('delete') === 'protection' ? Promise.reject(new Error('no')) : ok(''),
    );
    await neutraliseRestoredGuest('pve1', 200, 'qemu', asClient(c), { keys: ['hostpci0'], destroy: true });
    expect(deletes(c)).toContain('hostpci0');
  });
});
