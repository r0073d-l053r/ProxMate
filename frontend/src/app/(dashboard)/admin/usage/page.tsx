"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { BarChart3 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { ResourceHistory } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const RANGES = [
  { days: 1, label: "Last 24h" },
  { days: 7, label: "Last 7 days" },
  { days: 14, label: "Last 14 days" },
  { days: 30, label: "Last 30 days" },
];

export default function UsagePage() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<ResourceHistory | null>(null);

  const load = useCallback(() => {
    setData(null);
    api
      .get<ResourceHistory>(`/admin/resource-history?days=${days}`)
      .then((res) => setData(res.data))
      .catch((err) => toast.error(apiError(err)));
  }, [days]);

  useEffect(load, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Usage"
        description="Per-tenant resource consumption over time, sampled every 5 minutes — who used what."
      >
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r.days} value={String(r.days)}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PageHeader>

      <Card>
        <CardContent>
          {data === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : data.usage.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
              <BarChart3 className="size-6" />
              No samples in this window yet. Usage is recorded every 5 minutes for running VMs.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Samples</TableHead>
                  <TableHead className="text-right">Avg CPU</TableHead>
                  <TableHead className="text-right">Avg memory</TableHead>
                  <TableHead className="text-right">Peak memory</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.usage.map((u) => (
                  <TableRow key={u.userId}>
                    <TableCell>
                      <div className="font-medium">{u.displayName}</div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{u.samples}</TableCell>
                    <TableCell className="text-right tabular-nums">{u.avgCpuPct.toFixed(1)}%</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(u.avgMemBytes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(u.peakMemBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="mt-3 text-center text-xs text-muted-foreground">
        CPU is the average across each owner&apos;s running VMs, as a percent of their allocated cores.
      </p>
    </div>
  );
}
