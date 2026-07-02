import { randomBytes, createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { isMailConfigured, sendMail } from './mail.service.js';
import { backupDownloadEmail } from '../lib/email-templates.js';

/**
 * Tenant backup downloads. Proxmox's API can't stream vzdump bytes, so this only
 * works when the admin mounts the backup share into the API container and points
 * `BACKUP_DOWNLOAD_DIR` at it. A user requests a download → we mint a single-use,
 * short-lived token and email a link → the link streams the file straight off
 * the mount. Only the token's hash is stored; the raw token lives only in the
 * email. Every filesystem access is path-traversal-hardened.
 */

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The configured backup mount, or null when the feature is disabled. */
export function backupDir(): string | null {
  const dir = process.env['BACKUP_DOWNLOAD_DIR'];
  return dir && dir.trim() ? dir.trim() : null;
}

/** Whether tenant backup downloads are available (share mounted + SMTP on). */
export async function downloadsEnabled(): Promise<boolean> {
  return backupDir() !== null && (await isMailConfigured());
}

/** A vzdump basename looks like `vzdump-qemu-104-2026_07_02-03_00_00.vma.zst`. */
const VZDUMP_RE = /^vzdump-(qemu|lxc)-\d+-[\w.-]+\.(vma|tar)(\.(zst|gz|lzo))?$/;

/** Extract the safe basename from a MateState volid, or null if it looks unsafe. */
export function filenameFromVolid(volid: string): string | null {
  // volid = "storage:backup/vzdump-qemu-104-….vma.zst" → take the part after the
  // LAST slash and validate it strictly, so nothing path-like can slip through.
  const base = volid.split('/').pop() ?? '';
  if (base !== path.basename(base)) return null; // defense-in-depth
  return VZDUMP_RE.test(base) ? base : null;
}

/**
 * Resolve a validated filename to an absolute path that is guaranteed to live
 * inside the backup mount (checks both `<dir>` and the common `<dir>/dump`
 * layout Proxmox uses). Returns null if the file isn't found or would escape.
 */
export function resolveBackupFile(filename: string): string | null {
  const dir = backupDir();
  if (!dir) return null;
  // Never trust the input as a path — reduce to a bare basename first.
  const base = path.basename(filename);
  if (base !== filename || !VZDUMP_RE.test(base)) return null;

  const roots = [dir, path.join(dir, 'dump')];
  for (const root of roots) {
    const full = path.resolve(root, base);
    // The resolved path must still sit under the intended root.
    const rel = path.relative(root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

export class DownloadError extends Error {}

/**
 * Create a download token for a MateState the caller owns and email its owner a
 * link. Requires the feature enabled and the file present on the mount. Returns
 * the recipient so the route can confirm without leaking the raw token.
 */
export async function requestBackupDownload(
  mateStateId: string,
  vmId: string,
  requester: { id: string; email: string },
  appUrl: string,
): Promise<{ emailedTo: string }> {
  if (!backupDir()) throw new DownloadError('Backup downloads are not enabled on this server.');
  if (!(await isMailConfigured())) throw new DownloadError('Email is not configured, so a download link can\'t be sent.');

  const ms = await prisma.mateState.findUnique({ where: { id: mateStateId } });
  if (!ms || ms.vmId !== vmId) throw new DownloadError('Backup not found.');
  if (ms.status !== 'ready') throw new DownloadError('This backup isn\'t ready to download yet.');

  const filename = filenameFromVolid(ms.volid);
  if (!filename) throw new DownloadError('This backup file can\'t be resolved for download.');
  if (!resolveBackupFile(filename)) {
    throw new DownloadError('The backup file isn\'t reachable on the server\'s mounted backup storage.');
  }

  const raw = randomBytes(32).toString('hex');
  await prisma.downloadToken.create({
    data: {
      tokenHash: sha256(raw),
      userId: requester.id,
      mateStateId: ms.id,
      filename,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });

  const link = `${appUrl.replace(/\/+$/, '')}/api/downloads/${raw}`;
  const { subject, text, html } = backupDownloadEmail({ vmName: '', link, filename, ttlMinutes: TOKEN_TTL_MS / 60000 });
  await sendMail({ to: requester.email, subject, text, html });
  return { emailedTo: requester.email };
}

export interface ResolvedDownload {
  fullPath: string;
  filename: string;
}

/**
 * Validate a raw download token and return the file to stream, marking the token
 * used (single-use). Throws DownloadError for anything invalid/expired/spent so
 * the route can answer with a generic 404 (no oracle for token guessing).
 */
export async function consumeDownloadToken(raw: string): Promise<ResolvedDownload> {
  if (!backupDir()) throw new DownloadError('disabled');
  const token = await prisma.downloadToken.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!token) throw new DownloadError('invalid');
  if (token.usedAt) throw new DownloadError('used');
  if (token.expiresAt.getTime() < Date.now()) throw new DownloadError('expired');

  const fullPath = resolveBackupFile(token.filename);
  if (!fullPath) throw new DownloadError('missing');

  // Mark used up-front (single-use even if the stream is interrupted).
  await prisma.downloadToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
  return { fullPath, filename: token.filename };
}

/** Prune expired/spent tokens (called opportunistically). */
export async function pruneDownloadTokens(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.downloadToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
  });
  return count;
}
