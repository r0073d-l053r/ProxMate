import { prisma } from '../lib/prisma.js';

/** Does the user already have a usable second factor (TOTP enabled or a passkey)? */
export async function hasMfaMethod(userId: string): Promise<boolean> {
  const [user, passkeyCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } }),
    prisma.passkey.count({ where: { userId } }),
  ]);
  return !!user?.twoFactorEnabled || passkeyCount > 0;
}

/**
 * True when an admin required 2FA for this user (via their invite) but they
 * haven't set up a method yet. SSO-linked users are exempt — their identity
 * provider handles the second factor.
 */
export async function isMfaSetupRequired(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { require2fa: true, ssoSubject: true, twoFactorEnabled: true },
  });
  if (!user || !user.require2fa || user.ssoSubject || user.twoFactorEnabled) return false;
  return (await prisma.passkey.count({ where: { userId } })) === 0;
}
