import { prisma } from '../lib/prisma.js';
import { recordAudit } from './audit.service.js';
import * as pve from './proxmox.service.js';
import { startVm, stopVm } from './vm.service.js';
import { notify } from './notify.service.js';

/**
 * Minimal 5-field cron evaluation (minute resolution) — enough for ProxMate's
 * power schedules, which are simple "at HH:MM on these weekdays" expressions.
 * Supports `*`, single numbers, lists `a,b`, ranges `a-b`, and steps (`*` slash n
 * or `a-b` slash n). Names (mon/jan) are intentionally NOT supported — schedules are
 * generated numerically by the UI, and we validate to the same grammar.
 */
// One list item: `*`, `n` or `a-b`, optionally followed by `/step`. Digits only,
// so an empty item (`1,,2`) can never be read as 0 the way Number('') would.
const CRON_TOKEN_RE = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

/** Parse one list item into its range and step, or null when malformed / out of range. */
function parseCronToken(token: string, min: number, max: number): { lo: number; hi: number; step: number } | null {
  const m = CRON_TOKEN_RE.exec(token);
  if (!m) return null;
  const lo = m[1] === '*' ? min : Number(m[2]);
  const hi = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : lo;
  const step = m[4] !== undefined ? Number(m[4]) : 1;
  if (lo < min || hi > max || lo > hi || step <= 0) return null;
  return { lo, hi, step };
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  // Parse the whole field first: a malformed field matches nothing at all, rather
  // than matching whichever values its well-formed items happen to name.
  const tokens = field.split(',').map((token) => parseCronToken(token, min, max));
  if (tokens.some((t) => t === null)) return false;
  return tokens.some((t) => value >= t!.lo && value <= t!.hi && (value - t!.lo) % t!.step === 0);
}

/** Day-of-week, honoring cron's 0-or-7 = Sunday convention (JS getDay() is 0–6). */
function dowMatches(field: string, day: number): boolean {
  if (fieldMatches(field, day, 0, 7)) return true;
  return day === 0 && fieldMatches(field, 7, 0, 7);
}

/** Does a 5-field cron expression fire at the given minute? */
export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  return (
    fieldMatches(min, date.getMinutes(), 0, 59) &&
    fieldMatches(hour, date.getHours(), 0, 23) &&
    fieldMatches(dom, date.getDate(), 1, 31) &&
    fieldMatches(mon, date.getMonth() + 1, 1, 12) &&
    dowMatches(dow, date.getDay())
  );
}

/**
 * The most recent minute at or before `now` when `expr` fired, or null if none
 * within `maxLookbackMinutes` (default 8 days — enough to cover a weekly schedule).
 * Scans backwards a minute at a time; used by the scheduler to detect a backup
 * window that was missed because the backend was down at the scheduled time.
 */
export function previousCronOccurrence(
  expr: string,
  now: Date = new Date(),
  maxLookbackMinutes = 8 * 24 * 60,
): Date | null {
  const d = new Date(now);
  d.setSeconds(0, 0);
  for (let i = 0; i <= maxLookbackMinutes; i++) {
    if (cronMatches(expr, d)) return new Date(d);
    d.setMinutes(d.getMinutes() - 1);
  }
  return null;
}

/** Validate a schedule cron string against the grammar `cronMatches` supports. */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const bounds: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  // Every list item of every field must parse and lie within the field's range.
  return parts.every((field, i) => {
    const [min, max] = bounds[i]!;
    return field.split(',').every((token) => parseCronToken(token, min, max) !== null);
  });
}

/**
 * Evaluate every VM's power schedule for the given minute and apply due actions:
 * auto-start a stopped VM whose `startCron` fires, gracefully stop a running VM
 * whose `stopCron` fires. One batched cluster-status read; per-VM errors are
 * isolated so one failure never blocks the rest.
 */
