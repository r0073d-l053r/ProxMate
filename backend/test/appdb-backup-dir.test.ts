import { describe, it, expect } from 'vitest';
import { explainBackupDirError, isValidBackupDir } from '../src/services/appdb-backup.service.js';

/**
 * ProxMate runs in a container, so the app-DB backup directory only reaches the
 * host if it was mounted in. The raw errno ("EACCES: permission denied, mkdir
 * '/srv/backups'") sends admins off debugging HOST file permissions, which is
 * the wrong trail — this is exactly how the feature was first hit in the wild.
 * These pin the explanation, since it is the whole point of the change.
 */

const err = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: failed`), { code });

describe('explainBackupDirError', () => {
  it('explains EACCES as a container-mount problem, not a host permission one', () => {
    const m = explainBackupDirError('/srv/backups', err('EACCES'));
    expect(m).toMatch(/runs in a container/i);
    expect(m).toMatch(/mounted into it/i);
    // Must actively correct the wrong mental model that sent them here.
    expect(m).toMatch(/Creating the folder on the host is not enough/i);
    expect(m).toMatch(/DEPLOYMENT\.md/);
  });

  it('treats EPERM the same as EACCES', () => {
    expect(explainBackupDirError('/srv/backups', err('EPERM'))).toMatch(/mounted into it/i);
  });

  it('explains a missing directory without blaming permissions', () => {
    const m = explainBackupDirError('/nope', err('ENOENT'));
    expect(m).toMatch(/doesn't exist inside the ProxMate container/i);
    expect(m).not.toMatch(/permission/i);
  });

  it('names the read-only-mount case specifically', () => {
    const m = explainBackupDirError('/backups', err('EROFS'));
    expect(m).toMatch(/read-only/i);
    expect(m).toMatch(/:ro/);
  });

  it('reports a full disk as a disk problem', () => {
    expect(explainBackupDirError('/backups', err('ENOSPC'))).toMatch(/No space left/i);
  });

  it('falls back to the underlying message for anything unrecognised', () => {
    expect(explainBackupDirError('/x', new Error('kaboom'))).toMatch(/kaboom/);
  });

  it('points at the mounted directory when the admin picked an unmounted one', () => {
    // APPDB_BACKUP_DIR is unset in tests, so the generic branch must still tell
    // them the actual lever (the env var), never just "permission denied".
    expect(explainBackupDirError('/srv/backups', err('EACCES'))).toMatch(/PROXMATE_BACKUP_DIR/);
  });
});

describe('isValidBackupDir', () => {
  it('accepts empty (disabled) and absolute paths', () => {
    expect(isValidBackupDir('')).toBe(true);
    expect(isValidBackupDir('/var/backups/proxmate')).toBe(true);
  });
  it('rejects relative paths, which would resolve unpredictably in the container', () => {
    expect(isValidBackupDir('backups')).toBe(false);
    expect(isValidBackupDir('./backups')).toBe(false);
  });
});
