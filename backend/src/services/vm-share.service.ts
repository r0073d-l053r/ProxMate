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
//
// `console_view` is the watch-only console: the relay drops every keyboard,
// mouse and clipboard message (see lib/console-view-filter.ts). `console`
// implies it, so every preset that holds `console` holds `console_view` too.

export const VM_CAPS = ['view', 'console_view', 'power', 'console', 'configure', 'backups', 'ide'] as const;
export type VmCap = (typeof VM_CAPS)[number];

export const SHARE_ROLES = ['viewer', 'operator', 'manager'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export const CAPS_BY_ROLE: Record<ShareRole, ReadonlySet<VmCap>> = {
  viewer: new Set<VmCap>(['view', 'console_view']),
  operator: new Set<VmCap>(['view', 'console_view', 'power', 'console']),
  manager: new Set<VmCap>(['view', 'console_view', 'power', 'console', 'configure', 'backups', 'ide']),
};

/** How a console session may be used: full input, or watch-only. */
export type ConsoleMode = 'interactive' | 'view';

/**
 * The console mode a capability set allows, or null for none. `console` gives an
 * interactive session; `console_view` alone gives a view-only one.
 */
export function consoleModeFor(caps: ReadonlySet<VmCap>): ConsoleMode | null {
  if (caps.has('console')) return 'interactive';
  if (caps.has('console_view')) return 'view';
  return null;
}

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

/**
 * One share as the owner sees it: the address they shared with, the level, and the
 * share id to revoke it. The sharee's account id and display name are deliberately
 * not included — the owner typed the address, nothing more about that account is theirs.
 */
export interface ShareView {
  id: string;
  email: string;
  role: ShareRole;
  createdAt: string;
}

const userSelect = { select: { email: true } } as const;

const toView = (s: { id: string; role: string; createdAt: Date; user: { email: string } }): ShareView => ({
  id: s.id,
  email: s.user.email,
  role: normalizeShareRole(s.role),
  createdAt: s.createdAt.toISOString(),
});

/** Most shares one VM can hold, live and pending together. */
export const MAX_SHARES_PER_VM = 100;

/**
 * Everyone a VM is shared with, oldest first. Shares to addresses that have no
 * account yet are listed exactly like live ones: telling them apart would reveal
 * which addresses have accounts.
 */
export async function listShares(vmId: string): Promise<ShareView[]> {
  const [live, pending] = await Promise.all([
    prisma.vmShare.findMany({ where: { vmId }, include: { user: userSelect } }),
    prisma.pendingVmShare.findMany({ where: { vmId } }),
  ]);
  return [
    ...live.map(toView),
    ...pending.map((p) => toView({ id: p.id, role: p.role, createdAt: p.createdAt, user: { email: p.email } })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Share a VM by email. Re-sharing the same address just updates its preset. An
 * address with no account gets a pending share, which becomes live when an account
 * is created with that address and the address is confirmed (see
 * {@link claimPendingShares}). Both cases answer the same, so sharing can't be used
 * to discover which addresses have accounts. Throws {@link ShareError} for the
 * remaining failure cases.
 */
export async function addShare(
  vm: { id: string; userId: string; name?: string },
  email: string,
  role: ShareRole,
): Promise<ShareView> {
  return (await addShareWithNotice(vm, email, role)).view;
}

/**
 * What the recipient of a live share should be told: it is new, or its level
 * changed (`previousRole`). Never produced for a pending share — an address with
 * no account is not emailed (inviting it is a separate, deliberate step) — nor
 * for a re-share at the same level.
 */
export interface ShareNotice {
  userId: string;
  vmId: string;
  vmName: string;
  role: ShareRole;
  previousRole: ShareRole | null;
}

/**
 * {@link addShare}, plus the notice to send the recipient, if any. The notice is
 * for the caller to deliver AFTER answering the request (see activity-mail), so
 * neither the response nor its timing differs between an address with an account
 * and one without.
 */
export async function addShareWithNotice(
  vm: { id: string; userId: string; name?: string },
  email: string,
  role: ShareRole,
): Promise<{ view: ShareView; notice: ShareNotice | null }> {
  const address = email.toLowerCase().trim();

  // The cap is checked before the account lookup, and the same way for both kinds of
  // share, so hitting it says nothing about whether the address has an account.
  const [liveForAddress, pendingForAddress] = await Promise.all([
    prisma.vmShare.findFirst({ where: { vmId: vm.id, user: { email: address } } }),
    prisma.pendingVmShare.findUnique({ where: { vmId_email: { vmId: vm.id, email: address } } }),
  ]);
  if (!liveForAddress && !pendingForAddress) {
    const [liveCount, pendingCount] = await Promise.all([
      prisma.vmShare.count({ where: { vmId: vm.id } }),
      prisma.pendingVmShare.count({ where: { vmId: vm.id } }),
    ]);
    if (liveCount + pendingCount >= MAX_SHARES_PER_VM) {
      throw new ShareError(`A VM can be shared with at most ${MAX_SHARES_PER_VM} addresses. Remove one first.`, 409);
    }
  }

  const target = await prisma.user.findUnique({ where: { email: address } });
  if (!target) {
    const pending = await prisma.pendingVmShare.upsert({
      where: { vmId_email: { vmId: vm.id, email: address } },
      create: { vmId: vm.id, email: address, role },
      update: { role },
    });
    const view = toView({ id: pending.id, role: pending.role, createdAt: pending.createdAt, user: { email: pending.email } });
    return { view, notice: null };
  }
  if (target.id === vm.userId) throw new ShareError('That user already owns this VM.', 400);

  const share = await prisma.vmShare.upsert({
    where: { vmId_userId: { vmId: vm.id, userId: target.id } },
    create: { vmId: vm.id, userId: target.id, role },
    update: { role },
    include: { user: userSelect },
  });
  // An earlier share to the same address, made before the account existed, is now this one.
  if (pendingForAddress) await prisma.pendingVmShare.delete({ where: { id: pendingForAddress.id } }).catch(() => undefined);

  const previousRole = liveForAddress ? normalizeShareRole(liveForAddress.role) : null;
  const notice: ShareNotice | null =
    previousRole === role
      ? null // same level re-saved: nothing changed for the recipient
      : { userId: target.id, vmId: vm.id, vmName: vm.name ?? 'a VM', role, previousRole };
  return { view: toView(share), notice };
}

/** Revoke a share, live or pending. Returns false if it doesn't belong to this VM. */
export async function removeShare(vmId: string, shareId: string): Promise<boolean> {
  const share = await prisma.vmShare.findFirst({ where: { id: shareId, vmId } });
  if (share) {
    await prisma.vmShare.delete({ where: { id: share.id } });
    return true;
  }
  const pending = await prisma.pendingVmShare.findFirst({ where: { id: shareId, vmId } });
  if (!pending) return false;
  await prisma.pendingVmShare.delete({ where: { id: pending.id } });
  return true;
}

/**
 * Turn the shares waiting for a new account's address into live shares. Only for an
 * account whose address is confirmed — registered through an invite sent to it, or
 * created by SSO with a verified email. A self-typed address proves nothing about
 * who owns it, so its pending shares stay pending. Returns how many were claimed.
 */
export async function claimPendingShares(user: { id: string; email: string; emailBound: boolean }): Promise<number> {
  if (!user.emailBound) return 0;
  const address = user.email.toLowerCase().trim();
  const pending = await prisma.pendingVmShare.findMany({
    where: { email: address },
    include: { vm: { select: { userId: true } } },
  });
  let claimed = 0;
  for (const p of pending) {
    if (p.vm.userId !== user.id) {
      await prisma.vmShare.upsert({
        where: { vmId_userId: { vmId: p.vmId, userId: user.id } },
        create: { vmId: p.vmId, userId: user.id, role: normalizeShareRole(p.role) },
        update: {},
      });
      claimed++;
    }
    await prisma.pendingVmShare.delete({ where: { id: p.id } }).catch(() => undefined);
  }
  return claimed;
}
