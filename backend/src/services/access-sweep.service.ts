/**
 * The periodic half of tenant compute-access windows.
 *
 * Enforcement (refusing sign-in, HTTP, WebSocket, API tokens) is evaluated per
 * request in `access.service` and is INSTANTANEOUS. This sweep only handles the
 * side effects that can't happen inside a request:
 *   - warn a tenant 7 days and 1 day before their window closes
 *   - power off a lapsed tenant's guests and tell the admins
 *
 * Nothing here is ever destructive: no VM, disk, backup, or account is deleted.
 * Suspension is a latch that an admin clears by extending the window.
 */
import { prisma } from '../lib/prisma.js';
import { isMailConfigured, sendMail } from './mail.service.js';
import { accessExpiringEmail } from '../lib/email-templates.js';
import { getConfig } from './config.service.js';
import { recordAudit } from './audit.service.js';
import { notify } from './notify.service.js';
import { stopVm } from './vm.service.js';
import { pveMessage } from './proxmox.service.js';

const DAY_MS = 86_400_000;

export interface AccessSweepResult {
  warned: number;
  suspended: number;
  stopped: number;
}

async function dashboardUrl(): Promise<string> {
  return (await getConfig('frontend_url')) ?? process.env['FRONTEND_URL'] ?? '';
}

/**
 * Send the 7-day and 1-day warnings.
 *
 * `accessWarned7For` / `accessWarned1For` store WHICH DEADLINE the warning was
 * sent for, not a bare "sent" flag. That single choice buys three properties:
 * a warning is never sent twice for the same deadline; an admin extending the
 * window automatically re-arms both warnings (the stored value no longer
 * matches); and a tick missed while the backend was down still warns late
 * rather than never, because the predicate is a range, not an instant.
 */
async function sendWarnings(now: Date): Promise<number> {
  // No mail configured → don't stamp anything, so warnings still fire once the
  // admin sets SMTP up rather than being silently consumed.
  if (!(await isMailConfigured())) return 0;

  const horizon = new Date(now.getTime() + 7 * DAY_MS);
  const due = await prisma.user.findMany({
    where: {
      role: { not: 'admin' },
      accessExpiresAt: { gt: now, lte: horizon }, // never warn someone already lapsed
    },
    include: { _count: { select: { vms: true } } },
  });

  const url = await dashboardUrl();
  let sent = 0;

  for (const u of due) {
    const deadline = u.accessExpiresAt!;
    const msLeft = deadline.getTime() - now.getTime();
    const daysLeft = Math.ceil(msLeft / DAY_MS);
    const oneDayDue = msLeft <= DAY_MS && u.accessWarned1For?.getTime() !== deadline.getTime();
    const sevenDayDue = !oneDayDue && u.accessWarned7For?.getTime() !== deadline.getTime();
    if (!oneDayDue && !sevenDayDue) continue;

    try {
      const mail = accessExpiringEmail({
        displayName: u.displayName,
        expiresAt: deadline,
        daysLeft,
        vmCount: u._count.vms,
        dashboardUrl: url,
      });
      await sendMail({ to: u.email, ...mail });
      sent++;
    } catch (err) {
      // Stamp anyway (below): one attempt per deadline per level, or a bad
      // address would re-send on every tick, forever.
      console.warn(`[access] warning email to ${u.email} failed:`, err);
    }

    // When a window is armed with less than a day left, both levels come due at
    // once — send only the more urgent mail, but stamp both so the 7-day one
    // can't fire afterwards.
    await prisma.user.update({
      where: { id: u.id },
      data: oneDayDue
        ? { accessWarned1For: deadline, accessWarned7For: deadline }
        : { accessWarned7For: deadline },
    });
  }
  return sent;
}

/**
 * Suspend tenants whose window has closed: power off their guests, latch
 * `accessSuspendedAt`, and notify the admins.
 */
async function suspendLapsed(now: Date): Promise<{ suspended: number; stopped: number }> {
  const lapsed = await prisma.user.findMany({
    where: {
      // A tenant who was later PROMOTED to admin keeps the accessExpiresAt from
      // their original invite. The auth guard exempts admins, so they sign in
      // fine — but without this filter the sweep would still power off their
      // machines. Belt and braces with isAccessExpired's own admin exemption.
      role: { not: 'admin' },
      accessExpiresAt: { lte: now },
      accessSuspendedAt: null, // latch: suspend once, not every tick
    },
    include: { vms: true },
  });

  let suspended = 0;
  let stopped = 0;

  for (const u of lapsed) {
    let stoppedForUser = 0;
    for (const vm of u.vms) {
      try {
        await stopVm(vm, false); // graceful ACPI; kind-aware inside stopVm
        await recordAudit({
          action: 'vm.stop',
          actor: null,
          targetType: 'vm',
          targetId: vm.id,
          detail: `${vm.name}: owner's compute access expired`,
        });
        stoppedForUser++;
      } catch (err) {
        console.error(`[access] stop of vm ${vm.proxmoxVmId} failed:`, pveMessage(err));
      }
    }

    await prisma.user.update({ where: { id: u.id }, data: { accessSuspendedAt: now } });
    await recordAudit({
      action: 'admin.access_suspended',
      actor: null,
      targetType: 'user',
      targetId: u.id,
      detail: `${u.email}: window closed ${u.accessExpiresAt!.toISOString()} — ${stoppedForUser}/${u.vms.length} guest(s) stopped`,
    });
    await notify({
      event: 'access.expired',
      title: `${u.displayName} (${u.email}) has reached the end of their access window`,
      message:
        `Access ended ${u.accessExpiresAt!.toUTCString()}. ` +
        `${stoppedForUser} of ${u.vms.length} machine(s) were powered off. Nothing was deleted — ` +
        `extend their window (or set it to never expire) in Admin → Users to restore access immediately.`,
    });

    suspended++;
    stopped += stoppedForUser;
  }

  return { suspended, stopped };
}

/** One pass: warn, then suspend. Safe to run concurrently-guarded on a cron. */
export async function runAccessExpiryTick(now: Date = new Date()): Promise<AccessSweepResult> {
  const warned = await sendWarnings(now);
  const { suspended, stopped } = await suspendLapsed(now);
  return { warned, suspended, stopped };
}