export async function runDuePowerActions(now: Date = new Date()): Promise<{ started: number; stopped: number }> {
  const vms = await prisma.virtualMachine.findMany({
    where: {
      OR: [{ startCron: { not: null } }, { stopCron: { not: null } }],
      // A suspended tenant's guests must not be auto-started back up the next
      // morning — that would quietly undo the suspension. Their scheduled STOPS
      // are dropped too, which is harmless: the machines are already off.
      // Admins are never suspended in effect (isAccessExpired exempts them), so
      // exempt them here too — a tenant later PROMOTED to admin keeps the stale
      // accessSuspendedAt latch and would otherwise lose every power schedule
      // permanently, with no UI to clear it.
      NOT: { user: { accessSuspendedAt: { not: null }, role: { not: 'admin' } } },
    },
  });
  if (vms.length === 0) return { started: 0, stopped: 0 };

  // One batched status read for the whole cluster. Bounded timeout so a hung
  // Proxmox can't wedge the per-minute tick's lock and silently stop the scheduler.
  const client = await pve.getClient();
  const res = await client.get<{ data: Array<{ type: string; vmid?: number; status?: string }> }>(
    '/cluster/resources',
    { timeout: 15_000 },
  );
  const statusByVmid = new Map<number, string>();
  for (const r of res.data.data) {
    if ((r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined && r.status) statusByVmid.set(r.vmid, r.status);
  }

  let started = 0;
  let stopped = 0;
  // Side by side, not one after another: a stop waits for the guest to go down, and
  // waiting on each in turn could hold this tick past the next minute, whose
  // schedules would then never fire (the tick skips while one is still running).
  await Promise.all(vms.map(async (vm) => {
    const status = statusByVmid.get(vm.proxmoxVmId);
    if (!status) return; // VM not visible right now — skip this tick
    try {
      if (vm.startCron && cronMatches(vm.startCron, now) && status !== 'running') {
        await startVm(vm);
        await recordAudit({ action: 'vm.start', actor: null, targetType: 'vm', targetId: vm.id, detail: 'scheduled auto-start' });
        started++;
      } else if (vm.stopCron && cronMatches(vm.stopCron, now) && status === 'running') {
        await stopVm(vm, false);
        await recordAudit({ action: 'vm.stop', actor: null, targetType: 'vm', targetId: vm.id, detail: 'scheduled auto-stop' });
        stopped++;
      }
    } catch (err) {
      console.error(`[power-schedule] action for vm ${vm.proxmoxVmId} failed:`, err);
    }
  }));
  return { started, stopped };
}

/**
 * Stored schedules that fail {@link isValidCron} — saved before validation was
 * strict, or edited by hand. They never fire, so an admin has to hear about them.
 */
export async function findInvalidStoredCrons(): Promise<
  Array<{ id: string; name: string; field: 'startCron' | 'stopCron' | 'backupCron'; value: string }>
> {
  const vms = await prisma.virtualMachine.findMany({
    where: { OR: [{ startCron: { not: null } }, { stopCron: { not: null } }, { backupCron: { not: null } }] },
    select: { id: true, name: true, startCron: true, stopCron: true, backupCron: true },
  });
  const bad: Array<{ id: string; name: string; field: 'startCron' | 'stopCron' | 'backupCron'; value: string }> = [];
  for (const vm of vms) {
    for (const field of ['startCron', 'stopCron', 'backupCron'] as const) {
      const value = vm[field];
      if (value && !isValidCron(value)) bad.push({ id: vm.id, name: vm.name, field, value });
    }
  }
  return bad;
}

/** Startup check: log and notify admins about stored schedules that will never fire. Never throws. */
export async function reportInvalidStoredCrons(): Promise<number> {
  try {
    const bad = await findInvalidStoredCrons();
    if (bad.length === 0) return 0;
    const lines = bad.map((b) => `${b.name} (${b.id}): ${b.field} "${b.value}"`);
    console.warn(`[scheduler] ${bad.length} stored schedule(s) are malformed and will never run:\n  ${lines.join('\n  ')}`);
    await notify({
      event: 'vm.error',
      title: `${bad.length} VM schedule(s) are malformed and will never run`,
      message: `Re-save these schedules on each VM's page:\n${lines.join('\n')}`,
    }).catch(() => undefined);
    return bad.length;
  } catch (err) {
    console.error('[scheduler] could not check stored schedules:', err);
    return 0;
  }
}
