import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const config: Record<string, string> = {};
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (k: string) => config[k] ?? null),
  setConfig: vi.fn(async (k: string, v: string) => {
    config[k] = v;
  }),
}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));

import { recordAudit } from '../src/services/audit.service.js';
import { getKeyBackupStatus, confirmKeyBackup, keyFingerprint } from '../src/services/key-backup.service.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
let saved: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(config)) delete config[k];
  saved = process.env['ENCRYPTION_KEY'];
  process.env['ENCRYPTION_KEY'] = KEY_A;
});
afterEach(() => {
  if (saved === undefined) delete process.env['ENCRYPTION_KEY'];
  else process.env['ENCRYPTION_KEY'] = saved;
});

describe('ENCRYPTION_KEY backup confirmation', () => {
  it('is unconfirmed until an admin confirms', async () => {
    expect(await getKeyBackupStatus()).toEqual({ confirmed: false, confirmedAt: null, confirmedBy: null, keyChanged: false });
  });

  it('stores who and when, audits it, and never stores or returns the key', async () => {
    const status = await confirmKeyBackup({ id: 'admin1', email: 'admin@example.com' });
    expect(status).toMatchObject({ confirmed: true, confirmedBy: 'admin@example.com', keyChanged: false });
    expect(typeof status.confirmedAt).toBe('string');
    expect(JSON.stringify(status)).not.toContain(KEY_A);
    expect(config['encryption_key_backup_confirmed']).not.toContain(KEY_A);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.encryption_key_backup_confirmed', actor: { id: 'admin1', email: 'admin@example.com' } }),
    );
  });

  it('asks again once the server runs with a different key', async () => {
    await confirmKeyBackup({ id: 'admin1', email: 'admin@example.com' });
    process.env['ENCRYPTION_KEY'] = KEY_B;
    expect(await getKeyBackupStatus()).toMatchObject({ confirmed: false, keyChanged: true });
  });

  it('fingerprints the key without revealing it', () => {
    const fp = keyFingerprint({ ENCRYPTION_KEY: KEY_A });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toBe(keyFingerprint({ ENCRYPTION_KEY: KEY_B }));
    expect(KEY_A).not.toContain(fp!);
    expect(keyFingerprint({})).toBeNull();
  });

  it('treats a malformed stored value as unconfirmed', async () => {
    config['encryption_key_backup_confirmed'] = '{not json';
    expect((await getKeyBackupStatus()).confirmed).toBe(false);
  });
});
