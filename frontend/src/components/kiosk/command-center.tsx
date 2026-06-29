"use client";

import { Cpu, MemoryStick, HardDrive, Boxes, Play, Square, Activity, ShieldCheck, ShieldAlert } from "lucide-react";
import type { ClusterStats, ClusterHealth, AuditEntry } from "@/lib/types";
import { formatBytes, usedPercent, formatRelative, formatUptime } from "@/lib/format";
import { Sparkline } from "@/components/dashboard/sparkline";
import { cn } from "@/lib/utils";

/** Colour ramp for a load percentage — green → amber → red. */
function loadColor(pct: number): string {
  if (pct >= 90) return "text-destructive";
  if (pct >= 75) return "text-amber-500";
  return "text-emerald-500";
}

/** Large radial gauge tuned to be readable across a room on a 7" panel. */
function BigGauge({
  pct,
  label,
  sub,
  icon: Icon,
}: {
  pct: number;
  label: string;
  sub: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const r = 42;
  const circ = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, pct)) / 100) * circ;
  const color = loadColor(pct);
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl bg-card/60 p-3">
      <div className="relative">
        <svg viewBox="0 0 100 100" className="size-32 -rotate-90 xl:size-36">
          <circle cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeWidth="8" className="text-muted" />
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            className={cn("transition-all duration-500", color)}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={cn("text-3xl font-bold tabular-nums xl:text-4xl", color)}>{pct}%</span>
        </div>
      </div>
      <div className="flex items-center gap-2 text-base font-semibold">
        <Icon className="size-5 text-muted-foreground" /> {label}
      </div>
      <span className="text-center text-sm text-muted-foreground tabular-nums">{sub}</span>
    </div>
  );
}

