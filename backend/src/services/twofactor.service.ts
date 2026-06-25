import { randomBytes, createHash } from 'node:crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma.js';
import { encrypt, decrypt } from '../lib/crypto.js';

const ISSUER = 'ProxMate';
const RECOVERY_CODE_COUNT = 10;

// Allow ±1 time-step (30s) for clock skew between the server and the phone.
authenticator.options = { window: 1 };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Normalize a recovery code for hashing/lookup (ignore case + separators). */
const normalize = (c: string) => c.replace(/[^a-z0-9]/gi, '').toLowerCase();

/** Begin enrollment: store a provisional (not-yet-enabled) secret; return the QR. */
export async function beginSetup(
  userId: string,
  accountLabel: string,
): Promise<{ otpauthUrl: string; secret: string; qrDataUrl: string }> {
  const secret = authenticator.generateSecret();
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorSecret: encrypt(secret), twoFactorEnabled: false },
  });
  const otpauthUrl = authenticator.keyuri(accountLabel, ISSUER, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
  return { otpauthUrl, secret, qrDataUrl };
}

/** Confirm enrollment with a code → enable 2FA and issue one-time recovery codes. */
export async function enable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.twoFactorSecret) throw new Error('Start 2FA setup first.');
  if (!authenticator.check(code, decrypt(user.twoFactorSecret))) {
    throw new Error('That code is incorrect — try again.');
  }

  const raw = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(5).toString('hex'));
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } }),
    prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
    prisma.twoFactorRecoveryCode.createMany({ data: raw.map((c) => ({ userId, codeHash: sha256(c) })) }),
  ]);
  // Display with a dash; stored hash is of the raw 10-hex string.
  return { recoveryCodes: raw.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`) };
}

/** Verify a TOTP code (login second factor). */
export async function verifyTotp(userId: string, code: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.twoFactorEnabled || !user.twoFactorSecret) return false;
  return authenticator.check(code.trim(), decrypt(user.twoFactorSecret));
}

/** Verify + consume a single-use recovery code. */
export async function verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
  const row = await prisma.twoFactorRecoveryCode.findFirst({
    where: { userId, codeHash: sha256(normalize(code)), usedAt: null },
  });
  if (!row) return false;
  await prisma.twoFactorRecoveryCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return true;
}

/** Disable 2FA — requires a valid current TOTP or recovery code. */
export async function disable(userId: string, code: string): Promise<void> {
  const ok = (await verifyTotp(userId, code)) || (await verifyRecoveryCode(userId, code));
  if (!ok) throw new Error('That code is incorrect.');
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null } }),
    prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
  ]);
}

export async function getStatus(userId: string): Promise<{ enabled: boolean; recoveryCodesLeft: number }> {
  const [user, recoveryCodesLeft] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.twoFactorRecoveryCode.count({ where: { userId, usedAt: null } }),
  ]);
  return { enabled: !!user?.twoFactorEnabled, recoveryCodesLeft };
}
