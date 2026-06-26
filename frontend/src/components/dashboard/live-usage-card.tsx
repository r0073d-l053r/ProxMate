"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, Cpu, MemoryStick } from "lucide-react";
import { api } from "@/lib/api";
import type { LiveUsage, Quota } from "@/lib/types";
import { formatBytes, formatRam } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkline } from "./sparkline";

const POLL_MS = 3000;
const MAX_POINTS = 40;

/** Live CPU/RAM usage of the user's own running VMs, with rolling sparklines. */
export function LiveUsageCard({ quota }: { quota: Quota }) {
  const [usage, setUsage] = useState<LiveUsage | null>(null);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      inFlight.current = true;
      try {
        const r = await api.get<LiveUsage>("/vms/live-usage");
        if (cancelled) return;
        setUsage(r.data);
        setCpuHist((h) => [...h, r.data.cpu].slice(-MAX_POINTS));
        setMemHist((h) => [...h, r.data.mem].slice(-MAX_POINTS));
      } catch {
        /* transient — keep the last good values */
      } finally {
        inFlight.current = false;
      }
    };
    tick();
    const iv = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  const ramBytesMax = quota.ram.max * 1024 * 1024;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-muted-foreground" /> Live resource usage
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Cpu className="size-4" /> CPU in use
            </span>
            <span className="font-medium tabular-nums">
              {usage ? usage.cpu.toFixed(2) : "—"}{" "}
              <span className="text-xs font-normal text-muted-foreground">/ {quota.cpu.max} cores</span>
            </span>
          </div>
          <Sparkline data={cpuHist} max={quota.cpu.max || undefined} className="text-primary" />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <MemoryStick className="size-4" /> Memory in use
            </span>
            <span className="font-medium tabular-nums">
              {usage ? formatBytes(usage.mem) : "—"}{" "}
              <span className="text-xs font-normal text-muted-foreground">/ {formatRam(quota.ram.max)}</span>
            </span>
          </div>
          <Sparkline data={memHist} max={ramBytesMax || undefined} className="text-primary" />
        </div>
        {usage && usage.running === 0 && (
          <p className="text-center text-xs text-muted-foreground sm:col-span-2">
            No running VMs right now — start one to see live usage.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
