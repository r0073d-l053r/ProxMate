import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { getConfig, setConfig } from './config.service.js';
import { logger } from '../lib/logger.js';

/**
 * Scheduled backups of ProxMate's OWN database (users, VM records, config,
 * encrypted secrets) — MateStates cover the guests, but until now the app DB
 * itself was only ever backed up by hand. A nightly `VACUUM INTO` writes a
 * consistent snapshot of the LIVE SQLite database (safe under concurrent
 * writers) into an admin-configured directory — point it at an off-host mount
 * (NFS/CIFS) so a dead host doesn't take the backups with it. Rolling
 * retention prunes old snapshots by filename (timestamps sort lexically).
 *
 * NOTE: the snapshot contains the same AES-256-GCM-encrypted secrets as the
 * live DB — restoring it needs the SAME `ENCRYPTION_KEY`. Back that key up
 * separately (see DEPLOYMENT.md); a DB backup without the key can't decrypt
 * the Proxmox token, SMTP creds, or tenant AI keys.
 */

/** Snapshot filename — UTC timestamp so lexical order == chronological order. */
export function appDbBackupFileName(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `proxmate-appdb-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}.db`
  );
}

/** Only files WE wrote are ever pruned — anything else in the dir is untouched. */
export const APPDB_BACKUP_FILE_RE = /^proxmate-appdb-\d{8}-\d{6}\.db$/;

export interface AppDbBackupConfig {
  /** Absolute directory snapshots are written to. Empty = backups disabled. */
  dir: string;
  /** Rolling retention — how many snapshots to keep (1..365). */
  keep: number;
}

const KEEP_DEFAULT = 7;

/**
 * The container-side directory the compose file mounts a host directory onto
 * (`PROXMATE_BACKUP_DIR` in `.env` chooses the host side). Used as the default
 * target so backups work out of the box instead of requiring the admin to
 * discover that only mounted paths are writable.
 */
export const DEFAULT_BACKUP_DIR = process.env['APPDB_BACKUP_DIR']?.trim() || '';

export async function getAppDbBackupConfig(): Promise<AppDbBackupConfig> {
  const stored = (await getConfig('appdb_backup_dir'))?.trim();
  // `null` = never configured -> fall back to the mounted default. An explicit
  // empty string is the admin deliberately turning backups OFF, and must not be
  // silently re-enabled by the default.
  const dir = stored === undefined || stored === null ? DEFAULT_BACKUP_DIR : stored;
  const keepRaw = Number(await getConfig('appdb_backup_keep'));
  const keep = Number.isInteger(keepRaw) && keepRaw >= 1 && keepRaw <= 365 ? keepRaw : KEEP_DEFAULT;
  return { dir, keep };
}

export async function saveAppDbBackupConfig(data: { dir: string; keep: number }): Promise<void> {
  await setConfig('appdb_backup_dir', data.dir.trim());
  await setConfig('appdb_backup_keep', String(data.keep));
}

/** Valid target dir: empty (disabled) or an absolute path (no relative surprises). */
export function isValidBackupDir(dir: string): boolean {
  const s = dir.trim();
  return s === '' || path.isAbsolute(s);
}

/**
 * Turn a filesystem failure on the backup directory into something an admin can
 * act on.
 *
 * ProxMate runs in a container, so a path only reaches the host if it was
 * MOUNTED IN — and creating the directory on the host does nothing by itself.
 * The raw errors here ("EACCES: permission denied, mkdir '/srv/backups'") send
 * people off chasing host file permissions, which is the wrong trail entirely
 * and is exactly how this was first hit in the wild.
 *
 * Deliberately does NOT try to widen permissions or fall back to a writable
 * container path: a backup written inside the container's own layer looks like
 * it worked and then disappears on the next rebuild, which is worse than a
 * loud failure.
 */
export function explainBackupDirError(dir: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  const mounted = DEFAULT_BACKUP_DIR;
  const hint =
    mounted && !dir.startsWith(mounted)
      ? ` The directory mounted into this container is "${mounted}" — use it, or a folder inside it.`
      : ' Mount a host directory into the backend container (set PROXMATE_BACKUP_DIR in .env) and point this at it.';

  if (code === 'EACCES' || code === 'EPERM') {
    return (
      `Can't write to "${dir}" — ProxMate runs in a container and can only write to paths mounted into it. ` +
      `Creating the folder on the host is not enough on its own.${hint} See DEPLOYMENT.md "App-database backups".`
    );
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return (
      `"${dir}" doesn't exist inside the ProxMate container and couldn't be created.${hint} ` +
      `See DEPLOYMENT.md "App-database backups".`
    );
  }
  if (code === 'EROFS') {
    return `"${dir}" is mounted read-only into the container. Mount it read-write (drop the ":ro" suffix).${hint}`;
  }
  if (code === 'ENOSPC') return `No space left on the device holding "${dir}".`;
  return `Couldn't write to "${dir}": ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Delete our oldest snapshots beyond `keep`. Filename-scoped (APPDB_BACKUP_FILE_RE)
 * so an admin's other files in the same directory can never be collateral.
 */
export async function pruneAppDbBackups(dir: string, keep: number): Promise<number> {
  const entries = await fsp.readdir(dir);
  const mine = entries.filter((f) => APPDB_BACKUP_FILE_RE.test(f)).sort();
  const excess = mine.slice(0, Math.max(0, mine.length - keep));
  for (const f of excess) await fsp.unlink(path.join(dir, f));
  return excess.length;
}

export interface AppDbBackupResult {
  ran: boolean;
  file?: string;
  pruned?: number;
  reason?: string;
}

/**
 * Take one snapshot now (scheduler tick or the admin "Back up now" button).
 * A no-op with a reason while unconfigured, so the scheduled tick is free to
 * fire unconditionally.
 */
export async function runAppDbBackup(now: Date = new Date()): Promise<AppDbBackupResult> {
  const { dir, keep } = await getAppDbBackupConfig();
  if (!dir) return { ran: false, reason: 'disabled — no backup directory configured' };
  if (!isValidBackupDir(dir)) return { ran: false, reason: `not an absolute path: ${dir}` };

  // Create + prove writability BEFORE the VACUUM, so a misconfigured directory
  // fails with an explanation instead of a raw errno from deep inside SQLite.
  try {
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.proxmate-write-test-${process.pid}`);
    await fsp.writeFile(probe, '');
    await fsp.unlink(probe);
  } catch (err) {
    const reason = explainBackupDirError(dir, err);
    logger.warn({ dir, err }, 'app-db backup target is not writable');
    return { ran: false, reason };
  }

  const file = path.join(dir, appDbBackupFileName(now));
  // VACUUM INTO snapshots a live SQLite DB consistently. The path rides inside a
  // SQL string literal — escape quotes (the path itself is admin-configured).
  await prisma.$executeRawUnsafe(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const pruned = await pruneAppDbBackups(dir, keep);
  logger.info({ file, pruned, keep }, 'app-db backup complete');
  return { ran: true, file, pruned };
}
