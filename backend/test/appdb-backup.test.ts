import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// In-memory SystemConfig + a captured prisma raw-SQL call — the real fs is used
// for prune tests (temp dirs), since the retention logic IS filesystem behavior.
const store = new Map<string, string>();
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
  setConfig: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  }),
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $executeRawUnsafe: vi.fn().mockResolvedValue(0) },
}));

import { prisma } from '../src/lib/prisma.js';
import {
  appDbBackupFileName,
  APPDB_BACKUP_FILE_RE,
  getAppDbBackupConfig,
  saveAppDbBackupConfig,
  isValidBackupDir,
  pruneAppDbBackups,
  runAppDbBackup,
} from '../src/services/appdb-backup.service.js';

const rawExec = vi.mocked(prisma.$executeRawUnsafe);

beforeEach(() => {
  vi.clearAllMocks();
  rawExec.mockResolvedValue(0 as never);
  store.clear();
});

async function tmpDir(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'pm-appdb-'));
}

describe('appdb-backup — filenames + config', () => {
  it('filenames are UTC-stamped and sort chronologically', () => {
    const a = appDbBackupFileName(new Date('2026-07-12T02:30:00Z'));
    const b = appDbBackupFileName(new Date('2026-07-13T02:30:00Z'));
    expect(a).toBe('proxmate-appdb-20260712-023000.db');
    expect(APPDB_BACKUP_FILE_RE.test(a)).toBe(true);
    expect([b, a].sort()).toEqual([a, b]);
  });

  it('config defaults: disabled, keep 7; round-trips through save', async () => {
    expect(await getAppDbBackupConfig()).toEqual({ dir: '', keep: 7 });
    await saveAppDbBackupConfig({ dir: ' /backups/proxmate ', keep: 14 });
    expect(await getAppDbBackupConfig()).toEqual({ dir: '/backups/proxmate', keep: 14 });
  });

  it('garbage keep values fall back to 7', async () => {
    store.set('appdb_backup_keep', 'lots');
    expect((await getAppDbBackupConfig()).keep).toBe(7);
    store.set('appdb_backup_keep', '0');
    expect((await getAppDbBackupConfig()).keep).toBe(7);
    store.set('appdb_backup_keep', '9999');
    expect((await getAppDbBackupConfig()).keep).toBe(7);
  });

  it('isValidBackupDir: empty or absolute only', () => {
    expect(isValidBackupDir('')).toBe(true);
    expect(isValidBackupDir('  ')).toBe(true);
    expect(isValidBackupDir('/backups/proxmate')).toBe(true);
    expect(isValidBackupDir('relative/path')).toBe(false);
    expect(isValidBackupDir('./sneaky')).toBe(false);
    expect(isValidBackupDir('../parent')).toBe(false);
  });
});

describe('appdb-backup — retention pruning', () => {
  it('keeps the newest N of OUR files and never touches foreign files', async () => {
    const dir = await tmpDir();
    const mine = [
      'proxmate-appdb-20260701-020000.db',
      'proxmate-appdb-20260702-020000.db',
      'proxmate-appdb-20260703-020000.db',
      'proxmate-appdb-20260704-020000.db',
    ];
    const foreign = ['notes.txt', 'proxmate-db-pre-v0.8.tgz', 'appdb-manual-copy.db'];
    for (const f of [...mine, ...foreign]) await fsp.writeFile(path.join(dir, f), 'x');

    const pruned = await pruneAppDbBackups(dir, 2);
    expect(pruned).toBe(2);
    const left = (await fsp.readdir(dir)).sort();
    expect(left).toEqual([...foreign, mine[2], mine[3]].sort());
  });

  it('prunes nothing when at or under the cap', async () => {
    const dir = await tmpDir();
    await fsp.writeFile(path.join(dir, 'proxmate-appdb-20260701-020000.db'), 'x');
    expect(await pruneAppDbBackups(dir, 2)).toBe(0);
  });
});

describe('appdb-backup — runAppDbBackup', () => {
  it('is a described no-op while unconfigured (the nightly tick is free to fire)', async () => {
    const r = await runAppDbBackup();
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/no backup directory/i);
    expect(rawExec).not.toHaveBeenCalled();
  });

  it('refuses a non-absolute configured dir', async () => {
    store.set('appdb_backup_dir', 'relative/dir');
    const r = await runAppDbBackup();
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/absolute/i);
    expect(rawExec).not.toHaveBeenCalled();
  });

  it('VACUUMs INTO a timestamped file in the configured dir and prunes to keep', async () => {
    const dir = await tmpDir();
    store.set('appdb_backup_dir', dir);
    store.set('appdb_backup_keep', '1');
    // Pre-existing old snapshots — the new run should prune down to keep=1.
    await fsp.writeFile(path.join(dir, 'proxmate-appdb-20260101-000000.db'), 'x');
    await fsp.writeFile(path.join(dir, 'proxmate-appdb-20260102-000000.db'), 'x');

    const now = new Date('2026-07-12T02:30:00Z');
    const r = await runAppDbBackup(now);
    expect(r.ran).toBe(true);
    expect(r.file).toBe(path.join(dir, 'proxmate-appdb-20260712-023000.db'));
    expect(rawExec).toHaveBeenCalledTimes(1);
    const sql = String(rawExec.mock.calls[0]?.[0]);
    expect(sql.startsWith('VACUUM INTO ')).toBe(true);
    expect(sql).toContain('proxmate-appdb-20260712-023000.db');
    // The mocked VACUUM wrote no real file, so 2 snapshots exist on disk;
    // keep=1 prunes the older one and the newest survives.
    expect(r.pruned).toBe(1);
    expect(await fsp.readdir(dir)).toEqual(['proxmate-appdb-20260102-000000.db']);
  });

  it("escapes single quotes in the path so the SQL literal can't break", async () => {
    const base = await tmpDir();
    const dir = path.join(base, "o'brien");
    store.set('appdb_backup_dir', dir);
    const r = await runAppDbBackup(new Date('2026-07-12T02:30:00Z'));
    expect(r.ran).toBe(true);
    const sql = String(rawExec.mock.calls[0]?.[0]);
    expect(sql).toContain("o''brien");
  });
});
