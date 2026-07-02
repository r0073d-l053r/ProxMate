import type { AxiosInstance } from 'axios';
import type { AlertRule } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
import { isMailConfigured, sendMail } from './mail.service.js';
import { alertEmail } from '../lib/email-templates.js';
import { notifyWebhook } from './notify.service.js';
import * as pve from './proxmox.service.js';

/**
 * Per-VM resource alerts. Tenants set thresholds on their own machines; the
 * resource-history scheduler tick evaluates them against the same live sample it
 * already fetches, so alerts cost no extra Proxmox calls. A rule fires when its
 * condition holds continuously for `sustainedMin` minutes (tracked via
 * `breachingSince`), then stays quiet for a cooldown so a flapping metric can't
 * spam. Delivery is a branded email to the VM owner + the admin webhook.
 */

export const ALERT_METRICS = ['cpu', 'memory', 'disk', 'down'] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export const ALERT_METRIC_LABEL: Record<AlertMetric, string> = {
  cpu: 'High CPU',
  memory: 'High memory',
  disk: 'Disk almost full',
  down: 'Unexpectedly stopped',
};

/** Don't re-fire the same rule more often than this (minutes). */
const COOLDOWN_MIN = Math.max(5, Number(process.env['ALERT_COOLDOWN_MIN'] ?? 60));

/** One VM's live signals, as seen this tick. `diskPct` is null when unknown (no agent). */
export interface VmSignals {
  /** True if Proxmox reports the guest running. */
  running: boolean;
  /** ProxMate's intended state — used to detect an *unexpected* stop. */
  expectedRunning: boolean;
  cpuPct: number; // 0..100 of allocated cores
  memPct: number; // 0..100 of allocated RAM
  diskPct: number | null; // 0..100 fullest filesystem, or null when unknown
}

/** Whether a rule's condition is currently true given this tick's signals. */
export function conditionMet(rule: Pick<AlertRule, 'metric' | 'threshold'>, s: VmSignals): boolean {
  switch (rule.metric as AlertMetric) {
    case 'cpu':
      return s.running && s.cpuPct >= rule.threshold;
    case 'memory':
      return s.running && s.memPct >= rule.threshold;
    case 'disk':
      return s.running && s.diskPct !== null && s.diskPct >= rule.threshold;
    case 'down':
      // Fires when ProxMate expects the VM up but Proxmox reports it stopped.
      return s.expectedRunning && !s.running;
    default:
      return false;
  }
}

/** A friendly one-line summary for the notification body. */
export function describeAlert(rule: Pick<AlertRule, 'metric' | 'threshold' | 'sustainedMin'>, s: VmSignals): string {
  const m = rule.metric as AlertMetric;
  if (m === 'down') return `Your machine is no longer running, though it wasn't stopped from ProxMate.`;
  if (m === 'cpu') return `CPU has been at or above ${rule.threshold}% for ${rule.sustainedMin} min (now ${s.cpuPct.toFixed(0)}%).`;
  if (m === 'memory') return `Memory has been at or above ${rule.threshold}% for ${rule.sustainedMin} min (now ${s.memPct.toFixed(0)}%).`;
  return `Disk usage has reached ${s.diskPct?.toFixed(0) ?? '?'}% (threshold ${rule.threshold}%).`;
}

export type RuleAction =
  | { kind: 'fire'; breachingSince: Date; lastFiredAt: Date }
  | { kind: 'start-breach'; breachingSince: Date }
  | { kind: 'clear-breach' }
  | { kind: 'none' };

/**
 * Pure decision for one rule this tick — no I/O, fully unit-testable. Decides
 * whether to fire (and the DB state to persist) based on the condition, how long
 * it's held (`breachingSince`), the sustained window, and the cooldown.
 */
export function evaluateRule(
  rule: Pick<AlertRule, 'metric' | 'threshold' | 'sustainedMin' | 'breachingSince' | 'lastFiredAt'>,
  s: VmSignals,
  now: Date,
): RuleAction {
  if (!conditionMet(rule, s)) {
    return rule.breachingSince ? { kind: 'clear-breach' } : { kind: 'none' };
  }
  // Condition is true — start (or continue) the breach clock.
  const breachingSince = rule.breachingSince ?? now;
  const heldMs = now.getTime() - breachingSince.getTime();
  const sustainedReached = heldMs >= rule.sustainedMin * 60_000;
  const cooledDown = !rule.lastFiredAt || now.getTime() - rule.lastFiredAt.getTime() >= COOLDOWN_MIN * 60_000;

  if (sustainedReached && cooledDown) {
    return { kind: 'fire', breachingSince, lastFiredAt: now };
  }
  // Breaching but not yet sustained (or still cooling down): just record the start.
  return rule.breachingSince ? { kind: 'none' } : { kind: 'start-breach', breachingSince };
}

