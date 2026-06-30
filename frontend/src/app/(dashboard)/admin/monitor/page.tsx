"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Crown, User, Activity, ServerOff, Maximize } from "lucide-react";
import { api, apiError, apiBaseUrl } from "@/lib/api";
import type { UserGroup, LiveStats } from "@/lib/types";
import { formatRam } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LiveVmCard } from "@/components/admin/live-vm-card";

/** Selectable refresh cadences for the live feed — crank it down for a btop-style,
 *  visibly-active stream. A short server-side cache on /admin/live-stats keeps the
 *  fast rates from hammering Proxmox. Single shared loop across all cards. */
const POLL_OPTIONS = [
  { ms: 100, label: "0.1s" },
  { ms: 250, label: "0.25s" },
  { ms: 500, label: "0.5s" },
  { ms: 1000, label: "1s" },
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
] as const;
const DEFAULT_POLL_MS = 100;
const POLL_STORAGE_KEY = "proxmate.monitor.pollMs";
const rateLabel = (ms: number) => POLL_OPTIONS.find((o) => o.ms === ms)?.label ?? `${ms}ms`;

export default function AdminMonitorPage() {
  const router = useRouter();
  const [groups, setGroups] = useState<UserGroup[] | null>(null);
  const [stats, setStats] = useState<LiveStats>({});
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [pollMs, setPollMs] = useState<number>(DEFAULT_POLL_MS);
  const inFlight = useRef(false);
  // Live-stats arrive via one server push (SSE); the render loop reads this ref at
  // the chosen cadence. If the stream drops, the loop falls back to HTTP polling.
  const latestRef = useRef<LiveStats>({});
  const sseOkRef = useRef(false);

  useEffect(() => {
    const es = new EventSource(`${apiBaseUrl}/admin/live-feed`, { withCredentials: true });
    es.onmessage = (e) => {
      try {
        latestRef.current = JSON.parse(e.data) as LiveStats;
        sseOkRef.current = true;
      } catch {
        /* keep the last good frame */
      }
    };
    es.onerror = () => {
      sseOkRef.current = false; // fall back to polling until the stream recovers
    };
    return () => es.close();
  }, []);

  // Restore the saved cadence after mount (avoids an SSR/hydration mismatch), and
  // persist any change.
  useEffect(() => {
    const saved = Number(localStorage.getItem(POLL_STORAGE_KEY));
    // One-time restore after mount — done in an effect (not a lazy initializer) so
    // the server/first-client render match the default and there's no hydration skew.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved && POLL_OPTIONS.some((o) => o.ms === saved)) setPollMs(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem(POLL_STORAGE_KEY, String(pollMs));
  }, [pollMs]);

  const loadGroups = useCallback(() => {
    api
      .get<UserGroup[]>("/admin/all-vms")
      .then((res) => {
        setGroups(res.data);
        setGroupsError(null);
      })
      .catch((err) => setGroupsError(apiError(err)));
  }, []);

  useEffect(loadGroups, [loadGroups]);

  // Single shared poll loop for live stats, at the chosen cadence.
  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      // Pause when the tab isn't visible — there's no one watching.
      if (document.visibilityState !== "visible") return;
      // SSE is delivering → just render the latest pushed frame (no HTTP).
      if (sseOkRef.current) {
        if (!cancelled) {
          setStats(latestRef.current);
          setStatsError(null);
        }
        return;
      }
      // Fallback path: poll the cached endpoint until the stream recovers.
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await api.get<LiveStats>("/admin/live-stats");
        if (!cancelled) {
          latestRef.current = res.data;
          setStats(res.data);
          setStatsError(null);
        }
      } catch (err) {
        if (!cancelled) setStatsError(apiError(err));
      } finally {
        inFlight.current = false;
      }
    };

    tick();
    const id = setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);

  const totalVms = groups?.reduce((n, g) => n + g.vms.length, 0) ?? 0;

  // Enter the full-screen, touch-friendly rack kiosk. Fullscreen needs a user
  // gesture — this click is it — then we route to the chromeless kiosk shell.
  const enterKiosk = async () => {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      /* unsupported / denied — the kiosk route still works, just not fullscreen */
    }
    router.push("/kiosk");
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Monitor"
        description="Live CPU, memory, and network for every VM on the cluster, grouped by owner."
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Activity
            className={statsError ? "size-3 text-destructive" : "size-3 animate-pulse text-emerald-500"}
          />
          {statsError ? "metrics unreachable" : `live · ${rateLabel(pollMs)}`}
        </div>
        <Select value={String(pollMs)} onValueChange={(v) => setPollMs(Number(v))}>
          <SelectTrigger className="h-8 w-[120px] text-xs" title="Live refresh rate">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POLL_OPTIONS.map((o) => (
              <SelectItem key={o.ms} value={String(o.ms)}>
                {o.label} refresh
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={enterKiosk}>
          <Maximize /> Kiosk mode
        </Button>
      </PageHeader>

      {groupsError && (
        <Card className="mb-4">
          <CardContent className="py-4 text-sm text-destructive">{groupsError}</CardContent>
        </Card>
      )}

      {groups === null ? (
        <div className="grid gap-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : totalVms === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <ServerOff className="size-6" />
            No VMs on the cluster yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6">
          {groups
            .filter((g) => g.vms.length > 0)
            .map((g) => (
              <section key={g.id} className="grid gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-1">
                  <div className="flex items-center gap-2">
                    {g.role === "admin" ? (
                      <Crown className="size-4 text-amber-500" />
                    ) : (
                      <User className="size-4 text-muted-foreground" />
                    )}
                    <h2 className="text-sm font-semibold">{g.displayName}</h2>
                    {g.role === "admin" && <Badge variant="secondary">Owner</Badge>}
                    <span className="text-xs text-muted-foreground">· {g.email}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {g.vms.length} VM{g.vms.length === 1 ? "" : "s"}
                    {g.role !== "admin" && (
                      <>
                        {" "}
                        · quota {g.quota.cpu} vCPU / {formatRam(g.quota.ram)} / {g.quota.storage} GB
                      </>
                    )}
                  </div>
                </div>

                <div className="grid gap-3">
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
  );
}
