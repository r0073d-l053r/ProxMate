import { createHmac } from 'node:crypto';
import { getConfig, setConfig } from './config.service.js';
import { recordAudit, type AuditActor } from './audit.service.js';

// ─── ENCRYPTION_KEY backup confirmation ───────────────────────
//
// Every stored secret is encrypted with ENCRYPTION_KEY, and an app-database
// backup is useless without it. Admins see a warning until one of them confirms
// the key has been copied somewhere safe off this host. The confirmation records
// who and when, plus a fingerprint of the key it was made for (an HMAC keyed by
// the key itself — it reveals nothing about the key), so a changed key brings the
// warning back. The key itself is never returned or displayed.

const CONFIRM_KEY = 'encryption_key_backup_confirmed';

interface StoredConfirmation {
  at: string;
  by: string | null;
  userId: string;
  fingerprint: string;
}

export interface KeyBackupStatus {
  /** An admin confirmed a backup of the key this server runs with now. */
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedBy: string | null;
  /** A confirmation exists, but for a different key than the current one. */
  keyChanged: boolean;
}

/** A non-reversible fingerprint of the current key (null when none is set). */
export function keyFingerprint(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env['ENCRYPTION_KEY'];
  if (!key) return null;
  return createHmac('sha256', key).update('proxmate:encryption-key-backup').digest('hex').slice(0, 16);
}

async function readConfirmation(): Promise<StoredConfirmation | null> {
  const raw = await getConfig(CONFIRM_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredConfirmation>;
    if (typeof parsed.at !== 'string' || typeof parsed.fingerprint !== 'string') return null;
    return {
      at: parsed.at,
      by: typeof parsed.by === 'string' ? parsed.by : null,
      userId: String(parsed.userId ?? ''),
      fingerprint: parsed.fingerprint,
    };
  } catch {
    return null;
  }
}

export async function getKeyBackupStatus(): Promise<KeyBackupStatus> {
  const c = await readConfirmation();
  const fp = keyFingerprint();
  const confirmed = !!c && !!fp && c.fingerprint === fp;
  return {
    confirmed,
    confirmedAt: c?.at ?? null,
    confirmedBy: c?.by ?? null,
    keyChanged: !!c && !confirmed,
  };
}

/** Record that `actor` has backed up the current key (audited). */
export async function confirmKeyBackup(
  actor: AuditActor,
  req?: Parameters<typeof recordAudit>[0]['req'],
): Promise<KeyBackupStatus> {
  const fingerprint = keyFingerprint();
  if (!fingerprint) throw new Error('ENCRYPTION_KEY is not set');
  const entry: StoredConfirmation = {
    at: new Date().toISOString(),
    by: actor.email ?? null,
    userId: actor.id,
    fingerprint,
  };
  await setConfig(CONFIRM_KEY, JSON.stringify(entry));
  await recordAudit({
    action: 'admin.encryption_key_backup_confirmed',
    actor,
    detail: 'confirmed ENCRYPTION_KEY is backed up off this host',
    req,
  });
  return getKeyBackupStatus();
}
