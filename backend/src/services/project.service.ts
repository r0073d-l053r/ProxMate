import { prisma } from '../lib/prisma.js';
import { normalizeShareRole, type ShareRole } from './vm-share.service.js';

/**
 * Projects: a grouping of VMs by a `project:<name>` tag on the VM's own tag list
 * (VirtualMachine.tags). A VM is in at most one project. The project is the
 * owner's organisation of their machines, so only the owner (or an admin) sets
 * it; the plain-label editor (PATCH /api/vms/:id `tags`) keeps whatever project
 * the VM already has.
 *
 * The rollup is DB-only: allocation totals from the rows, running counts from the
 * row status the VMs list already shows, and usage averages from ResourceSample.
 * No Proxmox call is made, so the page costs the same however many VMs it holds.
 */

export const PROJECT_PREFIX = 'project:';
/** A project name, after lowercasing: letters, digits, `_` and `-`, up to 32. */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const DAY_MS = 86_400_000;
export const DEFAULT_USAGE_DAYS = 7;

/** A user-typed project name normalised (trimmed, lowercased), or null when invalid. */
export function normalizeProjectName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return PROJECT_NAME_RE.test(name) ? name : null;
}

function splitTags(csv: string | null | undefined): string[] {
  return (csv ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

/** The VM's project name from its tag CSV, or null. Malformed project tags are ignored. */
export function projectOf(csv: string | null | undefined): string | null {
  for (const t of splitTags(csv)) {
    if (!t.startsWith(PROJECT_PREFIX)) continue;
    const name = t.slice(PROJECT_PREFIX.length);
    if (PROJECT_NAME_RE.test(name)) return name;
  }
  return null;
}

/**
 * The tag CSV with its project set to `name` (or removed for null), keeping every
 * other tag in order. Any existing project tag is replaced, so a VM never ends up
 * in two projects. Returns null for an empty list (the stored "no tags" form).
 */
export function withProject(csv: string | null | undefined, name: string | null): string | null {
  const rest = splitTags(csv).filter((t) => !t.startsWith(PROJECT_PREFIX));
  const next = name ? [...rest, `${PROJECT_PREFIX}${name}`] : rest;
  return next.length > 0 ? [...new Set(next)].join(',') : null;
}

/**
 * The tag CSV as a caller with `access` may see it. The project is the owner's way of
 * organising their machines, so only the owner and admins see it; a sharee gets the
 * plain labels.
 */
export function tagsForAccess(csv: string | null, access: string): string | null {
  return access === 'owner' || access === 'admin' ? csv : withProject(csv, null);
}

// ─── Rollup ──────────────────────────────────────────────────

export interface VmUsageStat {
  samples: number;
  avgCpu: number; // 0..1 fraction of the VM's allocated vCPUs
  avgMem: number; // bytes
}

export interface ProjectVm {
  id: string;
  name: string;
  type: string;
  status: string;
  cpu: number;
  ram: number; // MB
  storage: number; // GB
  access: 'owner' | 'admin' | ShareRole;
  usage: VmUsageStat | null;
}

export interface ProjectRollup {
  /** The project name; null is the "no project" group (and the shared group). */
  name: string | null;
  vmCount: number;
  running: number;
  cpu: number; // allocated vCPUs
  ram: number; // allocated MB
  storage: number; // allocated GB
  usage: {
    samples: number;
    /** Average CPU busy across the sampled VMs (each as % of its own vCPUs), weighted by sample count. */
    avgCpuPct: number;
    /** Sum of each VM's average memory in use: the project's typical combined footprint. */
    avgMemBytes: number;
  };
  vms: ProjectVm[];
}

type RollupRow = Omit<ProjectVm, 'usage'>;

/**
 * Pure: fold VMs (already scoped to what the caller may see) and their per-VM
 * usage stats into one rollup. VMs without samples count toward allocation but
 * not toward the usage averages.
 */
export function rollupProject(name: string | null, rows: RollupRow[], stats: ReadonlyMap<string, VmUsageStat>): ProjectRollup {
  let samples = 0;
  let cpuWeighted = 0;
  let memSum = 0;
  const vms: ProjectVm[] = rows.map((r) => {
    const usage = stats.get(r.id) ?? null;
    if (usage && usage.samples > 0) {
      samples += usage.samples;
      cpuWeighted += usage.avgCpu * usage.samples;
      memSum += usage.avgMem;
    }
    return { ...r, usage };
  });
  return {
    name,
    vmCount: rows.length,
    running: rows.filter((r) => r.status === 'running').length,
    cpu: rows.reduce((n, r) => n + r.cpu, 0),
    ram: rows.reduce((n, r) => n + r.ram, 0),
    storage: rows.reduce((n, r) => n + r.storage, 0),
    usage: {
      samples,
      avgCpuPct: samples > 0 ? Math.round((cpuWeighted / samples) * 1000) / 10 : 0,
      avgMemBytes: Math.round(memSum),
    },
    vms,
  };
}

/** Group rows by project: named projects alphabetically, then the unassigned group. */
export function groupByProject(
  rows: Array<RollupRow & { tags: string | null }>,
  stats: ReadonlyMap<string, VmUsageStat>,
): ProjectRollup[] {
  const byName = new Map<string | null, RollupRow[]>();
  for (const { tags, ...row } of rows) {
    const name = projectOf(tags);
    byName.set(name, [...(byName.get(name) ?? []), row]);
  }
  const names = [...byName.keys()].filter((n): n is string => n !== null).sort();
  const groups = names.map((n) => rollupProject(n, byName.get(n)!, stats));
  const none = byName.get(null);
  if (none) groups.push(rollupProject(null, none, stats));
  return groups;
}

// ─── Scoped listing ──────────────────────────────────────────

export interface OwnerProjects {
  owner: { id: string; email: string; displayName: string; role: string };
  projects: ProjectRollup[];
}

export interface ProjectsView {
  days: number;
  owners: OwnerProjects[];
  /**
   * VMs shared WITH the caller, as one flat group. Deliberately not split by the
   * owner's projects and carrying no tags: a sharee sees the VM and the access
   * their share grants, never how another tenant organises their machines.
   */
  shared: ProjectRollup | null;
}

const VM_SELECT = {
  id: true, userId: true, name: true, type: true, status: true,
  cpu: true, ram: true, storage: true, tags: true,
} as const;

/** Per-VM usage averages over the window, in one grouped query. */
async function usageStats(vmIds: string[] | null, since: Date): Promise<Map<string, VmUsageStat>> {
  if (vmIds && vmIds.length === 0) return new Map();
  const rows = await prisma.resourceSample.groupBy({
    by: ['vmId'],
    where: { createdAt: { gte: since }, ...(vmIds ? { vmId: { in: vmIds } } : {}) },
    _count: { _all: true },
    _avg: { cpu: true, mem: true },
  });
  return new Map(
    rows.map((r) => [r.vmId, { samples: r._count._all, avgCpu: r._avg.cpu ?? 0, avgMem: r._avg.mem ?? 0 }]),
  );
}

/**
 * The Projects view for the caller. A tenant gets one owner entry (their own VMs
 * grouped by project) plus the shared group; an admin gets every owner's VMs,
 * owner by owner. `days` is the usage window (clamped 1–90).
 */
export async function getProjectsView(
  user: { id: string; email: string; displayName: string; role: string },
  days = DEFAULT_USAGE_DAYS,
  now: Date = new Date(),
): Promise<ProjectsView> {
  const window = Math.min(Math.max(Number.isFinite(days) ? Math.floor(days) : DEFAULT_USAGE_DAYS, 1), 90);
  const since = new Date(now.getTime() - window * DAY_MS);

  if (user.role === 'admin') {
    const [vms, users, stats] = await Promise.all([
      prisma.virtualMachine.findMany({ select: VM_SELECT, orderBy: { name: 'asc' } }),
      prisma.user.findMany({
        select: { id: true, email: true, displayName: true, role: true },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      }),
      usageStats(null, since),
    ]);
    const byOwner = new Map<string, typeof vms>();
    for (const v of vms) byOwner.set(v.userId, [...(byOwner.get(v.userId) ?? []), v]);
    const owners = users
      .filter((u) => byOwner.has(u.id))
      .map((u) => ({
        owner: u,
        projects: groupByProject(
          byOwner.get(u.id)!.map((v) => ({ ...rowOf(v, v.userId === user.id ? 'owner' : 'admin'), tags: v.tags })),
          stats,
        ),
      }));
    return { days: window, owners, shared: null };
  }

  const shares = await prisma.vmShare.findMany({ where: { userId: user.id }, select: { vmId: true, role: true } });
  const shareRole = new Map(shares.map((s) => [s.vmId, normalizeShareRole(s.role)]));
  const vms = await prisma.virtualMachine.findMany({
    where: { OR: [{ userId: user.id }, { id: { in: [...shareRole.keys()] } }] },
    select: VM_SELECT,
    orderBy: { name: 'asc' },
  });
  const stats = await usageStats(vms.map((v) => v.id), since);

  const own = vms.filter((v) => v.userId === user.id);
  // A share row for a VM the caller owns is meaningless; ownership wins.
  const shared = vms.filter((v) => v.userId !== user.id && shareRole.has(v.id));
  const self = { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
  return {
    days: window,
    owners: own.length > 0 ? [{ owner: self, projects: groupByProject(own.map((v) => ({ ...rowOf(v, 'owner'), tags: v.tags })), stats) }] : [],
    shared:
      shared.length > 0
        ? rollupProject(null, shared.map((v) => rowOf(v, shareRole.get(v.id)!)), stats)
        : null,
  };
}

/** The fields a project row exposes — never the tags, so the shared group can't carry them. */
function rowOf(
  v: { id: string; name: string; type: string; status: string; cpu: number; ram: number; storage: number },
  access: ProjectVm['access'],
): RollupRow {
  return { id: v.id, name: v.name, type: v.type, status: v.status, cpu: v.cpu, ram: v.ram, storage: v.storage, access };
}

// ─── Assignment ──────────────────────────────────────────────

export interface AssignResult {
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * Put VMs into project `name` (or take them out with null). Owner-or-admin per
 * VM, the same gate the bulk power route uses; a VM the caller doesn't own is
 * reported as "not found", exactly like one that doesn't exist.
 */
export async function assignProject(
  user: { id: string; role: string },
  ids: string[],
  name: string | null,
): Promise<AssignResult[]> {
  const unique = [...new Set(ids)];
  const vms = await prisma.virtualMachine.findMany({
    where: { id: { in: unique }, ...(user.role === 'admin' ? {} : { userId: user.id }) },
    select: { id: true, tags: true },
  });
  const found = new Map(vms.map((v) => [v.id, v]));
  const results: AssignResult[] = [];
  for (const id of unique) {
    const vm = found.get(id);
    if (!vm) { results.push({ id, ok: false, error: 'not found' }); continue; }
    const tags = withProject(vm.tags, name);
    if (tags !== vm.tags) await prisma.virtualMachine.update({ where: { id }, data: { tags } });
    results.push({ id, ok: true });
  }
  return results;
}
