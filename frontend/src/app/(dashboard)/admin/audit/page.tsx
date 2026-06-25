"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { AuditEntry, AuditListResponse } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE = 100;

/** Color-code the action so destructive/failed events stand out at a glance. */
function actionVariant(action: string): "default" | "secondary" | "destructive" | "outline" {
  if (/(_failed|\.delete|stop_force)/.test(action)) return "destructive";
  if (/\.(create|register|restore)$/.test(action)) return "default";
  return "secondary";
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (offset: number) => {
    try {
      const res = await api.get<AuditListResponse>("/admin/audit", {
        params: { limit: PAGE, offset },
      });
      setTotal(res.data.total);
      setEntries((prev) => (offset === 0 || !prev ? res.data.items : [...prev, ...res.data.items]));
    } catch (err) {
      toast.error(apiError(err));
    }
  }, []);

  useEffect(() => {
    load(0);
  }, [load]);

  async function loadMore() {
    if (!entries) return;
    setLoadingMore(true);
    await load(entries.length);
    setLoadingMore(false);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Audit Log"
        description="Who did what, and when — VM lifecycle, backups, and sign-ins across all tenants."
      >
        <Button variant="outline" size="sm" onClick={() => load(0)}>
          <RefreshCw />
          Refresh
        </Button>
      </PageHeader>

      <Card>
        <CardContent>
          {entries === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead>IP</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDate(e.createdAt)}
                      </TableCell>
                      <TableCell>{e.actorEmail ?? <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell>
                        <Badge variant={actionVariant(e.action)} className="font-mono text-xs">
                          {e.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {e.detail ?? (e.targetType ? `${e.targetType} ${e.targetId ?? ""}`.trim() : "—")}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {e.ip ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex items-center justify-between pt-4 text-sm text-muted-foreground">
                <span>
                  Showing {entries.length} of {total}
                </span>
                {entries.length < total && (
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
