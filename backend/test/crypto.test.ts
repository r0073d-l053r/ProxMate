import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

// crypto.ts reads ENCRYPTION_KEY lazily (per call via getKey()), so setting it
// before the tests run is enough — no module-load ordering to worry about.
process.env['ENCRYPTION_KEY'] = randomBytes(32).toString('hex');

import { encrypt, decrypt } from '../src/lib/crypto.js';

describe('crypto (AES-256-GCM at-rest encryption of stored secrets)', () => {
  it('round-trips plaintext through encrypt → decrypt', () => {
    const secret = 'root@pam!proxmate=super-secret-😀-value';
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('uses a random IV — same plaintext encrypts to different ciphertext each time', () => {
    expect(encrypt('same-input')).not.toBe(encrypt('same-input'));
  });

  it('emits exactly iv:tag:ciphertext as three hex segments', () => {
    const parts = encrypt('x').split(':');
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.length > 0 && /^[0-9a-f]+$/.test(p))).toBe(true);
  });

  it('rejects a tampered ciphertext (GCM auth-tag mismatch must throw)', () => {
    const [iv, tag, ct] = encrypt('tamper-me').split(':') as [string, string, string];
    const last = ct.at(-1)!;
    const flipped = ct.slice(0, -1) + (last === '0' ? '1' : '0'); // change one nibble
    expect(() => decrypt(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const [iv, tag, ct] = encrypt('tamper-tag').split(':') as [string, string, string];
    const last = tag.at(-1)!;
    const flipped = tag.slice(0, -1) + (last === '0' ? '1' : '0');
    expect(() => decrypt(`${iv}:${flipped}:${ct}`)).toThrow();
  });

  it('throws a clear error when ENCRYPTION_KEY is not set', () => {
    const saved = process.env['ENCRYPTION_KEY'];
    delete process.env['ENCRYPTION_KEY'];
    try {
      expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY/);
    } finally {
      process.env['ENCRYPTION_KEY'] = saved;
    }
  });
});
