import { promises as fsp, constants as fsConstants, existsSync } from 'node:fs';
import path from 'node:path';
import type { User, VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
import { backupDir } from './download.service.js';
import { getBackupStorage } from './matestate.service.js';
import {
  assertWithinQuota,
  acquireQuotaLock,
  markClonedGuest,
  settleFailedCreate,
  syncRestoredGuest,
} from './vm.service.js';
import { parseGuestConfigText, guestConfigSizes } from '../lib/guest-config.js';
import * as pve from './proxmox.service.js';

/**
 * Restore-from-upload: a tenant uploads a vzdump archive they previously
 * downloaded (MateState download email) and ProxMate restores it as a brand-new
 * guest — the migration path between clusters / ProxMate instances.
 *
 * The Proxmox API cannot accept backup uploads (`upload` rejects
 * `content=backup`), so this is the write-side twin of the download feature:
 * the file is streamed into the admin-mounted backup share
 * (`BACKUP_DOWNLOAD_DIR`), where Proxmox's storage scan picks it up as a
 * regular backup volume, and the restore runs through the normal API. The
 * feature therefore requires the mount to be WRITABLE (downloads only read).
 */

/** Same strict shape the download side enforces — nothing path-like gets through. */
export const VZDUMP_UPLOAD_RE = /^vzdump-(qemu|lxc)-\d+-[\w.-]+\.(vma|tar)(\.(zst|gz|lzo))?$/;

/** Where uploads land: Proxmox dir storages keep backups in `<dir>/dump`. */
export function uploadDir(): string | null {
  const dir = backupDir();
  if (!dir) return null;
  const dump = path.join(dir, 'dump');
  return existsSync(dump) ? dump : dir;
}

/** Whether restore-from-upload is available (share mounted AND writable). */
export async function restoreUploadsEnabled(): Promise<boolean> {
  const dir = uploadDir();
  if (!dir) return false;
  try {
    await fsp.access(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export class RestoreUploadError extends Error {}

/** The dot-name multer writes uploads under before they're validated + renamed. */
export const TEMP_UPLOAD_RE = /^\.proxmate-upload-[a-f0-9]{16}\.part$/;

/**
 * Re-derive a TRUSTED absolute path from a possibly tainted one: reduce to a
 * bare basename, require it to match `expect`, resolve it under the upload
 * root, and verify containment (same hardening as the download side's
 * resolveBackupFile). Returns null for anything path-like or foreign — the
 * only way a client-influenced string may reach the filesystem.
 */
export function resolveUnderUploadDir(candidate: string, expect: RegExp): string | null {
  const dir = uploadDir();
  if (!dir) return null;
  const base = path.basename(candidate);
  if (!expect.test(base)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, base);
  if (!full.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel !== base) return null;
  return full;
}

export interface ParsedBackupConfig {
  cores: number;
  memoryMb: number;
  diskGb: number;
  guestName: string | null;
  /** A disk line with no `size=`: the restore would allocate a size this parse can't see. */
  unsizedDisk: boolean;
}

/**
 * Parse the vzdump-embedded guest config (from `vzdump/extractconfig`) into the
 * resource numbers the quota check needs. Pure — unit-tested directly. CPUs are
 * counted as Proxmox runs them (QEMU: sockets x cores, or `vcpus`); memory may be
 * a property string (`current=N`).
 */
export function parseBackupConfig(text: string, kind: pve.GuestKind = 'qemu'): ParsedBackupConfig {
  const cfg = parseGuestConfigText(text);
  const sizes = guestConfigSizes(cfg, kind);
  let diskBytes = 0;
  let unsizedDisk = false;

  const DISK_RE = /^(scsi|sata|virtio|ide|efidisk|tpmstate|rootfs|mp)\d*$/;
  const SIZE_RE = /(?:^|,)size=(\d+(?:\.\d+)?)([KMGT]?)/;
  const UNIT: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

  for (const [key, value] of Object.entries(cfg)) {
    if (!DISK_RE.test(key) || value.includes('media=cdrom')) continue;
    const s = value.match(SIZE_RE);
    if (s) diskBytes += parseFloat(s[1]!) * (UNIT[s[2] ?? ''] ?? 1);
    else unsizedDisk = true;
  }

  return {
    // A container with no `cores` line is charged one core; the restore pins it to that.
    cores: sizes.cpu ?? 1,
    memoryMb: Math.max(16, sizes.ram),
    diskGb: Math.ceil(diskBytes / 1024 ** 3),
    guestName: (cfg['name'] ?? cfg['hostname'])?.trim() || null,
    unsizedDisk,
  };
}

/**
 * Refuse an archive whose config reaches past the guest itself. The archive is
 * built by the tenant, and a restore applies every key in it — so host devices
 * (PCI, USB, serial/parallel ports, container device nodes), host-path mounts,
 * raw QEMU arguments, hook scripts, raw LXC settings and a privileged container
 * are all things only an admin may grant, never something an upload carries in.
 * Throws RestoreUploadError naming the first offending key.
 */
export function assertRestorableConfig(text: string, kind: pve.GuestKind): void {
  const cfg = parseGuestConfigText(text);
  for (const [key, value] of Object.entries(cfg)) {
    const hostDevice =
      /^(hostpci|usb)\d+$/.test(key) ||
      (/^(serial|parallel)\d+$/.test(key) && value.trim().startsWith('/dev/')) ||
      (kind === 'lxc' && /^dev\d+$/.test(key));
    const hostPath = kind === 'lxc' && /^(rootfs|mp\d+)$/.test(key) && value.trim().startsWith('/');
    if (hostDevice || hostPath || key === 'args' || key === 'hookscript' || key.startsWith('lxc.')) {
      throw new RestoreUploadError(
        `This backup can't be restored here: its configuration sets "${key}", which only an admin can set.`,
      );
    }
  }
  if (kind === 'lxc' && cfg['unprivileged']?.trim() !== '1') {
    throw new RestoreUploadError("This backup can't be restored here: it is a privileged container.");
  }
}

/** Best-effort removal of the uploaded archive (Proxmox API first, then the mount). */
async function cleanupArchive(filename: string, node: string | null, storage: string, volid: string): Promise<void> {
  if (node) {
    try {
      await pve.deleteBackup(node, storage, volid);
      return;
    } catch {
      /* fall through to direct unlink */
    }
  }
  const dir = uploadDir();
  if (dir) await fsp.unlink(path.join(dir, path.basename(filename))).catch(() => undefined);
}

/**
 * Restore an uploaded vzdump archive as a new guest owned by `user`.
 * Assumes the file is already fully written into `uploadDir()` under a
 * validated vzdump filename. Always removes the archive afterwards — it was a
 * transient carrier, and leaving it would clutter every VM's backup listing
 * under the OLD (foreign) VMID.
 */
export async function restoreFromUpload(
  user: User,
  input: { filename: string; name: string },
): Promise<VirtualMachine> {
  // Quota check -> row insert runs under the owner's quota lock (vm.service
  // acquireQuotaLock), released as soon as the row exists.
  const release = await acquireQuotaLock(user.id);
  try {
    return await restoreFromUploadLocked(user, input, release);
  } finally {
    release();
  }
}

async function restoreFromUploadLocked(
  user: User,
  input: { filename: string; name: string },
  release: () => void,
): Promise<VirtualMachine> {
  const filename = path.basename(input.filename);
  if (filename !== input.filename || !VZDUMP_UPLOAD_RE.test(filename)) {
    throw new RestoreUploadError('That file is not a vzdump backup archive.');
  }
  const kind: pve.GuestKind = filename.startsWith('vzdump-lxc-') ? 'lxc' : 'qemu';

  const client = await pve.getClient();
  const storage = await getBackupStorage();
  const volid = `${storage}:backup/${filename}`;

  // Proxmox must see the uploaded file through the same storage the share is a
  // mount of — if it doesn't, the mount and `backup_storage` point at
  // different places and restoring is impossible.
  const nodes = await pve.getBackupNodes(storage, volid, client);
  if (nodes.length === 0) {
    await cleanupArchive(filename, null, storage, volid);
    throw new RestoreUploadError(
      `The uploaded file isn't visible on the "${storage}" backup storage. ` +
        'Check that BACKUP_DOWNLOAD_DIR is mounted from that storage\'s directory.',
    );
  }

  try {
    // Quota-check from the archive's embedded config BEFORE restoring anything.
    const rawCfg = await pve.extractBackupConfig(nodes[0]!, volid, client);
    assertRestorableConfig(rawCfg, kind);
    const cfg = parseBackupConfig(rawCfg, kind);
    if (cfg.unsizedDisk) {
      throw new RestoreUploadError("This backup can't be restored here: a disk in its configuration has no size.");
    }
    await assertWithinQuota(user, {
      name: input.name,
      cpu: cfg.cores,
      ram: cfg.memoryMb,
      storage: cfg.diskGb,
      os: filename,
    });

    const [defaultStorage, isolationCfg] = await Promise.all([
      getConfig('default_storage'),
      getConfig('isolation_enabled'),
    ]);
    if (!defaultStorage) throw new RestoreUploadError('Server defaults are not configured — finish setup first');
    const isolate = isolationCfg !== 'false';

    const node = await pve.pickBestNode(
      { cpu: cfg.cores, ramMb: cfg.memoryMb, storageGb: cfg.diskGb },
      defaultStorage,
      client,
      nodes,
      // ARM guest builds aren't shipped, so uploaded backups are x86 today.
      'amd64',
    );
    const vmid = await pve.getNextVmId(client);

    const vm = await prisma.virtualMachine.create({
      data: {
        userId: user.id,
        proxmoxVmId: vmid,
        proxmoxNode: node,
        name: input.name,
        description: `Restored from uploaded backup${cfg.guestName ? ` of "${cfg.guestName}"` : ''}`,
        type: kind,
        cpu: cfg.cores,
        ram: cfg.memoryMb,
        storage: cfg.diskGb,
        os: 'Restored backup',
        status: 'creating',
      },
    });
    release(); // usage now includes this row

    let created = false;
    let restoreTask: { node: string; upid: string } | undefined;
    try {
      // Remap all volumes onto our default pool: cross-cluster archives name
      // storages this cluster may not have. unique=1 → fresh MACs.
      const upid = await pve.restoreNewGuest({ node, vmid, volid, storage: defaultStorage }, client, kind);
      restoreTask = { node, upid };
      await pve.waitForTask(node, upid, client, 30 * 60 * 1000);
      created = true;
      // The archive's config carries the OLD guest's tags; tie the guest to this row.
      await markClonedGuest(vm, client);
      // Read back what was actually restored: no PCI device is approved for a new
      // guest, and the row's sizes come from the guest itself.
      await syncRestoredGuest(vm, { approvedPci: [], client });

      // The restored config carries the OLD guest's name — apply the chosen one.
      await pve.setVmName(node, vmid, input.name, client, kind).catch(() => undefined);

      // ...and the OLD guest's bridge, which may not exist on this cluster at all.
      // `storage` above remaps the volumes; this is the network half of the same job.
      await pve.applyDefaultBridge(node, vmid, client, kind);

      // Tenant isolation BEFORE first boot, built from the regenerated MACs.
      if (isolate) {
        await pve.configureVmIsolation(node, vmid, await pve.readIsolationOptions(), client, kind);
      }

      await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });
      const startUpid = await pve.startVm(node, vmid, client, kind);
      await pve.waitForTask(node, startUpid, client);
      const done = await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
      await cleanupArchive(filename, node, storage, volid);
      return done;
    } catch (err) {
      await settleFailedCreate(vm, err, created, { task: restoreTask });
      throw err;
    }
  } catch (err) {
    // Any pre-restore failure (quota, placement, extract) — drop the archive so
    // a rejected upload never lingers on the backup storage.
    await cleanupArchive(filename, nodes[0] ?? null, storage, volid);
    throw err;
  }
}
