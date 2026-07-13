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

export async function getAppDbBackupConfig(): Promise<AppDbBackupConfig> {
  const dir = (await getConfig('appdb_backup_dir'))?.trim() ?? '';
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

  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, appDbBackupFileName(now));
  // VACUUM INTO snapshots a live SQLite DB consistently. The path rides inside a
  // SQL string literal — escape quotes (the path itself is admin-configured).
  await prisma.$executeRawUnsafe(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const pruned = await pruneAppDbBackups(dir, keep);
  logger.info({ file, pruned, keep }, 'app-db backup complete');
  return { ran: true, file, pruned };
}
