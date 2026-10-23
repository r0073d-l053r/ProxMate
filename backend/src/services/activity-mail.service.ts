import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
import { getMailConfig, sendMail } from './mail.service.js';
import { vmDeployedForYouEmail, vmSharedEmail } from '../lib/email-templates.js';
import type { ShareNotice } from './vm-share.service.js';

/**
 * Activity emails to a tenant about their own machines: an admin set a VM up in
 * their account, or a VM was shared with them / their share level changed.
 *
 * All of it is best-effort and runs after the request has been answered: SMTP
 * being off is logged and skipped, a send failure is logged and swallowed, and
 * nothing here ever reaches the response. A recipient who opted out of activity
 * emails (`activityEmailOptOut`, Security → Email preferences) gets nothing.
 * There is no in-app inbox; the VM's activity feed already records both events.
 */

async function appUrl(): Promise<string> {
  return ((await getConfig('frontend_url')) ?? process.env['FRONTEND_URL'] ?? '').replace(/\/+$/, '');
}

const vmLink = (base: string, vmId: string): string | undefined => (base ? `${base}/vms/${vmId}` : undefined);

/** The account to email, or null when it is gone or has opted out of activity emails. */
async function recipient(userId: string): Promise<{ email: string; displayName: string } | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, displayName: true, activityEmailOptOut: true },
  });
  if (!u || u.activityEmailOptOut) return null;
  return u;
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
 * none), and call this after the response is sent. Returns whether a mail was sent.
 */
export async function sendShareEmail(notice: ShareNotice, actor: { displayName?: string | null }): Promise<boolean> {
  if (!(await getMailConfig())) {
    console.log(`[activity-mail] SMTP is not configured — not emailing a share of ${notice.vmName}`);
    return false;
  }
  const to = await recipient(notice.userId);
  if (!to) return false;
  const mail = vmSharedEmail({
    vmName: notice.vmName,
    role: notice.role,
    previousRole: notice.previousRole,
    sharedBy: actor.displayName,
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
