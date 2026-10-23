import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
import { getMailConfig, sendMail } from './mail.service.js';
import { vmDeployedForYouEmail, vmSharedEmail } from '../lib/email-templates.js';
import { hasAccessEnded } from './access.service.js';
import type { ShareNotice } from './vm-share.service.js';

/**
 * Activity emails to a tenant about their own machines: an admin set a VM up in
 * their account, or a VM was shared with them / their share level changed.
 *
 * All of it is best-effort and runs after the request has been answered: SMTP
 * being off is logged and skipped, a send failure is logged and swallowed, and
 * nothing here ever reaches the response. A recipient who opted out of activity
 * emails (`activityEmailOptOut`, Security → Email preferences), or whose access
 * window has ended, gets nothing.
 * There is no in-app inbox; the VM's activity feed already records both events.
 */

async function appUrl(): Promise<string> {
  return ((await getConfig('frontend_url')) ?? process.env['FRONTEND_URL'] ?? '').replace(/\/+$/, '');
}

const vmLink = (base: string, vmId: string): string | undefined => (base ? `${base}/vms/${vmId}` : undefined);

/** The account to email, or null when it is gone, opted out, or its access has ended. */
async function recipient(userId: string): Promise<{ email: string; displayName: string } | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      displayName: true,
      activityEmailOptOut: true,
      role: true,
      accessExpiresAt: true,
      accessSuspendedAt: true,
    },
  });
  if (!u || u.activityEmailOptOut || hasAccessEnded(u)) return null;
  return { email: u.email, displayName: u.displayName };
}

/**
 * At most one share email per (recipient, VM) per window. Without it, flipping a
 * share's level back and forth would mail the recipient on every flip (up to the
 * share rate limit). A share or level change inside the window is folded into the
 * email already sent; the recipient sees the current level in the app.
 */
export const SHARE_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SHARE_NOTICE_MAX_ENTRIES = 10_000;
const lastShareNotice = new Map<string, number>();

/** Claim the (recipient, VM) slot for a share email now; false if one went out inside the window. */
function claimShareNotice(userId: string, vmId: string, now: number): boolean {
  const key = `${userId}:${vmId}`;
  const last = lastShareNotice.get(key);
  if (last !== undefined && now - last < SHARE_NOTICE_WINDOW_MS) return false;
  lastShareNotice.delete(key); // re-insert at the end: the Map stays ordered oldest first
  lastShareNotice.set(key, now);
  // Over the cap, drop the oldest entries: the Map is ordered by claim time, so
  // expired ones always go before any that are still inside the window.
  for (const k of lastShareNotice.keys()) {
    if (lastShareNotice.size <= SHARE_NOTICE_MAX_ENTRIES) break;
    lastShareNotice.delete(k);
  }
  return true;
}

/** Test hook: forget every share-email window. */
export function resetShareNoticeWindow(): void {
  lastShareNotice.clear();
}

/**
 * Email a tenant that an admin created a VM or container in their account.
 * No-op when the actor created it for themselves. Returns whether a mail was sent.
 */
export async function sendDeployedForTenantEmail(
  vm: {
    id: string;
    userId: string;
    name: string;
    type?: string | null;
    cpu: number;
    ram: number;
    storage: number;
    quotaExempt: boolean;
  },
  actor: { id: string; displayName?: string | null },
): Promise<boolean> {
  if (vm.userId === actor.id) return false;
  if (!(await getMailConfig())) {
    console.log(`[activity-mail] SMTP is not configured — not emailing the owner of ${vm.name}`);
    return false;
  }
  const to = await recipient(vm.userId);
  if (!to) return false;
  const mail = vmDeployedForYouEmail({
    displayName: to.displayName,
    vmName: vm.name,
    kind: vm.type === 'lxc' ? 'lxc' : 'vm',
    cpu: vm.cpu,
    ram: vm.ram,
    storage: vm.storage,
    quotaExempt: vm.quotaExempt,
    adminName: actor.displayName,
    vmUrl: vmLink(await appUrl(), vm.id),
  });
  await sendMail({ to: to.email, ...mail });
  return true;
}

/**
 * Email the recipient of a live share that was created or whose level changed.
 * Callers only ever have a notice for an existing account (a pending share has
 * none), and call this after the response is sent. The email names the sharer by
 * address as well as display name (a display name is free text anyone can set).
 * Rate-limited per (recipient, VM), see {@link claimShareNotice}. Returns whether
 * a mail was sent.
 */
export async function sendShareEmail(
  notice: ShareNotice,
  actor: { displayName?: string | null; email?: string | null },
  now: number = Date.now(),
): Promise<boolean> {
  if (!(await getMailConfig())) {
    console.log(`[activity-mail] SMTP is not configured — not emailing a share of ${notice.vmName}`);
    return false;
  }
  const to = await recipient(notice.userId);
  if (!to) return false;
  if (!claimShareNotice(notice.userId, notice.vmId, now)) return false;
  const mail = vmSharedEmail({
    vmName: notice.vmName,
    role: notice.role,
    previousRole: notice.previousRole,
    sharedBy: actor.displayName,
    sharedByEmail: actor.email,
    vmUrl: vmLink(await appUrl(), notice.vmId),
  });
  await sendMail({ to: to.email, ...mail });
  return true;
}

/**
 * Run an activity email off the request path. Deferred to the next turn of the
 * event loop so the caller's response is already on its way, and so no delay or
 * failure from the mail server can change what or when the caller answers.
 */
export function sendLater(what: string, fn: () => Promise<unknown>): void {
  setImmediate(() => {
    fn().catch((err: unknown) => console.warn(`[activity-mail] ${what} email failed:`, err));
  });
}
