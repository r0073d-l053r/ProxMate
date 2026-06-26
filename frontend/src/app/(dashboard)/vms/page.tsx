"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, MonitorPlay } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { VirtualMachine, UserGroup } from "@/lib/types";
import { formatRam, formatDate } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { OwnerGroupHeader } from "@/components/dashboard/owner-group-header";
import { VmStatusBadge } from "@/components/vm/vm-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** The VM table, reused for each owner group (admin) and the user's own list. */
function VmTable({ vms }: { vms: VirtualMachine[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Resources</TableHead>
          <TableHead>OS</TableHead>
          <TableHead>IP address</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {vms.map((vm) => (
          <TableRow key={vm.id}>
            <TableCell>
              <Link href={`/vms/${vm.id}`} className="font-medium hover:underline">
                {vm.name}
              </Link>
            </TableCell>
            <TableCell>
              <VmStatusBadge status={vm.status} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              {vm.cpu} vCPU · {formatRam(vm.ram)} · {vm.storage} GB
            </TableCell>
            <TableCell className="text-muted-foreground">{vm.os}</TableCell>
            <TableCell className="text-muted-foreground">{vm.ipAddress ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{formatDate(vm.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function VmsPage() {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const [vms, setVms] = useState<VirtualMachine[] | null>(null); // user view
  const [groups, setGroups] = useState<UserGroup[] | null>(null); // admin view
  const [error, setError] = useState<string | null>(null);

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
    }
  }, [isAdmin]);

  const ownerGroups = groups?.filter((g) => g.vms.length > 0) ?? [];
  const totalVms = groups?.reduce((n, g) => n + g.vms.length, 0) ?? 0;

  const loading = isAdmin ? groups === null : vms === null;
  const empty = isAdmin ? totalVms === 0 : vms?.length === 0;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Virtual Machines"
        description={isAdmin ? "Every VM on the cluster, separated by owner." : "Your virtual machines."}
      >
        <Button render={<Link href="/vms/new" />}>
          <Plus />
          New VM
        </Button>
      </PageHeader>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {loading ? (
        <Card>
          <CardContent className="grid gap-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </CardContent>
        </Card>
      ) : empty ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <MonitorPlay className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No virtual machines yet.</p>
            <Button render={<Link href="/vms/new" />} variant="outline">
              <Plus />
              Create your first VM
            </Button>
          </CardContent>
        </Card>
      ) : isAdmin ? (
        <div className="grid gap-4">
          {ownerGroups.map((g) => (
            <Card key={g.id}>
              <CardContent className="grid gap-3">
                <OwnerGroupHeader group={g} />
                <VmTable vms={g.vms} />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent>
            <VmTable vms={vms ?? []} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
