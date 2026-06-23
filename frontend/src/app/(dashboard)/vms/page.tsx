"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, MonitorPlay } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { VirtualMachine } from "@/lib/types";
import { formatRam, formatDate } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
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

export default function VmsPage() {
  const [vms, setVms] = useState<VirtualMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  useEffect(() => {
    api
      .get<VirtualMachine[]>("/vms")
      .then((res) => setVms(res.data))
      .catch((err) => setError(apiError(err)));
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Virtual Machines"
        description={isAdmin ? "All virtual machines across users." : "Your virtual machines."}
      >
        <Button render={<Link href="/vms/new" />}>
          <Plus />
          New VM
        </Button>
      </PageHeader>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {vms === null ? (
        <Card>
          <CardContent className="grid gap-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </CardContent>
        </Card>
      ) : vms.length === 0 ? (
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
      ) : (
        <Card>
          <CardContent>
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}
