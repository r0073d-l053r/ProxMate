"use client";

import { Cpu, MemoryStick, HardDrive, Gauge as GaugeIcon, Server, Boxes } from "lucide-react";
import type { ClusterStats } from "@/lib/types";
import { formatBytes, usedPercent } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkline } from "./sparkline";
import { cn } from "@/lib/utils";

/** Tailwind text color for a load level — drives both the arc and the number. */
function loadColor(pct: number): string {
  if (pct >= 90) return "text-destructive";
  if (pct >= 75) return "text-amber-500";
  return "text-primary";
}

function RadialGauge({
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
    <div className="flex flex-col items-center gap-2">
      <div className="relative">
        {/* -rotate-90 starts the arc at 12 o'clock and sweeps clockwise */}
        <svg viewBox="0 0 100 100" className="size-24 -rotate-90 sm:size-28">
          <circle cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeWidth="9" className="text-muted" />
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            className={cn("transition-all duration-500", color)}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={cn("text-xl font-semibold tabular-nums sm:text-2xl", color)}>{pct}%</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" /> {label}
      </div>
      <span className="text-center text-xs text-muted-foreground tabular-nums">{sub}</span>
    </div>
  );
}

/** Aggregate cluster-wide load shown as three radial gauges (CPU / RAM / storage). */
export function ClusterLoadCard({
  cluster,
  cpuHistory,
  memHistory,
}: {
  cluster: ClusterStats;
  cpuHistory?: number[];
  memHistory?: number[];
}) {
  const cpuPct = usedPercent(cluster.cpu.used, cluster.cpu.total);
  const memPct = usedPercent(cluster.memory.used, cluster.memory.total);
  const stPct = usedPercent(cluster.storage.used, cluster.storage.total);
  const hasTrend = (cpuHistory?.length ?? 0) > 1 || (memHistory?.length ?? 0) > 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GaugeIcon className="size-4 text-muted-foreground" /> Total cluster load
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-3 gap-2">
          <RadialGauge pct={cpuPct} label="CPU" icon={Cpu} sub={`${cluster.cpu.used} / ${cluster.cpu.total} cores`} />
          <RadialGauge
            pct={memPct}
            label="Memory"
            icon={MemoryStick}
            sub={`${formatBytes(cluster.memory.used)} / ${formatBytes(cluster.memory.total)}`}
          />
          <RadialGauge
            pct={stPct}
            label="Storage"
            icon={HardDrive}
            sub={`${formatBytes(cluster.storage.used)} / ${formatBytes(cluster.storage.total)}`}
          />
        </div>
        {hasTrend && (
          <div className="grid grid-cols-2 gap-4 border-t pt-3">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Cpu className="size-3.5" /> CPU load
                </span>
                <span className="tabular-nums">{cpuPct}%</span>
              </div>
              <Sparkline data={cpuHistory ?? []} max={100} className="text-primary" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <MemoryStick className="size-3.5" /> Memory
                </span>
                <span className="tabular-nums">{memPct}%</span>
              </div>
              <Sparkline data={memHistory ?? []} max={100} className="text-primary" />
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-4 border-t pt-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Server className="size-3.5" /> {cluster.nodes} node{cluster.nodes === 1 ? "" : "s"} online
          </span>
          <span className="flex items-center gap-1.5">
            <Boxes className="size-3.5" /> {cluster.vmCount} guest{cluster.vmCount === 1 ? "" : "s"} on the cluster
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
