"use client";

import { useCallback, useEffect, useState } from "react";
import { LineChart } from "lucide-react";
import { api } from "@/lib/api";
import type { VmMetrics, RrdTimeframe } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkline } from "@/components/dashboard/sparkline";
import { cn } from "@/lib/utils";

const TIMEFRAMES: { key: RrdTimeframe; label: string }[] = [
  { key: "hour", label: "Hour" },
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
];

/** A small metric block: label, current + peak %, and a history sparkline. */
function MetricRow({
  label,
  series,
  color,
  tall,
}: {
  label: string;
  series: number[];
  color: string;
  tall?: boolean;
}) {
  const now = series.length ? series[series.length - 1]! : 0;
  const peak = series.length ? Math.max(...series) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          now {now.toFixed(0)}% · peak {peak.toFixed(0)}%
        </span>
      </div>
      <Sparkline data={series} max={100} className={cn(tall ? "h-28" : "h-16", "w-full", color)} />
    </div>
  );
}

/**
 * Historical CPU + memory for this VM, read from Proxmox's RRD store
 * (`GET /vms/:id/metrics`). Tenants couldn't see their own VM's trends before —
 * only the admin monitor did. Hour/Day/Week timeframes; Proxmox builds the
 * longer rollups over time, so a fresh VM starts mostly flat.
 */
export function MetricsCard({
  vmId,
  className,
  tall,
}: {
  vmId: string;
  className?: string;
  /** Larger charts for the dedicated Insights tab. */
  tall?: boolean;
}) {
  const [timeframe, setTimeframe] = useState<RrdTimeframe>("hour");
  const [metrics, setMetrics] = useState<VmMetrics | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(
    async (tf: RrdTimeframe) => {
      setMetrics(null);
      setError(false);
      try {
        const res = await api.get<VmMetrics>(`/vms/${vmId}/metrics`, { params: { timeframe: tf } });
        setMetrics(res.data);
      } catch {
        setError(true);
      }
    },
    [vmId],
  );

  useEffect(() => {
    load(timeframe);
  }, [load, timeframe]);

  const points = metrics?.points ?? [];
  const cpu = points.map((p) => (p.cpu ?? 0) * 100);
  const mem = points.map((p) => (p.maxmem ? ((p.mem ?? 0) / p.maxmem) * 100 : 0));
  const hasData = cpu.some((v) => v > 0) || mem.some((v) => v > 0);

  return (
    <Card className={cn(className)}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          <LineChart className="size-4 text-muted-foreground" />
          Resource history
        </CardTitle>
        <div className="flex gap-1 rounded-md border p-0.5" role="tablist">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              type="button"
              role="tab"
              aria-selected={timeframe === tf.key}
              onClick={() => setTimeframe(tf.key)}
              className={
                "rounded px-2 py-0.5 text-xs transition-colors " +
                (timeframe === tf.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {tf.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Couldn&apos;t load metrics — the VM may be unreachable on Proxmox.
          </p>
        ) : metrics === null ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
        ) : !hasData ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No history for this window yet — Proxmox builds it up while the VM runs.
          </p>
        ) : (
          <div className="grid gap-4">
            <MetricRow label="CPU" series={cpu} color="text-sky-500" tall={tall} />
            <MetricRow label="Memory" series={mem} color="text-violet-500" tall={tall} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
