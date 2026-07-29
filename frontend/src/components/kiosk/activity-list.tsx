"use client";

import { useMemo, useState } from "react";
import { Activity, Globe, MonitorPlay, X } from "lucide-react";
import type { AuditEntry } from "@/lib/types";
import { formatDate, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { severityDot, humanizeAction, vmLabel } from "./audit-format";

/** Active tap-filter: every event from one client IP, or for one VM. */
type Filter = { kind: "ip" | "vm"; value: string; label: string } | null;

/**
 * Full-height audit feed for the kiosk's Activity tab. Touch-first: no text
 * inputs — tap a row's IP or VM chip to filter by it, tap the chip up top to
 * clear. Deliberately shows no actor emails or free-text detail (which can
 * carry emails): a wall panel is glanceable by anyone walking past, so rows
 * are action + VM + IP + time only. The list is fed by the page's 15s poll.
 */
export function KioskActivityList({
  audit,
  total,
  vmNames,
}: {
  audit: AuditEntry[];
  total: number;
  /** VM id -> name, from the inventory the page already polls. */
  vmNames?: Map<string, string>;
}) {
  const [filter, setFilter] = useState<Filter>(null);

  const rows = useMemo(() => {
    if (!filter) return audit;
    if (filter.kind === "ip") return audit.filter((e) => e.ip === filter.value);
    return audit.filter((e) => e.targetType === "vm" && e.targetId === filter.value);
  }, [audit, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl bg-card/60 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Activity className="size-4" /> Activity
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {filter ? `${rows.length} matching` : `latest ${audit.length} of ${total}`}
        </span>
        {filter && (
          <button
            onClick={() => setFilter(null)}
            aria-label="Clear filter"
            className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
          >
            {filter.kind === "ip" ? <Globe className="size-3.5" /> : <MonitorPlay className="size-3.5" />}
            {filter.label}
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {audit.length === 0 ? "No activity recorded yet." : "Nothing matches this filter."}
          </div>
        ) : (
          rows.map((e) => {
            const vm = vmLabel(e, vmNames);
            return (
              <div key={e.id} className="flex items-center gap-3 rounded-xl bg-background/40 px-3 py-2 text-sm">
                <span className={cn("size-2.5 shrink-0 rounded-full", severityDot(e.action))} />
                <span className="min-w-0 flex-1 truncate font-medium">{humanizeAction(e.action)}</span>
                {vm && e.targetId && (
                  <button
                    onClick={() => setFilter({ kind: "vm", value: e.targetId!, label: vm })}
                    className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
                    aria-label={`Filter by VM ${vm}`}
                  >
                    <MonitorPlay className="size-3 text-muted-foreground" />
                    {vm}
                  </button>
                )}
                {e.ip && (
                  <button
                    onClick={() => setFilter({ kind: "ip", value: e.ip!, label: e.ip! })}
                    className="shrink-0 rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent"
                    aria-label={`Filter by IP ${e.ip}`}
                  >
                    {e.ip}
                  </button>
                )}
                <span className="shrink-0 text-right leading-tight">
                  <span className="block text-xs tabular-nums text-foreground/80">
                    {formatRelative(e.createdAt)}
                  </span>
                  <span className="block text-[10px] tabular-nums text-muted-foreground">
                    {formatDate(e.createdAt)}
                  </span>
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
