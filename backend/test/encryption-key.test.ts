import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureEncryptionKey } from '../src/lib/encryption-key.js';

// Boot-time ENCRYPTION_KEY handling. A key that only lives in memory makes every
// secret stored during that run undecryptable after the next restart, so the
// server must either persist a generated key or refuse to start.

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'pm-enckey-'));
const HEX64 = /^[0-9a-f]{64}$/;

describe('ensureEncryptionKey', () => {
  it('leaves an existing key alone', () => {
    const env: NodeJS.ProcessEnv = { ENCRYPTION_KEY: 'a'.repeat(64) };
    expect(ensureEncryptionKey(env, tmp())).toEqual({ generated: false });
    expect(env.ENCRYPTION_KEY).toBe('a'.repeat(64));
  });

  it('refuses to start when there is no .env to persist a generated key to', () => {
    const dir = tmp();
    const env: NodeJS.ProcessEnv = {};
    expect(() => ensureEncryptionKey(env, dir)).toThrow(/ENCRYPTION_KEY/);
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('refuses to start in production even when a .env exists', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, '.env'), 'PORT=4000\n');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    expect(() => ensureEncryptionKey(env, dir)).toThrow(/ENCRYPTION_KEY/);
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe('PORT=4000\n');
  });

  it('treats an empty key like a missing one', () => {
    const env: NodeJS.ProcessEnv = { ENCRYPTION_KEY: '' };
    expect(() => ensureEncryptionKey(env, tmp())).toThrow(/ENCRYPTION_KEY/);
  });

  it('in development, generates a key, persists it to .env (0600) and reports where', () => {
    const dir = tmp();
    const file = path.join(dir, '.env');
    writeFileSync(file, 'PORT=4000');
    chmodSync(file, 0o644);
    const env: NodeJS.ProcessEnv = {};
    const r = ensureEncryptionKey(env, dir);
    expect(r).toEqual({ generated: true, savedTo: file });
    expect(env.ENCRYPTION_KEY).toMatch(HEX64);
    expect(readFileSync(file, 'utf8')).toBe(`PORT=4000\nENCRYPTION_KEY=${env.ENCRYPTION_KEY}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('fills an empty ENCRYPTION_KEY= line in place', () => {
    const dir = tmp();
    const file = path.join(dir, '.env');
    writeFileSync(file, 'ENCRYPTION_KEY=\nPORT=4000\n');
    const env: NodeJS.ProcessEnv = { ENCRYPTION_KEY: '' };
    ensureEncryptionKey(env, dir);
    expect(readFileSync(file, 'utf8')).toBe(`ENCRYPTION_KEY=${env.ENCRYPTION_KEY}\nPORT=4000\n`);
  });

  it('does not mistake a commented-out key for the real line', () => {
    const dir = tmp();
    const file = path.join(dir, '.env');
    writeFileSync(file, '# ENCRYPTION_KEY=<openssl rand -hex 32>\n');
    const env: NodeJS.ProcessEnv = {};
    ensureEncryptionKey(env, dir);
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('# ENCRYPTION_KEY=<openssl rand -hex 32>\n');
    expect(content).toContain(`\nENCRYPTION_KEY=${env.ENCRYPTION_KEY}\n`);
  });
});
