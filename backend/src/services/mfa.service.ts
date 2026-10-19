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
 * haven't set up a method yet.
 *
 * By default SSO-linked users are exempt: for a session that came through the
 * identity provider, the IdP handles the second factor. That reasoning does not
 * hold for the local password login (and the enrollment token it hands out),
 * which never touches the IdP, so those callers pass `ssoExempt: false`.
 */
export async function isMfaSetupRequired(
  userId: string,
  { ssoExempt = true }: { ssoExempt?: boolean } = {},
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { require2fa: true, ssoSubject: true, twoFactorEnabled: true },
  });
  if (!user || !user.require2fa || user.twoFactorEnabled) return false;
  if (ssoExempt && user.ssoSubject) return false;
  return (await prisma.passkey.count({ where: { userId } })) === 0;
}
