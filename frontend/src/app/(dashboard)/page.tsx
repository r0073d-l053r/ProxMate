"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Cpu, MemoryStick, HardDrive, Plus, MonitorPlay } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { MeResponse, VirtualMachine, ClusterStats, UserGroup } from "@/lib/types";
import { formatRam, usedPercent } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { QuotaCard } from "@/components/dashboard/quota-card";
import { ClusterLoadCard } from "@/components/dashboard/cluster-load-card";
import { LiveUsageCard } from "@/components/dashboard/live-usage-card";
import { OwnerGroupHeader } from "@/components/dashboard/owner-group-header";
import { VmStatusBadge } from "@/components/vm/vm-status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** How often the admin dashboard refreshes live cluster capacity. */
const CLUSTER_POLL_MS = 3000;

/** Compact, clickable VM row used inside the dashboard lists. */
function VmRow({ vm }: { vm: VirtualMachine }) {
  return (
    <Link
      href={`/vms/${vm.id}`}
      className="flex items-center justify-between gap-3 py-2.5 transition-colors hover:text-foreground"
    >
      <div className="flex items-center gap-3">
        <MonitorPlay className="size-4 text-muted-foreground" />
        <div>
          <div className="text-sm font-medium">{vm.name}</div>
          <div className="text-xs text-muted-foreground">
            {vm.cpu} vCPU · {formatRam(vm.ram)} · {vm.storage} GB · {vm.proxmoxNode}
          </div>
        </div>
      </div>
      <VmStatusBadge status={vm.status} />
    </Link>
  );
}

export default function DashboardPage() {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  // Non-admin state
  const [me, setMe] = useState<MeResponse["user"] | null>(null);
  const [vms, setVms] = useState<VirtualMachine[] | null>(null);
  // Admin state
  const [cluster, setCluster] = useState<ClusterStats | null>(null);
  const [clusterError, setClusterError] = useState<string | null>(null);
  const [groups, setGroups] = useState<UserGroup[] | null>(null);
  // Rolling history for the cluster CPU/RAM activity sparklines.
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);

  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  // Initial data: owner-grouped VMs for admins, personal VMs + quota for users.
  useEffect(() => {
    if (isAdmin) {
      api
        .get<UserGroup[]>("/admin/all-vms")
        .then((res) => setGroups(res.data))
        .catch((err) => setError(apiError(err)));
    } else {
      api
        .get<VirtualMachine[]>("/vms")
        .then((res) => setVms(res.data))
        .catch((err) => setError(apiError(err)));
      api
        .get<MeResponse>("/auth/me")
        .then((res) => setMe(res.data.user))
        .catch((err) => setError(apiError(err)));
    }
  }, [isAdmin]);

  // Admin: poll live cluster capacity (paused when the tab is hidden).
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;

    const tick = async () => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await api.get<ClusterStats>("/admin/cluster-stats");
        if (!cancelled) {
          const c = res.data;
          setCluster(c);
          setClusterError(null);
          setCpuHist((h) => [...h, usedPercent(c.cpu.used, c.cpu.total)].slice(-40));
          setMemHist((h) => [...h, usedPercent(c.memory.used, c.memory.total)].slice(-40));
        }
      } catch (err) {
        if (!cancelled) setClusterError(apiError(err));
      } finally {
        inFlight.current = false;
      }
    };

    tick();
    const id = setInterval(tick, CLUSTER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isAdmin]);

  const ownerGroups = groups?.filter((g) => g.vms.length > 0) ?? [];
  const totalVms = groups?.reduce((n, g) => n + g.vms.length, 0) ?? 0;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Dashboard"
        description={
          isAdmin
            ? "Live cluster load and every VM, grouped by who's running it."
            : "Your resource usage and virtual machines at a glance."
        }
      >
        <Button render={<Link href="/vms/new" />}>
          <Plus />
          New VM
        </Button>
      </PageHeader>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {/* Top: total cluster load for admins, personal quota for users */}
      {isAdmin ? (
        clusterError && !cluster ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-destructive">
              Couldn&apos;t load cluster stats: {clusterError}
            </CardContent>
          </Card>
        ) : cluster ? (
          <ClusterLoadCard cluster={cluster} cpuHistory={cpuHist} memHistory={memHist} />
        ) : (
          <Skeleton className="h-64" />
        )
      ) : me ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <QuotaCard label="vCPU" icon={Cpu} used={me.quota.cpu.used} max={me.quota.cpu.max} display={(n) => `${n}`} />
          <QuotaCard label="Memory" icon={MemoryStick} used={me.quota.ram.used} max={me.quota.ram.max} display={formatRam} />
          <QuotaCard label="Storage" icon={HardDrive} used={me.quota.storage.used} max={me.quota.storage.max} display={(n) => `${n} GB`} />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      )}

      {/* Live current-usage sparklines for users (admins get the cluster trends above) */}
      {!isAdmin && me && (
        <div className="mt-4">
          <LiveUsageCard quota={me.quota} />
        </div>
      )}

      {/* VMs: grouped by owner for admins, a recent list for users */}
      {isAdmin ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Virtual machines by owner</CardTitle>
          </CardHeader>
          <CardContent>
            {groups === null ? (
              <div className="grid gap-2">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : totalVms === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <MonitorPlay className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No VMs on the cluster yet.</p>
                <Button render={<Link href="/vms/new" />} variant="outline">
                  <Plus />
                  Create your first VM
                </Button>
              </div>
            ) : (
              <div className="grid gap-6">
                {ownerGroups.map((g) => (
                  <section key={g.id} className="grid gap-1">
                    <OwnerGroupHeader group={g} />
                    <ul className="divide-y">
                      {g.vms.map((vm) => (
                        <li key={vm.id}>
                          <VmRow vm={vm} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Recent virtual machines</CardTitle>
          </CardHeader>
          <CardContent>
            {vms === null ? (
              <div className="grid gap-2">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : vms.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <MonitorPlay className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">You don&apos;t have any VMs yet.</p>
                <Button render={<Link href="/vms/new" />} variant="outline">
                  <Plus />
                  Create your first VM
                </Button>
              </div>
            ) : (
              <ul className="divide-y">
                {vms.slice(0, 6).map((vm) => (
                  <li key={vm.id}>
                    <VmRow vm={vm} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
