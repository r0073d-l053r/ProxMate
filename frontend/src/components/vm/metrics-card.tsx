"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, LineChart } from "lucide-react";
import { api } from "@/lib/api";
import type { VmMetrics, VmLiveSample } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkline } from "@/components/dashboard/sparkline";
import { cn } from "@/lib/utils";

type MetricsView = "live" | "day" | "week";

const VIEWS: { key: MetricsView; label: string }[] = [
  { key: "live", label: "Live" },
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
];

/** Rolling window of 1 s live samples (2 minutes of history on screen). */
const LIVE_WINDOW = 120;

/** A metric block: label, current + peak %, and a history line. */
function MetricRow({
  label,
  series,
  color,
  tall,
  autoScale,
}: {
  label: string;
  series: number[];
  color: string;
  tall?: boolean;
  /** Zoom the y-axis to the data (live view) instead of a fixed 0–100 scale. */
  autoScale?: boolean;
}) {
  const now = series.length ? series[series.length - 1]! : 0;
  const peak = series.length ? Math.max(...series) : 0;
  // Zoomed-in view: scale to the observed peak (with headroom) so small
  // fluctuations are actually visible, but never stretch noise below 5%.
  const max = autoScale ? Math.max(5, Math.min(100, peak * 1.25)) : 100;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          now {now.toFixed(autoScale ? 1 : 0)}% · peak {peak.toFixed(autoScale ? 1 : 0)}%
        </span>
      </div>
      <Sparkline data={series} max={max} className={cn(tall ? "h-28" : "h-16", "w-full", color)} />
    </div>
  );
}

/**
 * CPU + memory for this VM. The **Live** view ticks every second — a rolling
 * two-minute window fed by `GET /vms/:id/live-stats` (a cached cluster-wide
 * sample, so per-second polling adds no Proxmox load) with a y-axis zoomed to
 * the activity. **Day** and **Week** read Proxmox's RRD history as before.
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
  const [view, setView] = useState<MetricsView>("live");
  const [metrics, setMetrics] = useState<VmMetrics | null>(null);
  const [error, setError] = useState(false);
  const [liveCpu, setLiveCpu] = useState<number[]>([]);
  const [liveMem, setLiveMem] = useState<number[]>([]);
  const [liveStale, setLiveStale] = useState(false);
  const inFlight = useRef(false);

  // ── Historical views (RRD day/week) ─────────────────────────────────
  const loadRrd = useCallback(
    async (tf: "day" | "week") => {
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
    if (view !== "live") loadRrd(view);
  }, [loadRrd, view]);

  // ── Live view: 1 s ticks into a rolling window ───────────────────────
  useEffect(() => {
    if (view !== "live") return;
    setLiveCpu([]);
    setLiveMem([]);
    setLiveStale(false);
    const tick = async () => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await api.get<VmLiveSample>(`/vms/${vmId}/live-stats`);
        const s = res.data;
        const cpuPct = (s.cpu ?? 0) * 100;
        const memPct = s.maxmem > 0 ? (s.mem / s.maxmem) * 100 : 0;
        setLiveCpu((b) => [...b.slice(-(LIVE_WINDOW - 1)), cpuPct]);
        setLiveMem((b) => [...b.slice(-(LIVE_WINDOW - 1)), memPct]);
        setLiveStale(false);
      } catch {
        setLiveStale(true);
      } finally {
        inFlight.current = false;
      }
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [view, vmId]);

  const points = metrics?.points ?? [];
  const rrdCpu = points.map((p) => (p.cpu ?? 0) * 100);
  const rrdMem = points.map((p) => (p.maxmem ? ((p.mem ?? 0) / p.maxmem) * 100 : 0));
  const hasRrdData = rrdCpu.some((v) => v > 0) || rrdMem.some((v) => v > 0);

  return (
    <Card className={cn(className)}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          {view === "live" ? (
            <Activity className="size-4 text-muted-foreground" />
          ) : (
            <LineChart className="size-4 text-muted-foreground" />
          )}
          {view === "live" ? "Live activity" : "Resource history"}
          {view === "live" && !liveStale && liveCpu.length > 0 && (
            <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
              updating every second
            </span>
          )}
        </CardTitle>
        <div className="flex gap-1 rounded-md border p-0.5" role="tablist">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={view === v.key}
              onClick={() => setView(v.key)}
              className={
                "rounded px-2 py-0.5 text-xs transition-colors " +
                (view === v.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {v.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {view === "live" ? (
          liveStale && liveCpu.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Couldn&apos;t read live stats — the VM may be stopped or Proxmox is unreachable.
            </p>
          ) : liveCpu.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Waiting for the first sample…</p>
          ) : (
            <div className="grid gap-4">
              <MetricRow label="CPU" series={liveCpu} color="text-sky-500" tall={tall} autoScale />
              <MetricRow label="Memory" series={liveMem} color="text-violet-500" tall={tall} autoScale />
            </div>
          )
        ) : error ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Couldn&apos;t load metrics — the VM may be unreachable on Proxmox.
          </p>
        ) : metrics === null ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
        ) : !hasRrdData ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No history for this window yet — Proxmox builds it up while the VM runs.
          </p>
        ) : (
          <div className="grid gap-4">
            <MetricRow label="CPU" series={rrdCpu} color="text-sky-500" tall={tall} />
            <MetricRow label="Memory" series={rrdMem} color="text-violet-500" tall={tall} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
