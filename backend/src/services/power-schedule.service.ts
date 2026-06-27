import { prisma } from '../lib/prisma.js';
import { recordAudit } from './audit.service.js';
import * as pve from './proxmox.service.js';
import { startVm, stopVm } from './vm.service.js';

/**
 * Minimal 5-field cron evaluation (minute resolution) — enough for ProxMate's
 * power schedules, which are simple "at HH:MM on these weekdays" expressions.
 * Supports `*`, single numbers, lists `a,b`, ranges `a-b`, and steps `*​/n` /
 * `a-b/n`. Names (mon/jan) are intentionally NOT supported — schedules are
 * generated numerically by the UI, and we validate to the same grammar.
 */
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  for (const token of field.split(',')) {
    const [rangePart, stepPart] = token.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (stepPart !== undefined && (!Number.isInteger(step) || step <= 0)) return false;

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-').map(Number);
      if (!Number.isInteger(a!) || !Number.isInteger(b!)) return false;
      lo = a!;
      hi = b!;
    } else {
      const n = Number(rangePart);
      if (!Number.isInteger(n)) return false;
      lo = n;
      hi = n;
    }
    if (lo < min || hi > max || lo > hi) continue;
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
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
  // Probe every field against an in-range value; a malformed token returns false.
  return parts.every((field, i) => {
    const [min, max] = bounds[i]!;
    if (field === '*') return true;
    return /^[0-9*,\-/]+$/.test(field) && fieldProbe(field, min, max);
  });
}

/** True if `field` parses to at least one in-range value (structure check). */
function fieldProbe(field: string, min: number, max: number): boolean {
  for (let v = min; v <= max; v++) if (fieldMatches(field, v, min, max)) return true;
  return false;
}

/**
 * Evaluate every VM's power schedule for the given minute and apply due actions:
 * auto-start a stopped VM whose `startCron` fires, gracefully stop a running VM
 * whose `stopCron` fires. One batched cluster-status read; per-VM errors are
 * isolated so one failure never blocks the rest.
 */
export async function runDuePowerActions(now: Date = new Date()): Promise<{ started: number; stopped: number }> {
  const vms = await prisma.virtualMachine.findMany({
    where: { OR: [{ startCron: { not: null } }, { stopCron: { not: null } }] },
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
    if (r.type === 'qemu' && r.vmid !== undefined && r.status) statusByVmid.set(r.vmid, r.status);
  }

  let started = 0;
  let stopped = 0;
  for (const vm of vms) {
    const status = statusByVmid.get(vm.proxmoxVmId);
    if (!status) continue; // VM not visible right now — skip this tick
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
  }
  return { started, stopped };
}
