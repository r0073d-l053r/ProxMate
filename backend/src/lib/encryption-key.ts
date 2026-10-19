import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type EnsureKeyResult = { generated: false } | { generated: true; savedTo: string };

const KEY_LINE = /^[ \t]*ENCRYPTION_KEY[ \t]*=.*$/m;

/**
 * Make sure ENCRYPTION_KEY is set before anything stores a secret.
 *
 * Every stored secret (JWT secret, Proxmox token, SMTP, TOTP, SSO) is encrypted
 * with this key, so a key that exists only in memory bricks the install on the
 * next restart: the new run generates a different key and can decrypt nothing.
 * A key is therefore only generated when it can be persisted — into an existing
 * .env in the working directory, outside production — and otherwise the server
 * refuses to start with instructions instead of running on a throwaway key.
 *
 * Throws (with an operator-facing message) when it cannot proceed safely.
 */
export function ensureEncryptionKey(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): EnsureKeyResult {
  if (env['ENCRYPTION_KEY']) return { generated: false };

  const howTo =
    'Generate one with `openssl rand -hex 32`, set it as ENCRYPTION_KEY (environment or .env) ' +
    'and keep a copy off this host — it must stay the same for the life of the database.';
  if (env['NODE_ENV'] === 'production') {
    throw new Error(`ENCRYPTION_KEY is not set. Refusing to start in production without it. ${howTo}`);
  }
  const envPath = resolve(cwd, '.env');
  if (!existsSync(envPath)) {
    throw new Error(
      `ENCRYPTION_KEY is not set and there is no ${envPath} to save a generated one to, ` +
        `so it would be lost on restart along with every secret encrypted under it. ${howTo}`,
    );
  }

  const key = randomBytes(32).toString('hex');
  let content = readFileSync(envPath, 'utf8');
  if (KEY_LINE.test(content)) {
    content = content.replace(KEY_LINE, `ENCRYPTION_KEY=${key}`);
  } else {
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    content += `ENCRYPTION_KEY=${key}\n`;
  }
  writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 });
  // `mode` only applies when the file is created; tighten an existing one too.
  chmodSync(envPath, 0o600);
  env['ENCRYPTION_KEY'] = key;
  return { generated: true, savedTo: envPath };
}
