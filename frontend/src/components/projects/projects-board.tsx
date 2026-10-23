"use client";

import Link from "next/link";
import { Play, Square, RotateCw, Loader2, FolderKanban, Users, User, Crown } from "lucide-react";
import type { ProjectGroup, ProjectsView } from "@/lib/types";
import { formatBytes, formatRam } from "@/lib/format";
import { VmStatusBadge } from "@/components/vm/vm-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type BulkPower = "start" | "stop" | "restart";

/** One-line summary of a group's allocation and usage over the window. */
export function rollupSummary(g: ProjectGroup): string {
  const alloc = `${g.vmCount} VM${g.vmCount === 1 ? "" : "s"} · ${g.running} running · ${g.cpu} vCPU · ${formatRam(g.ram)} · ${g.storage} GB`;
  const usage =
    g.usage.samples > 0
      ? `avg CPU ${g.usage.avgCpuPct.toFixed(1)}% · avg RAM ${formatBytes(g.usage.avgMemBytes)}`
      : "no usage samples yet";
  return `${alloc} · ${usage}`;
}

function ProjectSection({
  title,
  group,
  busy,
  onBulk,
}: {
  title: React.ReactNode;
  group: ProjectGroup;
  busy: boolean;
  /** Absent for groups the caller can't act on in bulk (VMs shared with them). */
  onBulk?: (action: BulkPower, ids: string[]) => void;
}) {
  const ids = group.vms.map((v) => v.id);
  return (
    <section className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground tabular-nums">{rollupSummary(group)}</p>
        </div>
        {onBulk && (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onBulk("start", ids)}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />} Start all
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onBulk("stop", ids)}>
              <Square /> Stop all
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onBulk("restart", ids)}>
              <RotateCw /> Restart all
            </Button>
          </div>
        )}
      </div>
      <Table className="min-w-[40rem] table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[32%]">Name</TableHead>
            <TableHead className="w-[14%]">Status</TableHead>
            <TableHead className="w-[26%]">Resources</TableHead>
            <TableHead className="w-[28%]">Avg usage</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {group.vms.map((vm) => (
            <TableRow key={vm.id}>
              <TableCell className="overflow-hidden">
                <Link href={`/vms/${vm.id}`} className="inline-block max-w-full truncate align-middle font-medium hover:underline" title={vm.name}>
                  {vm.name}
                </Link>
                {vm.access !== "owner" && vm.access !== "admin" && (
                  <span className="ml-2 rounded border px-1.5 py-0.5 align-middle text-[10px] text-muted-foreground">
                    Shared · {vm.access}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <VmStatusBadge status={vm.status} />
              </TableCell>
              <TableCell className="truncate text-muted-foreground">
                {vm.cpu} vCPU · {formatRam(vm.ram)} · {vm.storage} GB
              </TableCell>
              <TableCell className="truncate text-muted-foreground tabular-nums">
                {vm.usage && vm.usage.samples > 0
                  ? `${(vm.usage.avgCpu * 100).toFixed(1)}% CPU · ${formatBytes(vm.usage.avgMem)}`
                  : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

/**
 * The Projects view: each owner's VMs grouped by project (named projects first,
 * then "No project"), and the VMs shared with the caller as a separate group with
 * no bulk actions — power actions there stay on each VM's own page.
 */
export function ProjectsBoard({
  view,
  isAdmin,
  busyKey,
  onBulk,
}: {
  view: ProjectsView;
  isAdmin: boolean;
  /** The group whose bulk action is in flight (`ownerId:project`), if any. */
  busyKey: string | null;
  onBulk: (key: string, action: BulkPower, ids: string[]) => void;
}) {
  return (
    <div className="grid gap-4">
      {view.owners.map(({ owner, projects }) => (
        <Card key={owner.id}>
          <CardContent className="grid gap-5">
            {isAdmin && (
              <div className="flex items-center gap-2 border-b pb-1.5">
                {owner.role === "admin" ? <Crown className="size-4 text-amber-500" /> : <User className="size-4 text-muted-foreground" />}
                <h2 className="text-sm font-semibold">{owner.displayName}</h2>
                <span className="text-xs text-muted-foreground">· {owner.email}</span>
              </div>
            )}
            {projects.map((g) => {
              const key = `${owner.id}:${g.name ?? ""}`;
              return (
                <ProjectSection
                  key={key}
                  title={
                    g.name ? (
                      <>
                        <FolderKanban className="size-4 text-muted-foreground" /> {g.name}
                      </>
                    ) : (
                      "No project"
                    )
                  }
                  group={g}
                  busy={busyKey === key}
                  onBulk={(action, ids) => onBulk(key, action, ids)}
                />
              );
            })}
          </CardContent>
        </Card>
      ))}

      {view.shared && (
        <Card>
          <CardContent>
            <ProjectSection
              title={
                <>
                  <Users className="size-4 text-muted-foreground" /> Shared with me
                </>
              }
              group={view.shared}
              busy={false}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
