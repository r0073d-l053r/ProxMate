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

// ─── Capability model (owner decision 2026-07-11) ─────────────────────────────
// Shares grant a PRESET LEVEL, stored as its name in VmShare.role; code derives
// the capability set from CAPS_BY_ROLE (single source of truth), so presets can
// evolve — and a future granular "custom" role can be added — without a data
// migration. No share ever deletes/destroys the VM, migrates it, manages shares,
// requests passthrough, or rebuilds (re-images) it: that whole surface stays
// owner/admin-only via getOwnedVm.

export const VM_CAPS = ['view', 'power', 'console', 'configure', 'backups', 'ide'] as const;
export type VmCap = (typeof VM_CAPS)[number];

export const SHARE_ROLES = ['viewer', 'operator', 'manager'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export const CAPS_BY_ROLE: Record<ShareRole, ReadonlySet<VmCap>> = {
  viewer: new Set<VmCap>(['view']),
  operator: new Set<VmCap>(['view', 'power', 'console']),
  manager: new Set<VmCap>(['view', 'power', 'console', 'configure', 'backups', 'ide']),
};

/** Every capability — what owners/admins hold. */
export const ALL_CAPS: ReadonlySet<VmCap> = CAPS_BY_ROLE.manager;

/**
 * Map any stored role string to a current preset. Legacy rows ('co-owner' →
 * manager, 'read-only' → viewer) are normalized here as defense-in-depth beside
 * the data migration (a restored old backup must not grant surprise access —
 * unknown strings fall to viewer, the least-privileged preset).
 */
export function normalizeShareRole(role: string): ShareRole {
  if ((SHARE_ROLES as readonly string[]).includes(role)) return role as ShareRole;
  if (role === 'co-owner') return 'manager';
  return 'viewer';
}

export function capsForShareRole(role: string): ReadonlySet<VmCap> {
  return CAPS_BY_ROLE[normalizeShareRole(role)];
}

export interface ShareView {
  id: string;
  role: ShareRole;
  createdAt: string;
  user: { id: string; email: string; displayName: string };
}

const userSelect = { select: { id: true, email: true, displayName: true } } as const;

const toView = (s: {
  id: string;
  role: string;
  createdAt: Date;
  user: { id: string; email: string; displayName: string };
}): ShareView => ({ id: s.id, role: normalizeShareRole(s.role), createdAt: s.createdAt.toISOString(), user: s.user });

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
 * updates their preset. Throws {@link ShareError} for the known failure cases.
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
