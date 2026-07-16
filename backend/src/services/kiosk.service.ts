import { getConfig, setConfig } from './config.service.js';
import { hashPassword, verifyPassword } from './auth.service.js';

/**
 * Kiosk exit lock. Kiosk mode is a full-screen, unattended admin panel on a
 * physical display (a rack Pi). To leave it, a human at the panel must re-auth
 * — passkey (WebAuthn, handled by the normal passkey routes) or this PIN — so a
 * passer-by can't tap out of the panel into the full admin console. The PIN is
 * an admin-set convenience for touch panels; it is stored ONLY as a bcrypt hash
 * (never returned), like an account password.
 */
const KIOSK_PIN_KEY = 'kiosk_exit_pin';

/** A kiosk PIN: 4–12 digits. Long enough not to be a 3-guess space, short
 *  enough to punch on a touch keypad. Empty string clears the lock. */
export function isValidKioskPin(pin: string): boolean {
  return /^[0-9]{4,12}$/.test(pin);
}

/** Whether an exit PIN is currently configured (drives the settings UI + the
 *  kiosk unlock dialog — never exposes the value). */
export async function isKioskPinSet(): Promise<boolean> {
  return !!(await getConfig(KIOSK_PIN_KEY));
}

/** Set (or change) the exit PIN. `''` clears it. Caller validates the format. */
export async function setKioskPin(pin: string): Promise<void> {
  const trimmed = pin.trim();
  if (trimmed === '') {
    await setConfig(KIOSK_PIN_KEY, '');
    return;
  }
  await setConfig(KIOSK_PIN_KEY, await hashPassword(trimmed), true);
}

/** Verify an entered PIN against the stored hash. False if no PIN is set (an
 *  unset PIN must never verify — that path is gated by isKioskPinSet upstream). */
export async function verifyKioskPin(pin: string): Promise<boolean> {
  const hash = await getConfig(KIOSK_PIN_KEY);
  if (!hash) return false;
  return verifyPassword(pin, hash);
}
