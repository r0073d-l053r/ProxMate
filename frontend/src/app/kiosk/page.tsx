"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Server, Maximize, Minimize, X, LayoutDashboard, MonitorPlay, Activity, Crown, User, ServerOff } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { ClusterStats, ClusterHealth, LiveStats, UserGroup, AuditEntry } from "@/lib/types";
import { usedPercent, formatRam } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LiveVmCard } from "@/components/admin/live-vm-card";
import { KioskCommandCenter } from "@/components/kiosk/command-center";

const FAST_MS = 1000; // cluster + live VM stats
const GROUPS_MS = 5000; // VM inventory (rarely changes)
const AUDIT_MS = 15000; // activity ticker

type Tab = "overview" | "vms";

type WakeLockLike = { release: () => Promise<void> };

export default function KioskPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const [tab, setTab] = useState<Tab>("overview");
  const [now, setNow] = useState(() => Date.now());
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [cluster, setCluster] = useState<ClusterStats | null>(null);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  const [clusterError, setClusterError] = useState<string | null>(null);

  const [groups, setGroups] = useState<UserGroup[] | null>(null);
  const [health, setHealth] = useState<ClusterHealth | null>(null);
  const [stats, setStats] = useState<LiveStats>({});
  const [statsError, setStatsError] = useState<string | null>(null);
  const [lastTick, setLastTick] = useState<number | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  const fastInFlight = useRef(false);

  // Cluster shows cluster-wide data → admins only. AuthGuard (layout) guarantees
  // `user` is loaded by the time we render; bounce anyone else back to the app.
  useEffect(() => {
    if (user && user.role !== "admin") router.replace("/");
  }, [user, router]);

  const loadGroups = useCallback(() => {
    api
      .get<UserGroup[]>("/admin/all-vms")
      .then((res) => setGroups(res.data))
      .catch(() => {});
  }, []);

  // Fast loop: cluster-stats (+ rolling history) and per-VM live-stats together.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== "visible" || fastInFlight.current) return;
      fastInFlight.current = true;
      try {
        const [c, s] = await Promise.allSettled([
          api.get<ClusterStats>("/admin/cluster-stats"),
          api.get<LiveStats>("/admin/live-stats"),
        ]);
        if (cancelled) return;
        if (c.status === "fulfilled") {
          const cs = c.value.data;
          setCluster(cs);
          setClusterError(null);
          setCpuHist((h) => [...h, usedPercent(cs.cpu.used, cs.cpu.total)].slice(-40));
          setMemHist((h) => [...h, usedPercent(cs.memory.used, cs.memory.total)].slice(-40));
        } else {
          setClusterError(apiError(c.reason));
        }
        if (s.status === "fulfilled") {
          setStats(s.value.data);
          setStatsError(null);
          setLastTick(Date.now());
        } else {
          setStatsError(apiError(s.reason));
        }
      } finally {
        fastInFlight.current = false;
      }
    };
    tick();
    const id = setInterval(tick, FAST_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // VM inventory + per-node health (slower — these change rarely).
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      loadGroups();
      api
        .get<ClusterHealth>("/admin/nodes")
        .then((res) => {
          if (!cancelled) setHealth(res.data);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, GROUPS_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [loadGroups]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      api
        .get<AuditEntry[] | { entries: AuditEntry[] }>("/admin/audit")
        .then((res) => {
          if (cancelled) return;
          const data = res.data;
          const entries = Array.isArray(data) ? data : (data.entries ?? []);
          setAudit(entries.slice(0, 8));
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, AUDIT_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Clock.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Track fullscreen state for the toggle icon.
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    onChange();
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Keep the rack panel awake (re-acquire when the tab regains visibility).
  useEffect(() => {
    let sentinel: WakeLockLike | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<WakeLockLike> };
    };
    const acquire = async () => {
      try {
        if (nav.wakeLock && document.visibilityState === "visible") {
          sentinel = await nav.wakeLock.request("screen");
        }
      } catch {
        /* not supported / denied — non-fatal */
      }
    };
    acquire();
    const onVis = () => {
      if (document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      sentinel?.release().catch(() => {});
    };
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      /* user denied or unsupported */
    }
  };

  const exitKiosk = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* ignore */
    }
    router.push("/admin/monitor");
  };

  if (user && user.role !== "admin") return null;

  const allVms = groups?.flatMap((g) => g.vms) ?? [];
  const vmTotal = allVms.length;
  const vmRunning = allVms.filter((vm) => stats[vm.proxmoxVmId]?.status === "running").length;
  const vmStopped = vmTotal - vmRunning;

  return (
    <div className="fixed inset-0 z-50 flex cursor-none select-none flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Server className="size-5" />
          </div>
          <div className="leading-tight">
            <div className="text-base font-semibold">
              ProxMate <span className="text-muted-foreground">· Command Center</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {new Date(now).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </div>
          </div>
          <div className="ml-2 text-2xl font-semibold tabular-nums">
            {new Date(now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 rounded-xl bg-card/60 p-1">
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={LayoutDashboard}>
            Overview
          </TabButton>
          <TabButton active={tab === "vms"} onClick={() => setTab("vms")} icon={MonitorPlay}>
            VMs {vmTotal > 0 && <span className="opacity-70">({vmTotal})</span>}
          </TabButton>
        </div>

        <div className="flex items-center gap-2">
          <div className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Activity className={statsError ? "size-3.5 text-destructive" : "size-3.5 text-emerald-500"} />
            {statsError ? "offline" : `live · ${lastTick ? Math.round((now - lastTick) / 1000) : "—"}s`}
          </div>
          <button
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="flex size-11 items-center justify-center rounded-xl bg-card/60 transition-colors hover:bg-accent"
          >
            {isFullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
          </button>
          <button
            onClick={exitKiosk}
            aria-label="Exit kiosk mode"
            className="flex size-11 items-center justify-center rounded-xl bg-card/60 text-muted-foreground transition-colors hover:bg-destructive hover:text-white"
          >
            <X className="size-5" />
          </button>
        </div>
      </header>

      {/* Body */}
      <main className="min-h-0 flex-1 p-4">
        {tab === "overview" ? (
          <KioskCommandCenter
            cluster={cluster}
            health={health}
            cpuHistory={cpuHist}
            memHistory={memHist}
            vmRunning={vmRunning}
            vmStopped={vmStopped}
            vmTotal={vmTotal}
            audit={audit}
            clusterError={clusterError}
          />
        ) : (
          <div className="h-full overflow-y-auto pr-1">
            {groups === null ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
            ) : vmTotal === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <ServerOff className="size-6" /> No VMs on the cluster yet.
              </div>
            ) : (
              <div className="grid gap-5">
                {groups
                  .filter((g) => g.vms.length > 0)
                  .map((g) => (
                    <section key={g.id} className="grid gap-3">
                      <div className="flex items-center gap-2 border-b pb-1">
                        {g.role === "admin" ? (
                          <Crown className="size-4 text-amber-500" />
                        ) : (
                          <User className="size-4 text-muted-foreground" />
                        )}
                        <h2 className="text-sm font-semibold">{g.displayName}</h2>
                        {g.role !== "admin" && (
                          <span className="text-xs text-muted-foreground">
                            · quota {g.quota.cpu} vCPU / {formatRam(g.quota.ram)} / {g.quota.storage} GB
                          </span>
                        )}
                      </div>
                      <div className="grid gap-3 xl:grid-cols-2">
                        {g.vms.map((vm) => (
                          <LiveVmCard
                            key={vm.id}
                            vm={vm}
                            live={stats[vm.proxmoxVmId]}
                            onActionDone={loadGroups}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
      {children}
    </button>
  );
}