/** Big single-number tile (counts). */
function StatTile({
  value,
  label,
  icon: Icon,
  tone = "default",
}: {
  value: number | string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "good" | "muted";
}) {
  const valueColor =
    tone === "good" ? "text-emerald-500" : tone === "muted" ? "text-muted-foreground" : "text-foreground";
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-2xl bg-card/60 p-3">
      <Icon className="size-5 text-muted-foreground" />
      <span className={cn("text-4xl font-bold tabular-nums", valueColor)}>{value}</span>
      <span className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

function barColor(pct: number): string {
  if (pct >= 90) return "bg-destructive";
  if (pct >= 75) return "bg-amber-500";
  return "bg-emerald-500";
}

function MiniBar({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="mb-1 flex items-center gap-2 last:mb-0">
      <span className="w-8 text-[10px] font-medium text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", barColor(pct))} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

/** Per-node health row (pve-0/1/2): online dot, CPU/MEM bars, uptime. */
function NodeStrip({ health }: { health: ClusterHealth | null }) {
  return (
    <div className="rounded-2xl bg-card/60 p-3">
      <div className="mb-2 flex items-center justify-between text-sm font-semibold text-muted-foreground">
        <span>Nodes</span>
        {health && (
          <span className="tabular-nums">
            {health.online}/{health.expected} online
          </span>
        )}
      </div>
      {!health || health.nodes.length === 0 ? (
        <div className="py-3 text-center text-sm text-muted-foreground">No node data.</div>
      ) : (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${Math.min(health.nodes.length, 4)}, minmax(0, 1fr))` }}
        >
          {health.nodes.map((n) => {
            const cpuPct = Math.round(n.cpu * 100);
            const memPct = n.mem.total > 0 ? Math.round((n.mem.used / n.mem.total) * 100) : 0;
            return (
              <div key={n.name} className={cn("rounded-xl bg-background/40 p-2.5", !n.online && "opacity-50")}>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <span className={cn("size-2 rounded-full", n.online ? "bg-emerald-500" : "bg-destructive")} />
                    {n.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {n.online ? formatUptime(n.uptime) : "offline"}
                  </span>
                </div>
                <MiniBar label="CPU" pct={cpuPct} />
                <MiniBar label="MEM" pct={memPct} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Cluster quorum verdict — the single most important homelab status. */
function QuorumTile({ health }: { health: ClusterHealth | null }) {
  const quorate = health?.quorate ?? false;
  const Icon = quorate ? ShieldCheck : ShieldAlert;
  const tone = quorate ? "text-emerald-500" : "text-destructive";
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-2xl bg-card/60 p-3">
      <Icon className={cn("size-6", tone)} />
      <span className={cn("text-2xl font-bold", health ? tone : "text-foreground")}>
        {health ? (quorate ? "Quorate" : "Degraded") : "—"}
      </span>
      <span className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {health ? `${health.online}/${health.expected} nodes` : "Quorum"}
      </span>
    </div>
  );
}

/** Severity heuristic for the activity ticker dot. */
function severityDot(action: string): string {
  const a = action.toLowerCase();
  if (/(delete|destroy|force|fail|lock|error)/.test(a)) return "bg-destructive";
  if (/(stop|restart|reset|update|rollback)/.test(a)) return "bg-amber-500";
  return "bg-emerald-500";
}

function humanizeAction(action: string): string {
  return action
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function KioskCommandCenter({
  cluster,
  health,
  cpuHistory,
  memHistory,
  vmRunning,
  vmStopped,
  vmTotal,
  audit,
  clusterError,
}: {
  cluster: ClusterStats | null;
  health: ClusterHealth | null;
  cpuHistory: number[];
  memHistory: number[];
  vmRunning: number;
  vmStopped: number;
  vmTotal: number;
  audit: AuditEntry[];
  clusterError: string | null;
}) {
  const cpuPct = cluster ? usedPercent(cluster.cpu.used, cluster.cpu.total) : 0;
  const memPct = cluster ? usedPercent(cluster.memory.used, cluster.memory.total) : 0;
  const stPct = cluster ? usedPercent(cluster.storage.used, cluster.storage.total) : 0;

  return (
    <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Left: cluster load (gauges + trends) */}
      <section className="flex flex-col gap-4 lg:col-span-2">
        {clusterError ? (
          <div className="flex flex-1 items-center justify-center rounded-2xl bg-card/60 text-destructive">
            Cluster metrics unreachable — {clusterError}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-4">
              <BigGauge
                pct={cpuPct}
                label="CPU"
                icon={Cpu}
                sub={cluster ? `${cluster.cpu.used} / ${cluster.cpu.total} cores` : "—"}
              />
              <BigGauge
                pct={memPct}
                label="Memory"
                icon={MemoryStick}
                sub={cluster ? `${formatBytes(cluster.memory.used)} / ${formatBytes(cluster.memory.total)}` : "—"}
              />
              <BigGauge
                pct={stPct}
                label="Storage"
                icon={HardDrive}
                sub={cluster ? `${formatBytes(cluster.storage.used)} / ${formatBytes(cluster.storage.total)}` : "—"}
              />
            </div>
            <NodeStrip health={health} />
            <div className="grid flex-1 grid-cols-2 gap-4">
              <div className="flex flex-col rounded-2xl bg-card/60 p-4">
                <div className="mb-2 flex items-center justify-between text-sm text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Cpu className="size-4" /> CPU trend
                  </span>
                  <span className="tabular-nums">{cpuPct}%</span>
                </div>
                <div className="flex-1">
                  <Sparkline data={cpuHistory} max={100} className={cn("h-full", loadColor(cpuPct))} />
                </div>
              </div>
              <div className="flex flex-col rounded-2xl bg-card/60 p-4">
                <div className="mb-2 flex items-center justify-between text-sm text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <MemoryStick className="size-4" /> Memory trend
                  </span>
                  <span className="tabular-nums">{memPct}%</span>
                </div>
                <div className="flex-1">
                  <Sparkline data={memHistory} max={100} className={cn("h-full", loadColor(memPct))} />
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      {/* Right: counts + activity ticker */}
      <section className="flex min-h-0 flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <QuorumTile health={health} />
          <StatTile value={vmTotal} label="Guests" icon={Boxes} />
          <StatTile value={vmRunning} label="Running" icon={Play} tone="good" />
          <StatTile value={vmStopped} label="Stopped" icon={Square} tone="muted" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col rounded-2xl bg-card/60 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Activity className="size-4" /> Recent activity
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {audit.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">No recent activity.</div>
            ) : (
              audit.map((e) => (
                <div key={e.id} className="flex items-center gap-2.5 text-sm">
                  <span className={cn("size-2.5 shrink-0 rounded-full", severityDot(e.action))} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{humanizeAction(e.action)}</span>
                    {e.actorEmail && <span className="text-muted-foreground"> · {e.actorEmail}</span>}
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {formatRelative(e.createdAt)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
