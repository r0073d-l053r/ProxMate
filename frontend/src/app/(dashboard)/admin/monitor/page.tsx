"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Crown, User, Activity, ServerOff } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { UserGroup, LiveStats } from "@/lib/types";
import { formatRam } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LiveVmCard } from "@/components/admin/live-vm-card";

/** Polling cadence for live metrics. Single shared loop across all cards. */
const POLL_MS = 1000;

export default function AdminMonitorPage() {
  const [groups, setGroups] = useState<UserGroup[] | null>(null);
  const [stats, setStats] = useState<LiveStats>({});
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [lastTick, setLastTick] = useState<number | null>(null);
  const inFlight = useRef(false);

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

  // Single shared 1Hz poll loop for live stats.
  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      // Pause polling when the tab isn't visible — there's no one watching.
      if (document.visibilityState !== "visible") return;
      // Drop overlapping ticks if a previous request is still in flight.
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await api.get<LiveStats>("/admin/live-stats");
        if (!cancelled) {
          setStats(res.data);
          setLastTick(Date.now());
          setStatsError(null);
        }
      } catch (err) {
        if (!cancelled) setStatsError(apiError(err));
      } finally {
        inFlight.current = false;
      }
    };

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const totalVms = groups?.reduce((n, g) => n + g.vms.length, 0) ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Monitor"
        description="Live CPU, memory, and network for every VM on the cluster, grouped by owner."
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Activity className={statsError ? "size-3 text-destructive" : "size-3 text-emerald-500"} />
          {statsError
            ? "metrics unreachable"
            : `live · last ${lastTick ? Math.round((Date.now() - lastTick) / 1000) : "—"}s ago`}
        </div>
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
