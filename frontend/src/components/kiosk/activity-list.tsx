"use client";

import { useMemo, useState } from "react";
import { Activity, Globe, MonitorPlay, X } from "lucide-react";
import type { AuditEntry } from "@/lib/types";
import { formatDate, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Severity heuristic for the activity dot (shared look with the Overview ticker). */
function severityDot(action: string): string {
  const a = action.toLowerCase();
  if (/(delete|destroy|force|fail|lock|error)/.test(a)) return "bg-destructive";
  if (/(stop|restart|reset|update|rollback)/.test(a)) return "bg-amber-500";
  return "bg-emerald-500";
}

function humanizeAction(action: string): string {
  return action.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Best-effort VM name for a `vm`-targeted entry. Audit rows store the VM's DB id
 * in `targetId`; the human name conventionally leads `detail` (VM names are
 * restricted to [A-Za-z0-9-], so the leading token is the name). Cosmetic only —
 * filtering itself keys on the stable `targetId`.
 */
function vmLabel(e: AuditEntry): string | null {
  if (e.targetType !== "vm" || !e.targetId) return null;
  const m = e.detail?.match(/^[A-Za-z0-9-]+/);
  return m ? m[0] : "VM";
}

/** Active tap-filter: every event from one client IP, or for one VM. */
type Filter = { kind: "ip" | "vm"; value: string; label: string } | null;

/**
 * Full-height audit feed for the kiosk's Activity tab. Touch-first: no text
 * inputs — tap a row's IP or VM chip to filter by it, tap the chip up top to
 * clear. The list itself is fed by the page's existing 15s audit poll.
 */
export function KioskActivityList({ audit, total }: { audit: AuditEntry[]; total: number }) {
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
            const vm = vmLabel(e);
            return (
              <div key={e.id} className="flex items-center gap-3 rounded-xl bg-background/40 px-3 py-2 text-sm">
                <span className={cn("size-2.5 shrink-0 rounded-full", severityDot(e.action))} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-medium">{humanizeAction(e.action)}</span>
                    {e.actorEmail && (
                      <span className="truncate text-xs text-muted-foreground">{e.actorEmail}</span>
                    )}
                  </div>
                  {e.detail && <div className="truncate text-xs text-muted-foreground">{e.detail}</div>}
                </div>
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
                <span
                  className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                  title={formatDate(e.createdAt)}
                >
                  {formatRelative(e.createdAt)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
