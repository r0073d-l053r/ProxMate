import { prisma } from '../lib/prisma.js';
import * as pve from './proxmox.service.js';

/**
 * Per-tenant resource history. A scheduler tick samples every running VM's live
 * CPU/memory into `ResourceSample`; the admin "usage" view aggregates those by
 * owner over a window ("who consumed what last week"). Complements the live-only
 * Admin Monitor. Samples are denormalized + pruned to a rolling retention window.
 */
const RETENTION_DAYS = Math.max(1, Number(process.env['RESOURCE_HISTORY_DAYS'] ?? 14));
const DAY_MS = 86_400_000;

interface PveResource {
  type: string;
  vmid?: number;
  status?: string;
  cpu?: number;
  mem?: number;
  maxmem?: number;
}

/** Take one usage sample for every running VM ProxMate manages. Best-effort. */
export async function sampleResourceUsage(): Promise<{ sampled: number }> {
  const vms = await prisma.virtualMachine.findMany({ select: { id: true, userId: true, proxmoxVmId: true } });
  if (vms.length === 0) return { sampled: 0 };

  const client = await pve.getClient();
  const res = await client.get<{ data: PveResource[] }>('/cluster/resources', { timeout: 15_000 });
  const byVmid = new Map<number, PveResource>();
  for (const r of res.data.data) {
    if ((r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined) byVmid.set(r.vmid, r);
  }

  const rows = vms
    .map((vm) => ({ vm, live: byVmid.get(vm.proxmoxVmId) }))
    .filter((x): x is { vm: typeof x.vm; live: PveResource } => x.live?.status === 'running')
    .map(({ vm, live }) => ({
      userId: vm.userId,
      vmId: vm.id,
      cpu: live.cpu ?? 0,
      mem: live.mem ?? 0,
      maxmem: live.maxmem ?? 0,
    }));

  if (rows.length > 0) await prisma.resourceSample.createMany({ data: rows });
  return { sampled: rows.length };
}

/** Delete samples older than the retention window. Returns how many were pruned. */
export async function pruneResourceSamples(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
  const { count } = await prisma.resourceSample.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}

export interface UserUsage {
  userId: string;
  email: string;
  displayName: string;
  samples: number;
  avgCpuPct: number; // average CPU as % of the VM's allocated cores
  avgMemBytes: number;
  peakMemBytes: number;
}

type Sample = { userId: string; cpu: number; mem: number };
type UserRef = { id: string; email: string; displayName: string };

/**
 * Pure aggregator: fold raw samples into per-user averages/peaks, joined to the
 * given users (unknown ids → "(deleted user)"), sorted by avg CPU desc.
 */
export function aggregateUsage(samples: Sample[], users: UserRef[]): UserUsage[] {
  const userMap = new Map(users.map((u) => [u.id, u]));
  const agg = new Map<string, { n: number; cpuSum: number; memSum: number; memPeak: number }>();
  for (const s of samples) {
    const a = agg.get(s.userId) ?? { n: 0, cpuSum: 0, memSum: 0, memPeak: 0 };
    a.n += 1;
    a.cpuSum += s.cpu;
    a.memSum += s.mem;
    a.memPeak = Math.max(a.memPeak, s.mem);
    agg.set(s.userId, a);
  }
  return [...agg.entries()]
    .map(([userId, a]) => {
      const u = userMap.get(userId);
      return {
        userId,
        email: u?.email ?? '(deleted user)',
        displayName: u?.displayName ?? '(deleted user)',
        samples: a.n,
        avgCpuPct: (a.cpuSum / a.n) * 100,
        avgMemBytes: a.memSum / a.n,
        peakMemBytes: a.memPeak,
      };
    })
    .sort((x, y) => y.avgCpuPct - x.avgCpuPct);
}

/** Per-user usage aggregates over the last `days` (clamped 1–90). */
export async function getUsageByUser(days = 7, now: Date = new Date()): Promise<UserUsage[]> {
  const window = Math.min(Math.max(Math.floor(days), 1), 90);
  const since = new Date(now.getTime() - window * DAY_MS);
  const samples = await prisma.resourceSample.findMany({
    where: { createdAt: { gte: since } },
    select: { userId: true, cpu: true, mem: true },
  });
  if (samples.length === 0) return [];
  const userIds = [...new Set(samples.map((s) => s.userId))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, displayName: true },
  });
  return aggregateUsage(samples, users);
}
