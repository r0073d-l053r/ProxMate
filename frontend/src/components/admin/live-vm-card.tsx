"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/** Optimistic state while a power action is in flight, mirroring the VM-detail page. */
type Transition = "starting" | "stopping" | "restarting" | null;

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

  // Sustained power-action feedback: which transition is in flight, which button
  // kicked it off (so we spin the right one), and how long it's been running.
  const [transition, setTransition] = useState<Transition>(null);
  const [actingLabel, setActingLabel] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const transitionRef = useRef<Transition>(null);
  const startRef = useRef(0);
  const safety = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTrans = useCallback(() => {
    transitionRef.current = null;
    setTransition(null);
    setActingLabel(null);
    if (safety.current) {
      clearTimeout(safety.current);
      safety.current = null;
    }
  }, []);

  const beginTrans = useCallback(
    (t: Exclude<Transition, null>, label: string) => {
      transitionRef.current = t;
      setTransition(t);
      setActingLabel(label);
      startRef.current = Date.now();
      setElapsed(0);
      if (safety.current) clearTimeout(safety.current);
      // Never let the indicator get stuck if the VM never reports its target state.
      safety.current = setTimeout(clearTrans, 120_000);
    },
    [clearTrans],
  );

  // Feed the rolling sparkline buffers from each 1Hz live tick.
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

  // Clear the optimistic transition once the real status reaches its target. The
  // parent re-polls /admin/live-stats at 1Hz, so this resolves within ~1s of the
  // VM actually reaching the state. A reboot stays "running", so it's cleared by
  // a short timer in act() instead.
  const liveStatus = live?.status;
  useEffect(() => {
    const t = transitionRef.current;
    if (!t || !liveStatus) return;
    if (t === "starting" && liveStatus === "running") clearTrans();
    else if (t === "stopping" && (liveStatus === "stopped" || liveStatus === "error")) clearTrans();
  }, [liveStatus, clearTrans]);

  // Tick the elapsed-seconds counter while a transition is in flight.
  useEffect(() => {
    if (!transition) return;
    setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [transition]);

  // Clear any pending safety timeout on unmount.
  useEffect(() => () => clearTrans(), [clearTrans]);

  async function act(
    kind: Exclude<Transition, null>,
    label: string,
    fn: () => Promise<unknown>,
  ) {
    beginTrans(kind, label);
    try {
      await fn();
      onActionDone();
      if (kind === "restarting") {
        // A reboot stays "running", so there's no clean target status — clear it
        // after a grace period once the request is acknowledged.
        setTimeout(() => {
          if (transitionRef.current === "restarting") clearTrans();
        }, 8000);
      }
    } catch (err) {
      toast.error(apiError(err));
      clearTrans();
    }
  }

  const status = (live?.status ?? vm.status) as string;
  const running = status === "running";
  const stopped = status === "stopped";
  const busy = transition !== null;

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
            <VmStatusBadge status={transition ?? status} />
            {busy && (
              <span className="text-xs text-muted-foreground tabular-nums" title="Time in this transition">
                {elapsed}s
              </span>
            )}
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
            disabled={busy || running}
            onClick={() => act("starting", "Start", () => api.post(`/vms/${vm.id}/start`))}
            title="Start"
          >
            {actingLabel === "Start" ? <Loader2 className="animate-spin" /> : <Play />}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || stopped}
            onClick={() => act("stopping", "Shutdown", () => api.post(`/vms/${vm.id}/stop`))}
            title="Graceful shutdown (ACPI)"
          >
            {actingLabel === "Shutdown" ? <Loader2 className="animate-spin" /> : <Power />}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || stopped}
            onClick={() => act("stopping", "Hard stop", () => api.post(`/vms/${vm.id}/stop?force=true`))}
            title="Hard power off"
          >
            {actingLabel === "Hard stop" ? <Loader2 className="animate-spin" /> : <Square />}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !running}
            onClick={() => act("restarting", "Reboot", () => api.post(`/vms/${vm.id}/restart`))}
            title="Reboot"
          >
            {actingLabel === "Reboot" ? <Loader2 className="animate-spin" /> : <RotateCw />}
          </Button>
          <Button
            size="sm"
            variant="outline"
            render={<Link href={`/vms/${vm.id}/console`} />}
            disabled={!running || busy}
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
