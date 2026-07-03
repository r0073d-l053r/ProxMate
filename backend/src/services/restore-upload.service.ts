import { promises as fsp, constants as fsConstants, existsSync } from 'node:fs';
import path from 'node:path';
import type { User, VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
import { backupDir } from './download.service.js';
import { getBackupStorage } from './matestate.service.js';
import { assertWithinQuota } from './vm.service.js';
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
}

/**
 * Parse the vzdump-embedded guest config (from `vzdump/extractconfig`) into the
 * resource numbers the quota check needs. Pure — unit-tested directly.
 */
export function parseBackupConfig(text: string): ParsedBackupConfig {
  let cores = 1;
  let memoryMb = 512;
  let diskBytes = 0;
  let guestName: string | null = null;

  const DISK_RE = /^(scsi|sata|virtio|ide|efidisk|tpmstate|rootfs|mp)\d*:/;
  const SIZE_RE = /(?:^|,)size=(\d+(?:\.\d+)?)([KMGT]?)/;
  const UNIT: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // A snapshot section ("[snap1]") ends the current config — only size the live one.
    if (line.startsWith('[')) break;
    const m = line.match(/^([a-z]+\d*):\s*(.*)$/i);
    if (!m) continue;
    const [, key, value] = m as unknown as [string, string, string];

    if (key === 'cores') cores = Math.max(1, parseInt(value, 10) || 1);
    else if (key === 'memory') memoryMb = Math.max(16, parseInt(value, 10) || 512);
    else if (key === 'name' || key === 'hostname') guestName = value.trim() || null;
    else if (DISK_RE.test(line) && !value.includes('media=cdrom')) {
      const s = value.match(SIZE_RE);
      if (s) diskBytes += parseFloat(s[1]!) * (UNIT[s[2] ?? ''] ?? 1);
    }
  }

  return { cores, memoryMb, diskGb: Math.ceil(diskBytes / 1024 ** 3), guestName };
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
    const cfg = parseBackupConfig(rawCfg);
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

    try {
      // Remap all volumes onto our default pool: cross-cluster archives name
      // storages this cluster may not have. unique=1 → fresh MACs.
      const upid = await pve.restoreNewGuest({ node, vmid, volid, storage: defaultStorage }, client, kind);
      await pve.waitForTask(node, upid, client, 30 * 60 * 1000);

      // The restored config carries the OLD guest's name — apply the chosen one.
      await pve.setVmName(node, vmid, input.name, client, kind).catch(() => undefined);

      // Tenant isolation BEFORE first boot, built from the regenerated MACs.
      if (isolate) {
        const dnsServers = ((await getConfig('isolation_dns_servers')) ?? '').split(/[,\s]+/).filter(Boolean);
        await pve.configureVmIsolation(node, vmid, { dnsServers }, client, kind);
      }

      await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });
      const startUpid = await pve.startVm(node, vmid, client, kind);
      await pve.waitForTask(node, startUpid, client);
      const done = await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
      await cleanupArchive(filename, node, storage, volid);
      return done;
    } catch (err) {
      await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'error' } }).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    // Any pre-restore failure (quota, placement, extract) — drop the archive so
    // a rejected upload never lingers on the backup storage.
    await cleanupArchive(filename, nodes[0] ?? null, storage, volid);
    throw err;
  }
}
