"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Play, Power, Square, RotateCw, Terminal, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { VirtualMachine, LiveVmStats } from "@/lib/types";
import { formatBytes, formatUptime } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { VmStatusBadge } from "@/components/vm/vm-status-badge";
import { Sparkline } from "@/components/admin/sparkline";

/** Rolling buffer length — 60 samples × 1Hz = 1 minute of history. */
const SAMPLES = 60;

interface Props {
  vm: VirtualMachine;
  live: LiveVmStats | undefined;
  onActionDone: () => void;
}

function pushSample(buf: number[], value: number): number[] {
  // Mutate-then-snapshot pattern; we want a new array reference each tick so
  // React re-renders the sparkline.
  const next = buf.length >= SAMPLES ? buf.slice(1) : buf.slice();
  next.push(value);
  return next;
}

export function LiveVmCard({ vm, live, onActionDone }: Props) {
  const [cpuSeries, setCpuSeries] = useState<number[]>([]);
  const [memSeries, setMemSeries] = useState<number[]>([]);
  const [netSeries, setNetSeries] = useState<number[]>([]);
  const lastNetRef = useRef<{ in: number; out: number; ts: number } | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!live) return;
    // Record CPU as percentage of *allocated* cores (matches Proxmox UI feel).
    setCpuSeries((b) => pushSample(b, live.cpu * 100));
    setMemSeries((b) => pushSample(b, live.maxmem > 0 ? (live.mem / live.maxmem) * 100 : 0));

    // Net is a counter; convert to instantaneous bytes/sec since last tick.
    const now = Date.now();
    let rate = 0;
    if (lastNetRef.current) {
      const dt = (now - lastNetRef.current.ts) / 1000;
      if (dt > 0) {
        const dIn = Math.max(0, live.netin - lastNetRef.current.in);
        const dOut = Math.max(0, live.netout - lastNetRef.current.out);
        rate = (dIn + dOut) / dt;
      }
    }
    lastNetRef.current = { in: live.netin, out: live.netout, ts: now };
    setNetSeries((b) => pushSample(b, rate));
  }, [live]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setPending(label);
    try {
      await fn();
      toast.success(`${label} sent`);
      onActionDone();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setPending(null);
    }
  }

  const running = (live?.status ?? vm.status) === "running";
  const stopped = (live?.status ?? vm.status) === "stopped";

  const cpuNow = live ? (live.cpu * 100).toFixed(1) + "%" : "—";
  const memNow = live ? `${formatBytes(live.mem)} / ${formatBytes(live.maxmem)}` : "—";
  const netPeak = netSeries.length > 0 ? Math.max(...netSeries) : 0;
  const netMaxScale = Math.max(netPeak, 64 * 1024); // never autoscale below 64 KB/s so idle stays flat

  return (
    <Card className="grid gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link href={`/vms/${vm.id}`} className="truncate text-sm font-medium hover:underline">
              {vm.name}
            </Link>
            <VmStatusBadge status={(live?.status ?? vm.status) as VirtualMachine["status"]} />
          </div>
          <div className="text-xs text-muted-foreground">
            VMID {vm.proxmoxVmId} · {vm.proxmoxNode} · {vm.cpu} vCPU · {formatBytes(vm.ram * 1024 * 1024)} ·{" "}
            {vm.storage} GB · uptime {formatUptime(live?.uptime ?? 0)}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={!!pending || running}
            onClick={() => act("Start", () => api.post(`/vms/${vm.id}/start`))}
            title="Start"
          >
            {pending === "Start" ? <Loader2 className="animate-spin" /> : <Play />}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!pending || stopped}
            onClick={() => act("Shutdown", () => api.post(`/vms/${vm.id}/stop`))}
            title="Graceful shutdown (ACPI)"
          >
            {pending === "Shutdown" ? <Loader2 className="animate-spin" /> : <Power />}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!!pending || stopped}
            onClick={() => act("Hard stop", () => api.post(`/vms/${vm.id}/stop?force=true`))}
            title="Hard power off"
          >
            {pending === "Hard stop" ? <Loader2 className="animate-spin" /> : <Square />}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!pending || !running}
            onClick={() => act("Reboot", () => api.post(`/vms/${vm.id}/restart`))}
            title="Reboot"
          >
            {pending === "Reboot" ? <Loader2 className="animate-spin" /> : <RotateCw />}
          </Button>
          <Button
            size="sm"
            variant="outline"
            render={<Link href={`/vms/${vm.id}/console`} />}
            disabled={!running}
            title="Open noVNC console"
          >
            <Terminal />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Sparkline title="CPU" values={cpuSeries} max={100} currentLabel={cpuNow} color="oklch(0.7 0.15 250)" />
        <Sparkline
          title="Memory"
          values={memSeries}
          max={100}
          currentLabel={memNow}
          color="oklch(0.62 0.13 200)"
        />
        <Sparkline
          title="Network"
          values={netSeries}
          max={netMaxScale}
          currentLabel={`${formatBytes(netSeries[netSeries.length - 1] ?? 0)}/s`}
          peakLabel={`${formatBytes(netPeak)}/s`}
          color="oklch(0.7 0.16 60)"
        />
      </div>
    </Card>
  );
}
