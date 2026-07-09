import type { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma.js';
import * as pve from './proxmox.service.js';
import { migrateVmToNode } from './vm.service.js';
import { getConfig, setConfig } from './config.service.js';
import { recordAudit, type AuditActor } from './audit.service.js';

/**
 * Cluster Balancer — a DRS-style workload balancer for ProxMate's API-only model.
 *
 * It reads each node's memory load and live-migrates running, ProxMate-managed
 * guests off the hottest node onto the coldest until the cluster's memory-load
 * spread is within an admin-set tolerance. Memory is the binding constraint in
 * virtualization (it can't be safely overcommitted the way CPU can), so the plan
 * is computed and simulated on memory; CPU is surfaced for context only.
 *
 * Safety rails that make this "professional grade" rather than a naive mover:
 *   - only ProxMate-managed guests are ever moved (foreign guests are fixed load);
 *   - the architecture guardrail is honoured (never x86↔ARM);
 *   - anti-affinity groups (VM tag `aa:<group>`) are never co-located;
 *   - pinned guests (tag `pin`/`no-balance`, or the admin exclude list) never move;
 *   - every candidate move must strictly lower the peak node load, so the planner
 *     can't oscillate or overshoot;
 *   - a per-run cap bounds how much churn a single pass can cause.
 *
 * The core `planBalance` is a pure function (no Proxmox, no DB) so the algorithm
 * is fully unit-tested; the orchestrators below just gather inputs and apply.
 */

export type BalancerMode = 'off' | 'recommend' | 'auto';

export interface BalancerSettings {
  /** off = never act; recommend = surface a plan but only apply on demand; auto = apply on a schedule. */
  mode: BalancerMode;
  /** Imbalance tolerance in percentage points of memory load (5..50). */
  thresholdPct: number;
  /** Cap on migrations a single pass may schedule (1..20). */
  maxMoves: number;
  /** Proxmox VMIDs that must never be moved. */
  exclude: number[];
}

type Arch = 'amd64' | 'arm64' | 'unknown';

export interface BalancerNode {
  name: string;
  online: boolean;
  arch: Arch;
  memUsed: number;
  memTotal: number;
  cpu: number; // 0..1 host load fraction
}

export interface BalancerVm {
  vmId: string; // ProxMate DB id
  proxmoxVmId: number;
  name: string;
  node: string;
  memBytes: number; // live consumed memory
  running: boolean;
  antiAffinity: string[]; // group keys from `aa:<group>` tags
  excluded: boolean;
  /** Nodes this VM may migrate to (Proxmox `allowed_nodes`); undefined = unknown/
   *  unrestricted. Empty means it can't move at all (also reflected via `excluded`),
   *  e.g. disks on node-local storage no other node has. */
  allowedNodes?: string[];
}

export interface BalancerInput {
  nodes: BalancerNode[];
  vms: BalancerVm[];
  thresholdPct: number;
  maxMoves: number;
}

export interface BalancerMove {
  vmId: string;
  proxmoxVmId: number;
  name: string;
  fromNode: string;
  toNode: string;
  memBytes: number;
  reason: string;
}

export interface BalancerNodeView {
  name: string;
  online: boolean;
  arch: Arch;
  cpuPct: number; // 0..100
  memUsed: number;
  memTotal: number;
  loadPct: number; // memory load, 0..100
  vmCount: number; // movable guests currently placed here
}

export interface BalancePlan {
  /** True when current memory-load spread is already within tolerance. */
  balanced: boolean;
  reason: string;
  thresholdPct: number;
  currentSpreadPct: number;
  projectedSpreadPct: number;
  nodes: BalancerNodeView[]; // current placement
  projectedNodes: BalancerNodeView[]; // placement after `moves`
  moves: BalancerMove[];
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
const loadFrac = (used: number, total: number): number => (total > 0 ? used / total : 0);

/**
 * Pure DRS planner. Given a snapshot of node memory + movable guests, greedily
 * relocates guests from the hottest node to the coldest — accepting a move only
 * when it strictly lowers the peak load — until the spread is within tolerance,
 * no improving move remains, or the move cap is hit.
 */
export function planBalance(input: BalancerInput): BalancePlan {
  const onlineNodes = input.nodes.filter((n) => n.online && n.memTotal > 0);
  const threshold = Math.max(0, input.thresholdPct) / 100;

  const total = new Map(onlineNodes.map((n) => [n.name, n.memTotal]));
  const arch = new Map(onlineNodes.map((n) => [n.name, n.arch]));
  const cpu = new Map(onlineNodes.map((n) => [n.name, n.cpu]));
  // Projected used-memory per node, mutated as moves are simulated.
  const used = new Map(onlineNodes.map((n) => [n.name, n.memUsed]));

  const movable = input.vms.filter((v) => v.running && !v.excluded && used.has(v.node));
  const mem = new Map(movable.map((v) => [v.vmId, v.memBytes]));
  const vmById = new Map(movable.map((v) => [v.vmId, v]));
  const placement = new Map(movable.map((v) => [v.vmId, v.node])); // mutated as moves apply

  const at = (node: string): number => loadFrac(used.get(node)!, total.get(node)!);
  const spread = (): number => {
    let max = -Infinity;
    let min = Infinity;
    for (const n of onlineNodes) {
      const l = at(n.name);
      if (l > max) max = l;
      if (l < min) min = l;
    }
    return onlineNodes.length ? max - min : 0;
  };
  const view = (): BalancerNodeView[] =>
    onlineNodes.map((n) => ({
      name: n.name,
      online: true,
      arch: arch.get(n.name)!,
      cpuPct: round1(cpu.get(n.name)! * 100),
      memUsed: used.get(n.name)!,
      memTotal: total.get(n.name)!,
      loadPct: round1(at(n.name) * 100),
      vmCount: [...placement.values()].filter((p) => p === n.name).length,
    }));

  const currentNodes = view();
  const currentSpread = spread();
  const balanced = currentSpread <= threshold;

  if (onlineNodes.length < 2) {
    return {
      balanced: true,
      reason: 'Load balancing needs at least two online nodes.',
      thresholdPct: input.thresholdPct,
      currentSpreadPct: round1(currentSpread * 100),
      projectedSpreadPct: round1(currentSpread * 100),
      nodes: currentNodes,
      projectedNodes: currentNodes,
      moves: [],
    };
  }

  const moves: BalancerMove[] = [];
  const moved = new Set<string>();

  // Anti-affinity: would placing `vm` on `target` co-locate it with another guest
  // that shares one of its `aa:<group>` keys (using the projected placement)?
  const conflicts = (vm: BalancerVm, target: string): boolean => {
    if (vm.antiAffinity.length === 0) return false;
    for (const [id, node] of placement) {
      if (id === vm.vmId || node !== target) continue;
      const other = vmById.get(id)!;
      if (other.antiAffinity.some((g) => vm.antiAffinity.includes(g))) return true;
    }
    return false;
  };

  while (moves.length < input.maxMoves && spread() > threshold) {
    const ranked = [...onlineNodes].sort((a, b) => at(b.name) - at(a.name));
    const hot = ranked[0]!.name;
    const cold = ranked[ranked.length - 1]!.name;
    if (hot === cold) break;
    const peakBefore = at(hot);

    const candidates = [...placement.entries()]
      .filter(([id, node]) => node === hot && !moved.has(id))
      .map(([id]) => vmById.get(id)!);

    let best: { vm: BalancerVm; peakAfter: number } | null = null;
    for (const vm of candidates) {
      const sa = arch.get(hot)!;
      const da = arch.get(cold)!;
      if (sa !== 'unknown' && da !== 'unknown' && sa !== da) continue; // arch guardrail
      // Storage/migratability: never propose a move to a node the VM can't land on
      // (Proxmox `allowed_nodes`) — e.g. its disk storage isn't defined there.
      if (vm.allowedNodes && !vm.allowedNodes.includes(cold)) continue;
      if (conflicts(vm, cold)) continue; // anti-affinity

      const m = mem.get(vm.vmId)!;
      const peakAfter = Math.max(
        (used.get(hot)! - m) / total.get(hot)!,
        (used.get(cold)! + m) / total.get(cold)!,
      );
      if (peakAfter >= peakBefore) continue; // must strictly improve the peak
      if (!best || peakAfter < best.peakAfter) best = { vm, peakAfter };
    }

    if (!best) break; // nothing on the hottest node can be improved onto the coldest

    const m = mem.get(best.vm.vmId)!;
    used.set(hot, used.get(hot)! - m);
    used.set(cold, used.get(cold)! + m);
    placement.set(best.vm.vmId, cold);
    moved.add(best.vm.vmId);
    moves.push({
      vmId: best.vm.vmId,
      proxmoxVmId: best.vm.proxmoxVmId,
      name: best.vm.name,
      fromNode: hot,
      toNode: cold,
      memBytes: m,
      reason: `Relieve ${hot} → ${cold}`,
    });
  }

  const projectedSpread = spread();
  let reason: string;
  if (moves.length > 0) {
    reason = `${moves.length} migration${moves.length === 1 ? '' : 's'} would cut memory-load spread from ${round1(currentSpread * 100)}% to ${round1(projectedSpread * 100)}%.`;
  } else if (balanced) {
    reason = `Cluster is balanced — node memory load is within ${input.thresholdPct}%.`;
  } else {
    reason = `Memory load is uneven (${round1(currentSpread * 100)}% spread), but no migration that respects architecture and anti-affinity rules would improve it.`;
  }

  return {
    balanced,
    reason,
    thresholdPct: input.thresholdPct,
    currentSpreadPct: round1(currentSpread * 100),
    projectedSpreadPct: round1(projectedSpread * 100),
    nodes: currentNodes,
    projectedNodes: view(),
    moves,
  };
}

// ─── Settings (persisted in SystemConfig) ─────────────────────

const DEFAULTS: BalancerSettings = { mode: 'off', thresholdPct: 15, maxMoves: 5, exclude: [] };

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseVmidCsv(raw: string | null): number[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((s) => Math.floor(Number(s.trim())))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ];
}

export async function getBalancerSettings(): Promise<BalancerSettings> {
  const [mode, threshold, maxMoves, exclude] = await Promise.all([
    getConfig('balancer_mode'),
    getConfig('balancer_threshold'),
    getConfig('balancer_max_moves'),
    getConfig('balancer_exclude'),
  ]);
  return {
    mode: mode === 'recommend' || mode === 'auto' ? mode : DEFAULTS.mode,
    thresholdPct: clampInt(threshold, 5, 50, DEFAULTS.thresholdPct),
    maxMoves: clampInt(maxMoves, 1, 20, DEFAULTS.maxMoves),
    exclude: parseVmidCsv(exclude),
  };
}

export async function saveBalancerSettings(s: BalancerSettings): Promise<BalancerSettings> {
  await Promise.all([
    setConfig('balancer_mode', s.mode),
    setConfig('balancer_threshold', String(s.thresholdPct)),
    setConfig('balancer_max_moves', String(s.maxMoves)),
    setConfig('balancer_exclude', s.exclude.join(',')),
  ]);
  return getBalancerSettings();
}

// ─── Orchestration (Proxmox + DB) ─────────────────────────────

/** A guest row from /cluster/resources?type=vm (qemu or lxc). */
interface VmResource {
  type: string;
  vmid?: number;
  name?: string;
  node?: string;
  status?: string;
  mem?: number;
  template?: number;
}

const PIN_TAGS = new Set(['pin', 'no-balance']);

function parseTags(csv: string | null): string[] {
  return (csv ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function antiAffinityGroups(tags: string[]): string[] {
  return tags.filter((t) => t.startsWith('aa:')).map((t) => t.slice(3)).filter(Boolean);
}

/** Gather a live snapshot of the cluster and compute a balance plan. */
export async function computeClusterPlan(
  settings?: BalancerSettings,
  client?: AxiosInstance,
): Promise<BalancePlan> {
  const s = settings ?? (await getBalancerSettings());
  const c = client ?? (await pve.getClient());

  const [health, archMap, resources, dbVms] = await Promise.all([
    pve.getNodesHealth(c),
    pve.getNodeArchMap(c),
    c.get<{ data: VmResource[] }>('/cluster/resources?type=vm'),
    prisma.virtualMachine.findMany(),
  ]);

  const resByVmid = new Map<number, VmResource>();
  for (const r of resources.data.data) {
    if (r.type === 'qemu' && typeof r.vmid === 'number') resByVmid.set(r.vmid, r);
  }

  const exclude = new Set(s.exclude);
  const vms: BalancerVm[] = dbVms.map((v) => {
    const r = resByVmid.get(v.proxmoxVmId);
    const tags = parseTags(v.tags);
    return {
      vmId: v.id,
      proxmoxVmId: v.proxmoxVmId,
      name: v.name,
      // Proxmox is authoritative for current placement (a VM may have moved outside ProxMate).
      node: r?.node ?? v.proxmoxNode,
      memBytes: r?.mem ?? 0,
      running: r?.status === 'running' && (r?.template ?? 0) !== 1,
      antiAffinity: antiAffinityGroups(tags),
      // Treated as pinned (the planner never moves them): containers (LXC has no
      // live migration) and VMs with a PCI/GPU device attached (passthrough
      // pins a guest to its host). Plus admin excludes and pin tags.
      excluded:
        v.type === 'lxc' ||
        v.hasPassthrough ||
        exclude.has(v.proxmoxVmId) ||
        tags.some((t) => PIN_TAGS.has(t)),
    };
  });

  const nodes: BalancerNode[] = health.nodes.map((n) => ({
    name: n.name,
    online: n.online,
    arch: archMap.get(n.name) ?? 'unknown',
    memUsed: n.mem.used,
    memTotal: n.mem.total,
    cpu: n.cpu,
  }));

  // Storage-pinning guard: a VM whose disks live on node-local storage no other
  // node has (e.g. a local ZFS pool like `tank`) can't be migrated at all — Proxmox
  // rejects it. Ask Proxmox which nodes each *running, otherwise-movable* VM may go
  // to and record it, pinning the ones with nowhere to land, so the planner never
  // proposes an impossible move. Fail-open: an unreadable preflight (null) leaves
  // the VM unrestricted (the apply re-validates and now surfaces a clear reason).
  const candidates = vms.filter((v) => v.running && !v.excluded);
  const targetLists = await Promise.all(
    candidates.map((v) => pve.migratableTargets(v.node, v.proxmoxVmId, c)),
  );
  candidates.forEach((v, i) => {
    const allowed = targetLists[i];
    if (allowed === null) return; // unknown → leave unrestricted
    v.allowedNodes = allowed;
    if (allowed.length === 0) v.excluded = true; // nowhere to migrate → pin it
  });

  return planBalance({ nodes, vms, thresholdPct: s.thresholdPct, maxMoves: s.maxMoves });
}

export interface MigrationResult {
  vmId: string;
  name: string;
  fromNode: string;
  toNode: string;
  ok: boolean;
  error?: string;
}

/**
 * Apply a set of moves sequentially. Each migration re-validates through
 * `migrateVmToNode` (arch guardrail, node existence, live-vs-offline), so stale
 * or hand-crafted move lists can't bypass the safety checks. Runs one at a time
 * to avoid hammering a source node with concurrent live migrations.
 */
export async function runMigrations(
  moves: { vmId: string; toNode: string }[],
  actor?: AuditActor,
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];
  for (const mv of moves) {
    const vm = await prisma.virtualMachine.findUnique({ where: { id: mv.vmId } });
    if (!vm) {
      results.push({ vmId: mv.vmId, name: mv.vmId, fromNode: '?', toNode: mv.toNode, ok: false, error: 'VM not found' });
      continue;
    }
    const from = vm.proxmoxNode;
    try {
      // Notify the owner only for admin-initiated moves (manual apply / drain),
      // i.e. when an actor is present — never for routine auto-balancing.
      await migrateVmToNode(vm, mv.toNode, { notifyOwner: !!actor, actorId: actor?.id });
      results.push({ vmId: vm.id, name: vm.name, fromNode: from, toNode: mv.toNode, ok: true });
      await recordAudit({
        action: 'balancer.migrate',
        actor: actor ?? null,
        targetType: 'vm',
        targetId: vm.id,
        detail: `${from} → ${mv.toNode}`,
      });
    } catch (err) {
      // Extract Proxmox's real reason (e.g. "storage 'tank' is not available on
      // node 'pve-3'") — the raw axios message is just "Request failed with status
      // code 500", which is what the audit log used to (unhelpfully) record.
      const error = pve.pveMessage(err);
      results.push({ vmId: vm.id, name: vm.name, fromNode: from, toNode: mv.toNode, ok: false, error });
      await recordAudit({
        action: 'balancer.migrate_failed',
        actor: actor ?? null,
        targetType: 'vm',
        targetId: vm.id,
        detail: `${from} → ${mv.toNode}: ${error}`,
      });
    }
  }
  return results;
}

/**
 * Scheduler entry point: when auto mode is on, compute and apply a plan. Awaited
 * by the balancer cron tick; a no-op (and cheap) when the mode is off/recommend.
 */
export async function runAutoBalance(): Promise<{ applied: number; reason: string }> {
  const settings = await getBalancerSettings();
  if (settings.mode !== 'auto') return { applied: 0, reason: 'auto mode is off' };

  const plan = await computeClusterPlan(settings);
  if (plan.moves.length === 0) return { applied: 0, reason: plan.reason };

  const results = await runMigrations(plan.moves.map((m) => ({ vmId: m.vmId, toNode: m.toNode })));
  const applied = results.filter((r) => r.ok).length;
  await recordAudit({ action: 'balancer.auto_run', detail: `${applied}/${results.length} migrations applied` });
  return { applied, reason: plan.reason };
}

// ─── Maintenance: node drain (evacuate before powering off) ───
//
// Before an admin takes a node down for maintenance, evacuate every
// ProxMate-managed guest off it — live-migrating running guests (no downtime
// with shared storage) and offline-migrating stopped ones. Either spread them
// onto best-fit nodes automatically, or push them all to one chosen target.

export interface DrainGuest {
  vmId: string;
  proxmoxVmId: number;
  name: string;
  memBytes: number;
  running: boolean;
  antiAffinity: string[];
  /** Nodes this guest may migrate to (Proxmox `allowed_nodes`); undefined = unknown/
   *  unrestricted (fail open). An empty array means it can't be evacuated at all —
   *  its disks are on node-local storage no other node has. */
  allowedNodes?: string[];
}

export interface DrainMove {
  vmId: string;
  proxmoxVmId: number;
  name: string;
  fromNode: string;
  toNode: string;
  memBytes: number;
  running: boolean; // true = live migration, false = offline
  reason: string;
}

export interface DrainBlocker {
  proxmoxVmId: number;
  name: string;
  reason: string;
}

export interface DrainPlan {
  node: string;
  targetNode: string | null; // null = auto best-fit
  /** True when every managed guest on the node has a placement. */
  ok: boolean;
  reason: string;
  moves: DrainMove[];
  blockers: DrainBlocker[];
  targets: BalancerNodeView[]; // receiving nodes with projected load after the drain
}

export interface DrainInput {
  drainNode: string;
  targetNode: string | null;
  nodes: BalancerNode[]; // all nodes, including the one being drained
  guests: DrainGuest[]; // managed guests currently on the drain node
  occupants: { node: string; antiAffinity: string[] }[]; // managed guests elsewhere (for anti-affinity)
}

/**
 * Pure placement planner for a node drain. Greedily bin-packs the drained node's
 * guests (largest first) onto receiving nodes — best-fit by free memory, honoring
 * the architecture guardrail and anti-affinity. An explicit `targetNode` forces
 * every guest there (an admin override, so capacity/anti-affinity aren't enforced,
 * only architecture). No Proxmox/DB access → unit-tested directly.
 */
export function planDrain(input: DrainInput): DrainPlan {
  const { drainNode, targetNode } = input;
  const targets = input.nodes.filter((n) => n.online && n.name !== drainNode && n.memTotal > 0);
  const total = new Map(targets.map((n) => [n.name, n.memTotal]));
  const arch = new Map(targets.map((n) => [n.name, n.arch]));
  const cpu = new Map(targets.map((n) => [n.name, n.cpu]));
  const used = new Map(targets.map((n) => [n.name, n.memUsed]));

  const aaByNode = new Map<string, Set<string>>(targets.map((n) => [n.name, new Set<string>()]));
  for (const o of input.occupants) {
    const set = aaByNode.get(o.node);
    if (set) for (const g of o.antiAffinity) set.add(g);
  }

  const drainArch = input.nodes.find((n) => n.name === drainNode)?.arch ?? 'unknown';
  const archOk = (t: string): boolean => {
    const ta = arch.get(t)!;
    return drainArch === 'unknown' || ta === 'unknown' || ta === drainArch;
  };

  // Storage-locality guard: a present `allowedNodes` (from the migrate preflight)
  // is the authoritative set of nodes a guest can actually land on. `undefined`
  // means unknown → fail open (treat every node as reachable); an empty array
  // means its disks are on node-local storage no other node has → nowhere to go.
  const allowedOn = (g: DrainGuest, t: string): boolean => !g.allowedNodes || g.allowedNodes.includes(t);

  const moves: DrainMove[] = [];
  const blockers: DrainBlocker[] = [];
  const ordered = [...input.guests].sort((a, b) => b.memBytes - a.memBytes); // largest first
  const explicit = targetNode ? targets.find((n) => n.name === targetNode) : undefined;

  for (const g of ordered) {
    let pick: string | undefined;

    if (targetNode) {
      if (!explicit) {
        blockers.push({ proxmoxVmId: g.proxmoxVmId, name: g.name, reason: `Target ${targetNode} is offline or doesn't exist.` });
        continue;
      }
      if (!archOk(targetNode)) {
        blockers.push({ proxmoxVmId: g.proxmoxVmId, name: g.name, reason: `Architecture mismatch with ${targetNode}.` });
        continue;
      }
      if (!allowedOn(g, targetNode)) {
        blockers.push({ proxmoxVmId: g.proxmoxVmId, name: g.name, reason: `Its disks are on node-local storage ${targetNode} doesn't have — it can't be migrated there.` });
        continue;
      }
      pick = targetNode; // admin override — only the arch and storage-locality guardrails are enforced
    } else {
      const compatible = targets.filter((n) => archOk(n.name));
      if (compatible.length === 0) {
        blockers.push({ proxmoxVmId: g.proxmoxVmId, name: g.name, reason: 'No architecture-compatible node is available to receive it.' });
        continue;
      }
      // Drop nodes the guest's disks can't follow it to (storage-locality guard).
      const reachable = compatible.filter((n) => allowedOn(g, n.name));
      if (reachable.length === 0) {
        blockers.push({ proxmoxVmId: g.proxmoxVmId, name: g.name, reason: `Its disks are on node-local storage no other node has — there's nowhere to migrate ${g.name}.` });
        continue;
      }
      const safe = reachable.filter((n) => {
        if (g.antiAffinity.length === 0) return true;
        const set = aaByNode.get(n.name)!;
        return !g.antiAffinity.some((grp) => set.has(grp));
      });
      const pool = safe.length > 0 ? safe : reachable; // fall back if anti-affinity can't be met
      // Prefer nodes the guest actually fits on; among those, the most free memory.
      pick = pool
        .map((n) => {
          const freeAfter = total.get(n.name)! - (used.get(n.name)! + g.memBytes);
          return { name: n.name, fits: freeAfter >= 0, freeAfter };
        })
        .sort((a, b) => Number(b.fits) - Number(a.fits) || b.freeAfter - a.freeAfter)[0]!.name;
    }

    used.set(pick, used.get(pick)! + g.memBytes);
    if (g.antiAffinity.length) {
      const set = aaByNode.get(pick);
      if (set) for (const grp of g.antiAffinity) set.add(grp);
    }
    moves.push({
      vmId: g.vmId,
      proxmoxVmId: g.proxmoxVmId,
      name: g.name,
      fromNode: drainNode,
      toNode: pick,
      memBytes: g.memBytes,
      running: g.running,
      reason: g.running ? 'Live migration (no downtime)' : 'Offline migration (guest is stopped)',
    });
  }

  const targetsView: BalancerNodeView[] = targets.map((n) => ({
    name: n.name,
    online: true,
    arch: arch.get(n.name)!,
    cpuPct: round1(cpu.get(n.name)! * 100),
    memUsed: used.get(n.name)!,
    memTotal: total.get(n.name)!,
    loadPct: round1(loadFrac(used.get(n.name)!, total.get(n.name)!) * 100),
    vmCount: moves.filter((m) => m.toNode === n.name).length,
  }));

  const live = moves.filter((m) => m.running).length;
  const offline = moves.length - live;
  const ok = blockers.length === 0 && moves.length === input.guests.length;
  let reason: string;
  if (input.guests.length === 0) {
    reason = `No ProxMate-managed guests are on ${drainNode}.`;
  } else if (moves.length === 0) {
    reason = `Couldn't place any guest off ${drainNode} — see blockers below.`;
  } else {
    const how = live && offline ? `${live} live, ${offline} offline` : live ? 'live — no downtime' : 'offline';
    reason = `Evacuate ${moves.length} guest${moves.length === 1 ? '' : 's'} off ${drainNode} (${how}) ${targetNode ? `to ${targetNode}` : 'onto best-fit nodes'}.`;
  }

  return { node: drainNode, targetNode: targetNode ?? null, ok, reason, moves, blockers, targets: targetsView };
}

/** Gather a live snapshot and compute a drain plan for `node`. */
export async function planNodeDrain(
  node: string,
  targetNode?: string,
  client?: AxiosInstance,
): Promise<DrainPlan> {
  const c = client ?? (await pve.getClient());
  const [health, archMap, resources, dbVms] = await Promise.all([
    pve.getNodesHealth(c),
    pve.getNodeArchMap(c),
    c.get<{ data: VmResource[] }>('/cluster/resources?type=vm'),
    prisma.virtualMachine.findMany(),
  ]);

  const nodeNames = new Set(health.nodes.map((n) => n.name));
  if (!nodeNames.has(node)) throw new Error(`No such node "${node}".`);
  if (targetNode) {
    if (targetNode === node) throw new Error('Choose a different target node.');
    if (!nodeNames.has(targetNode)) throw new Error(`No such node "${targetNode}".`);
  }

  const dbByVmid = new Map(dbVms.map((v) => [v.proxmoxVmId, v]));
  const qemu = resources.data.data.filter((r) => r.type === 'qemu' && typeof r.vmid === 'number');

  const guests: DrainGuest[] = [];
  const unmanaged: DrainBlocker[] = [];
  const passthroughBlockers: DrainBlocker[] = [];
  for (const r of qemu) {
    if (r.node !== node || (r.template ?? 0) === 1) continue;
    const db = dbByVmid.get(r.vmid!);
    if (!db) {
      unmanaged.push({
        proxmoxVmId: r.vmid!,
        name: r.name ?? `VM ${r.vmid}`,
        reason: 'Not managed by ProxMate — migrate or power it off manually.',
      });
      continue;
    }
    // A VM with a PCI/GPU device attached can't be migrated — flag it instead.
    if (db.hasPassthrough) {
      passthroughBlockers.push({
        proxmoxVmId: db.proxmoxVmId,
        name: db.name,
        reason: 'Has PCI/GPU passthrough — can’t be migrated; stop it or detach the device first.',
      });
      continue;
    }
    guests.push({
      vmId: db.id,
      proxmoxVmId: db.proxmoxVmId,
      name: db.name,
      memBytes: r.mem ?? 0,
      running: r.status === 'running',
      antiAffinity: antiAffinityGroups(parseTags(db.tags)),
    });
  }

  // Ask Proxmox which nodes each running guest can actually migrate to (the
  // migrate preflight's `allowed_nodes`) so the planner never proposes evacuating
  // a guest whose disks live on node-local storage no other node has — that move
  // would only fail at apply. Only running guests are queried: Proxmox computes
  // `allowed_nodes` for running guests, and offline migration (stopped guests)
  // has looser constraints, so we leave those unrestricted. Fail open: a null
  // preflight (unreadable) leaves the guest unrestricted rather than blocked.
  await Promise.all(
    guests
      .filter((g) => g.running)
      .map(async (g) => {
        const allowed = await pve.migratableTargets(node, g.proxmoxVmId, c);
        if (allowed) g.allowedNodes = allowed; // null → leave unrestricted
      }),
  );

  const occupants: { node: string; antiAffinity: string[] }[] = [];
  for (const r of qemu) {
    if (r.node === node || (r.template ?? 0) === 1 || !r.node) continue;
    const db = dbByVmid.get(r.vmid!);
    if (!db) continue;
    occupants.push({ node: r.node, antiAffinity: antiAffinityGroups(parseTags(db.tags)) });
  }

  const nodes: BalancerNode[] = health.nodes.map((n) => ({
    name: n.name,
    online: n.online,
    arch: archMap.get(n.name) ?? 'unknown',
    memUsed: n.mem.used,
    memTotal: n.mem.total,
    cpu: n.cpu,
  }));

  // Containers on the drained node can't be live-migrated by ProxMate — surface
  // them as blockers so the admin stops/moves them by hand before powering off.
  const containerBlockers: DrainBlocker[] = resources.data.data
    .filter((r) => r.type === 'lxc' && typeof r.vmid === 'number' && r.node === node && (r.template ?? 0) !== 1)
    .map((r) => {
      const db = dbByVmid.get(r.vmid!);
      return {
        proxmoxVmId: r.vmid!,
        name: db?.name ?? r.name ?? `CT ${r.vmid}`,
        reason: 'Container (LXC) — ProxMate can’t live-migrate it; stop or move it manually.',
      };
    });

  const plan = planDrain({ drainNode: node, targetNode: targetNode ?? null, nodes, guests, occupants });
  if (unmanaged.length > 0) {
    plan.blockers.push(...unmanaged);
    plan.reason += ` ${unmanaged.length} guest${unmanaged.length === 1 ? '' : 's'} not managed by ProxMate must be moved or stopped manually.`;
  }
  if (containerBlockers.length > 0) {
    plan.blockers.push(...containerBlockers);
    plan.ok = false;
    plan.reason += ` ${containerBlockers.length} container${containerBlockers.length === 1 ? '' : 's'} must be moved or stopped manually (no live migration for LXC).`;
  }
  if (passthroughBlockers.length > 0) {
    plan.blockers.push(...passthroughBlockers);
    plan.ok = false;
    plan.reason += ` ${passthroughBlockers.length} VM${passthroughBlockers.length === 1 ? '' : 's'} with PCI/GPU passthrough must be stopped or detached first.`;
  }
  return plan;
}
