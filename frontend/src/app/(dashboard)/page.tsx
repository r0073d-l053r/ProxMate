"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Cpu, MemoryStick, HardDrive, Plus, MonitorPlay, Server, Boxes } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { MeResponse, VirtualMachine, ClusterStats } from "@/lib/types";
import { formatRam, formatBytes } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { QuotaCard } from "@/components/dashboard/quota-card";
import { VmStatusBadge } from "@/components/vm/vm-status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardPage() {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  const [me, setMe] = useState<MeResponse["user"] | null>(null);
  const [cluster, setCluster] = useState<ClusterStats | null>(null);
  const [clusterError, setClusterError] = useState<string | null>(null);
  const [vms, setVms] = useState<VirtualMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<VirtualMachine[]>("/vms")
      .then((res) => setVms(res.data))
      .catch((err) => setError(apiError(err)));

    if (isAdmin) {
      api
        .get<ClusterStats>("/admin/cluster-stats")
        .then((res) => setCluster(res.data))
        .catch((err) => setClusterError(apiError(err)));
    } else {
      api
        .get<MeResponse>("/auth/me")
        .then((res) => setMe(res.data.user))
        .catch((err) => setError(apiError(err)));
    }
  }, [isAdmin]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Dashboard"
        description={
          isAdmin
            ? "Live cluster capacity and all virtual machines."
            : "Your resource usage and virtual machines at a glance."
        }
      >
        <Button render={<Link href="/vms/new" />}>
          <Plus />
          New VM
        </Button>
      </PageHeader>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {/* Resource cards: live cluster stats for admins, personal quota for users */}
      {isAdmin ? (
        clusterError ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-destructive">
              Couldn&apos;t load cluster stats: {clusterError}
            </CardContent>
          </Card>
        ) : cluster ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <QuotaCard label="vCPU (cores)" icon={Cpu} used={cluster.cpu.used} max={cluster.cpu.total} display={(n) => `${n}`} />
              <QuotaCard label="Memory" icon={MemoryStick} used={cluster.memory.used} max={cluster.memory.total} display={formatBytes} />
              <QuotaCard label="Storage" icon={HardDrive} used={cluster.storage.used} max={cluster.storage.total} display={formatBytes} />
            </div>
            <div className="mt-4 flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Server className="size-4" /> {cluster.nodes} node{cluster.nodes === 1 ? "" : "s"} online
              </span>
              <span className="flex items-center gap-1.5">
                <Boxes className="size-4" /> {cluster.vmCount} guest{cluster.vmCount === 1 ? "" : "s"} on the cluster
              </span>
            </div>
          </>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
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

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{isAdmin ? "Virtual machines" : "Recent virtual machines"}</CardTitle>
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
              <p className="text-sm text-muted-foreground">
                {isAdmin ? "No VMs on the cluster yet." : "You don't have any VMs yet."}
              </p>
              <Button render={<Link href="/vms/new" />} variant="outline">
                <Plus />
                Create your first VM
              </Button>
            </div>
          ) : (
            <ul className="divide-y">
              {vms.slice(0, 6).map((vm) => (
                <li key={vm.id}>
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
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