/** Best-effort fullest-filesystem % via the QEMU guest agent (null without it). */
async function getDiskPct(
  node: string,
  vmid: number,
  kind: pve.GuestKind,
  client: AxiosInstance,
): Promise<number | null> {
  if (kind !== 'qemu') return null; // LXC has no guest agent
  try {
    const res = await client.get<{ data: { result?: Array<{ 'total-bytes'?: number; 'used-bytes'?: number; mountpoint?: string }> } }>(
      `/nodes/${node}/qemu/${vmid}/agent/get-fsinfo`,
      { timeout: 2000 },
    );
    let worst: number | null = null;
    for (const fs of res.data.data?.result ?? []) {
      const total = fs['total-bytes'];
      const used = fs['used-bytes'];
      if (!total || total <= 0 || used === undefined) continue;
      const pct = (used / total) * 100;
      if (worst === null || pct > worst) worst = pct;
    }
    return worst;
  } catch {
    return null; // agent absent / VM off
  }
}

interface LiveResource {
  type: string;
  vmid?: number;
  status?: string;
  cpu?: number;
  mem?: number;
  maxmem?: number;
}

/**
 * Evaluate every enabled alert rule against the current cluster sample and fire
 * those that are due. Called from the scheduler's resource-history tick. Returns
 * how many alerts fired. Best-effort throughout — a delivery failure never stops
 * the loop.
 */
export async function evaluateAlerts(now: Date = new Date()): Promise<{ fired: number }> {
  const rules = await prisma.alertRule.findMany({
    where: { enabled: true },
    include: { vm: { select: { id: true, name: true, userId: true, proxmoxVmId: true, proxmoxNode: true, status: true, type: true } } },
  });
  if (rules.length === 0) return { fired: 0 };

  const client = await pve.getClient();
  const res = await client.get<{ data: LiveResource[] }>('/cluster/resources', { timeout: 15_000 });
  const byVmid = new Map<number, LiveResource>();
  for (const r of res.data.data) {
    if ((r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined) byVmid.set(r.vmid, r);
  }

  // Disk % is only read for VMs that actually have an enabled disk rule (avoids
  // an agent call per VM); memoized per vmid within this tick.
  const diskCache = new Map<number, number | null>();
  const frontendUrl = (await getConfig('frontend_url')) ?? process.env['FRONTEND_URL'] ?? '';
  let fired = 0;

  for (const rule of rules) {
    const vm = rule.vm;
    const live = byVmid.get(vm.proxmoxVmId);
    const running = live?.status === 'running';

    let diskPct: number | null = null;
    if (rule.metric === 'disk' && running) {
      if (!diskCache.has(vm.proxmoxVmId)) {
        diskCache.set(vm.proxmoxVmId, await getDiskPct(vm.proxmoxNode, vm.proxmoxVmId, vm.type === 'lxc' ? 'lxc' : 'qemu', client));
      }
      diskPct = diskCache.get(vm.proxmoxVmId) ?? null;
    }

    const signals: VmSignals = {
      running,
      expectedRunning: vm.status === 'running',
      cpuPct: (live?.cpu ?? 0) * 100,
      memPct: live && live.maxmem ? ((live.mem ?? 0) / live.maxmem) * 100 : 0,
      diskPct,
    };

    const action = evaluateRule(rule, signals, now);
    if (action.kind === 'none') continue;

    if (action.kind === 'clear-breach') {
      await prisma.alertRule.update({ where: { id: rule.id }, data: { breachingSince: null } }).catch(() => undefined);
      continue;
    }
    if (action.kind === 'start-breach') {
      await prisma.alertRule.update({ where: { id: rule.id }, data: { breachingSince: action.breachingSince } }).catch(() => undefined);
      continue;
    }

    // Fire.
    await prisma.alertRule
      .update({ where: { id: rule.id }, data: { breachingSince: action.breachingSince, lastFiredAt: action.lastFiredAt } })
      .catch(() => undefined);
    fired += 1;

    const label = ALERT_METRIC_LABEL[rule.metric as AlertMetric];
    const detail = describeAlert(rule, signals);
    const vmUrl = frontendUrl ? `${frontendUrl.replace(/\/+$/, '')}/vms/${vm.id}` : undefined;

    // Email the owner (best-effort).
    if (await isMailConfigured()) {
      const owner = await prisma.user.findUnique({ where: { id: vm.userId }, select: { email: true } }).catch(() => null);
      if (owner?.email) {
        const { subject, text, html } = alertEmail({ vmName: vm.name, alertLabel: label, detail, vmUrl });
        await sendMail({ to: owner.email, subject, text, html }).catch((e) => console.warn('[alert] email failed:', e));
      }
    }
    // Also nudge the admin webhook (reuses the vm.error event channel).
    await notifyWebhook({ event: 'vm.error', title: `${vm.name} — ${label}`, message: detail }).catch(() => undefined);
  }

  return { fired };
}
