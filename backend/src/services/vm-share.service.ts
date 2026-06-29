import { prisma } from '../lib/prisma.js';

/** A VM-sharing error with an HTTP status the route can surface directly. */
export class ShareError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const SHARE_ROLES = ['co-owner', 'read-only'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export interface ShareView {
  id: string;
  role: string;
  createdAt: string;
  user: { id: string; email: string; displayName: string };
}

const userSelect = { select: { id: true, email: true, displayName: true } } as const;

const toView = (s: {
  id: string;
  role: string;
  createdAt: Date;
  user: { id: string; email: string; displayName: string };
}): ShareView => ({ id: s.id, role: s.role, createdAt: s.createdAt.toISOString(), user: s.user });

/** Everyone a VM is shared with, oldest first. */
export async function listShares(vmId: string): Promise<ShareView[]> {
  const shares = await prisma.vmShare.findMany({
    where: { vmId },
    orderBy: { createdAt: 'asc' },
    include: { user: userSelect },
  });
  return shares.map(toView);
}

/**
 * Share a VM with an existing user (by email). Re-sharing the same user just
 * updates their role. Throws {@link ShareError} for the known failure cases.
 */
export async function addShare(vm: { id: string; userId: string }, email: string, role: ShareRole): Promise<ShareView> {
  const target = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!target) throw new ShareError('No ProxMate user with that email. They need an account first.', 404);
  if (target.id === vm.userId) throw new ShareError('That user already owns this VM.', 400);

  const share = await prisma.vmShare.upsert({
    where: { vmId_userId: { vmId: vm.id, userId: target.id } },
    create: { vmId: vm.id, userId: target.id, role },
    update: { role },
    include: { user: userSelect },
  });
  return toView(share);
}

/** Revoke a share. Returns false if it doesn't belong to this VM. */
export async function removeShare(vmId: string, shareId: string): Promise<boolean> {
  const share = await prisma.vmShare.findFirst({ where: { id: shareId, vmId } });
  if (!share) return false;
  await prisma.vmShare.delete({ where: { id: share.id } });
  return true;
}
