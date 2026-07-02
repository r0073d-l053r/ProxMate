"use client";

import { useCallback, useEffect, useState } from "react";
import { History, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { VmActivityEntry } from "@/lib/types";
import { formatDate, formatRelative } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Map a raw audit action to a friendly label + a dot color for the timeline. */
const ACTIVITY_META: Record<string, { label: string; dot: string }> = {
  "vm.create": { label: "Created", dot: "bg-emerald-500" },
  "vm.start": { label: "Started", dot: "bg-emerald-500" },
  "vm.stop": { label: "Stopped", dot: "bg-amber-500" },
  "vm.stop_force": { label: "Force-stopped", dot: "bg-red-500" },
  "vm.restart": { label: "Restarted", dot: "bg-sky-500" },
  "vm.pause": { label: "Paused", dot: "bg-amber-500" },
  "vm.resume": { label: "Resumed", dot: "bg-emerald-500" },
  "vm.update": { label: "Notes updated", dot: "bg-muted-foreground" },
  "vm.resize": { label: "Resized", dot: "bg-sky-500" },
  "vm.rebuild": { label: "Rebuilt", dot: "bg-amber-500" },
  "vm.delete": { label: "Deleted", dot: "bg-red-500" },
  "snapshot.create": { label: "Snapshot taken", dot: "bg-sky-500" },
  "snapshot.rollback": { label: "Rolled back to snapshot", dot: "bg-amber-500" },
  "snapshot.delete": { label: "Snapshot deleted", dot: "bg-muted-foreground" },
  "vm.schedule": { label: "Schedule updated", dot: "bg-muted-foreground" },
  "vm.backup_policy": { label: "Backup policy updated", dot: "bg-muted-foreground" },
};

/**
 * A compact, owner-visible timeline of this VM's recent lifecycle events, read
 * from the audit log (`GET /vms/:id/activity`). Refreshes on demand; the actor
 * email is shown so you can tell whether you or an admin acted.
 */
export function ActivityCard({ vmId, className }: { vmId: string; className?: string }) {
  const [items, setItems] = useState<VmActivityEntry[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<VmActivityEntry[]>(`/vms/${vmId}/activity`);
      setItems(res.data);
    } catch {
      setItems([]);
    }
  }, [vmId]);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <Card className={cn(className)}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          <History className="size-4 text-muted-foreground" />
          Activity
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing} title="Refresh">
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
        </Button>
      </CardHeader>
      <CardContent>
        {items === null ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <ul className="space-y-3">
            {items.map((e) => {
              const meta = ACTIVITY_META[e.action] ?? { label: e.action, dot: "bg-muted-foreground" };
              return (
                <li key={e.id} className="flex items-start gap-3 text-sm">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${meta.dot}`} />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{meta.label}</span>
                    {e.actorEmail && (
                      <span className="text-muted-foreground"> · {e.actorEmail}</span>
                    )}
                  </div>
                  <span
                    className="shrink-0 text-xs text-muted-foreground tabular-nums"
                    title={formatDate(e.createdAt)}
                  >
                    {formatRelative(e.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
