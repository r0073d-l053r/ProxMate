import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory SystemConfig so we exercise the real kiosk.service (bcrypt hashing)
// without prisma. auth.service's hashPassword/verifyPassword are real bcrypt and
// touch no DB, so a stubbed prisma is enough to import the chain.
const store = new Map<string, string>();
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
  setConfig: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  }),
}));

import { isValidKioskPin, isKioskPinSet, setKioskPin, verifyKioskPin } from '../src/services/kiosk.service.js';

beforeEach(() => store.clear());

describe('isValidKioskPin', () => {
  it('accepts 4–12 digit PINs', () => {
    for (const ok of ['0000', '1234', '000000', '123456789012']) expect(isValidKioskPin(ok), ok).toBe(true);
  });
  it('rejects too short, too long, and non-numeric', () => {
    for (const bad of ['', '123', '1234567890123', '12a4', '12 34', 'abcd', '1234\n']) {
      expect(isValidKioskPin(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('kiosk exit PIN — set / clear / verify', () => {
  it('starts unset; verify never succeeds while unset', async () => {
    expect(await isKioskPinSet()).toBe(false);
    expect(await verifyKioskPin('1234')).toBe(false);
  });

  it('stores only a hash (never the plaintext PIN)', async () => {
    await setKioskPin('4826');
    const stored = store.get('kiosk_exit_pin')!;
    expect(stored).not.toContain('4826');
    expect(stored.startsWith('$2')).toBe(true); // bcrypt
    expect(await isKioskPinSet()).toBe(true);
  });

  it('verifies the correct PIN and rejects wrong ones', async () => {
    await setKioskPin('4826');
    expect(await verifyKioskPin('4826')).toBe(true);
    expect(await verifyKioskPin('4827')).toBe(false);
    expect(await verifyKioskPin('')).toBe(false);
  });

  it('an empty string clears the lock (and then nothing verifies)', async () => {
    await setKioskPin('4826');
    expect(await isKioskPinSet()).toBe(true);
    await setKioskPin('');
    expect(await isKioskPinSet()).toBe(false);
    expect(await verifyKioskPin('4826')).toBe(false);
  });

  it('changing the PIN invalidates the old one', async () => {
    await setKioskPin('1111');
    await setKioskPin('2222');
    expect(await verifyKioskPin('1111')).toBe(false);
    expect(await verifyKioskPin('2222')).toBe(true);
  });
});
