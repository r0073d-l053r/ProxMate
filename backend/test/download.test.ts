import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { downloadToken: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock('../src/services/mail.service.js', () => ({ isMailConfigured: vi.fn(async () => true), sendMail: vi.fn() }));

import { prisma } from '../src/lib/prisma.js';
import {
  filenameFromVolid,
  resolveBackupFile,
  consumeDownloadToken,
  backupDir,
  DownloadError,
} from '../src/services/download.service.js';
import { createHash } from 'node:crypto';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// A real temp "mount" with a fake vzdump file under dump/.
const root = mkdtempSync(path.join(tmpdir(), 'pm-backups-'));
mkdirSync(path.join(root, 'dump'));
const VALID = 'vzdump-qemu-104-2026_07_02-03_00_00.vma.zst';
writeFileSync(path.join(root, 'dump', VALID), 'FAKE-BACKUP-BYTES');
// A secret file OUTSIDE the mount that traversal must never reach.
const secret = path.join(root, '..', `pm-secret-${Date.now()}.txt`);
writeFileSync(secret, 'TOP SECRET');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(secret, { force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env['BACKUP_DOWNLOAD_DIR'] = root;
});

describe('filenameFromVolid', () => {
  it('extracts the vzdump basename from a volid', () => {
    expect(filenameFromVolid(`backup-nfs:backup/${VALID}`)).toBe(VALID);
    expect(filenameFromVolid(`local:backup/vzdump-lxc-201-2026_01_01-00_00_00.tar.zst`)).toBe(
      'vzdump-lxc-201-2026_01_01-00_00_00.tar.zst',
    );
  });

  it('rejects anything that is not a well-formed vzdump name', () => {
    expect(filenameFromVolid('local:backup/../../etc/passwd')).toBeNull();
    expect(filenameFromVolid('local:backup/random.txt')).toBeNull();
    expect(filenameFromVolid('local:backup/vzdump-qemu-104.evil.sh')).toBeNull();
  });
});

describe('resolveBackupFile (path-traversal hardening)', () => {
  it('resolves a valid vzdump file under the mount (dump/ layout)', () => {
    const full = resolveBackupFile(VALID);
    expect(full).toBe(path.resolve(root, 'dump', VALID));
  });

  it('returns null for a traversal attempt', () => {
    expect(resolveBackupFile('../pm-secret.txt')).toBeNull();
    expect(resolveBackupFile('..%2f..%2fetc%2fpasswd')).toBeNull();
    expect(resolveBackupFile('/etc/passwd')).toBeNull();
  });

  it('returns null when the file does not exist', () => {
    expect(resolveBackupFile('vzdump-qemu-999-2026_07_02-03_00_00.vma.zst')).toBeNull();
  });

  it('is disabled when BACKUP_DOWNLOAD_DIR is unset', () => {
    delete process.env['BACKUP_DOWNLOAD_DIR'];
    expect(backupDir()).toBeNull();
    expect(resolveBackupFile(VALID)).toBeNull();
  });
});

describe('consumeDownloadToken (single-use + expiry)', () => {
  const raw = 'a'.repeat(64);
  const baseToken = () => ({ id: 'tok1', tokenHash: sha256(raw), filename: VALID, usedAt: null, expiresAt: new Date(Date.now() + 60_000) });

  it('returns the file and marks the token used', async () => {
    vi.mocked(prisma.downloadToken.findUnique).mockResolvedValue(baseToken() as never);
    const r = await consumeDownloadToken(raw);
    expect(r.filename).toBe(VALID);
    expect(prisma.downloadToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tok1' }, data: expect.objectContaining({ usedAt: expect.any(Date) }) }),
    );
  });

  it('rejects an unknown token', async () => {
    vi.mocked(prisma.downloadToken.findUnique).mockResolvedValue(null as never);
    await expect(consumeDownloadToken(raw)).rejects.toBeInstanceOf(DownloadError);
  });

  it('rejects an already-used token', async () => {
    vi.mocked(prisma.downloadToken.findUnique).mockResolvedValue({ ...baseToken(), usedAt: new Date() } as never);
    await expect(consumeDownloadToken(raw)).rejects.toThrow(/used/);
    expect(prisma.downloadToken.update).not.toHaveBeenCalled();
  });

  it('rejects an expired token', async () => {
    vi.mocked(prisma.downloadToken.findUnique).mockResolvedValue({ ...baseToken(), expiresAt: new Date(Date.now() - 1000) } as never);
    await expect(consumeDownloadToken(raw)).rejects.toThrow(/expired/);
  });
});
