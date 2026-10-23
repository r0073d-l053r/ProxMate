"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FolderInput, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { PoolReport } from "@/lib/types";
import { Button } from "@/components/ui/button";

/** One guest the admin action handled. */
interface MoveOutcome {
  vmid: number;
  name: string;
  template: boolean;
  from: string | null;
}

/** The admin action's answer: what it moved, and what Proxmox refused (one request per guest). */
interface MoveResult {
  pool: string;
  moved: MoveOutcome[];
  failed: Array<MoveOutcome & { error: string }>;
}

/**
 * The confirmation shown before moving guests (machines or templates) that sit in
 * another Proxmox pool, or null when there are none. Moving one takes it out of
 * that pool, which may be how other users or tools reach it.
 */
export function poolMovePrompt(report: PoolReport): string | null {
  const elsewhere = report.outside.filter((g) => g.pool && g.pool !== report.name);
  if (elsewhere.length === 0) return null;
  return (
    `These guests are in another Proxmox pool and will be moved out of it into ${report.name}:\n\n` +
    elsewhere.map((g) => `${g.vmid} ${g.name}${g.template ? " (template)" : ""} (pool ${g.pool})`).join("\n") +
    "\n\nAnything that reaches them through their current pool will lose them. Move them?"
  );
}

/**
 * Shown after a connection test when a Proxmox pool is configured but guests
 * ProxMate manages are still outside it, so a token scoped to the pool cannot
 * reach them. The action moves only guests carrying a ProxMate ownership marker.
 */
export function PoolGuestsNotice({ report, onMoved }: { report: PoolReport; onMoved?: () => void }) {
  const [moving, setMoving] = useState(false);
  if (report.outside.length === 0) return null;

  async function move() {
    const prompt = poolMovePrompt(report);
    if (prompt && !window.confirm(prompt)) return;
    setMoving(true);
    try {
      const res = await api.post<MoveResult>("/admin/settings/proxmox/pool/move-guests");
      const { moved, failed, pool } = res.data;
      if (moved.length > 0) toast.success(`Moved ${moved.length} guest${moved.length === 1 ? "" : "s"} into ${pool}.`);
      else if (failed.length === 0) toast.success("Nothing needed moving.");
      for (const f of failed) toast.error(`${f.vmid} ${f.name} was not moved: ${f.error}`, { duration: 12000 });
      onMoved?.(); // the caller re-runs the connection test for a fresh report
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm" role="status">
      <p>
        {report.outside.length} guest{report.outside.length === 1 ? "" : "s"} ProxMate manages{" "}
        {report.outside.length === 1 ? "is" : "are"} not in the pool <span className="font-mono">{report.name}</span>.
        A token scoped to the pool cannot reach {report.outside.length === 1 ? "it" : "them"}.
      </p>
      <ul className="grid gap-1 text-xs text-muted-foreground">
        {report.outside.map((g) => (
          <li key={g.vmid}>
            <span className="font-mono">{g.vmid}</span> {g.name}
            {g.template ? " (template)" : ""} — {g.pool ? `in pool ${g.pool}` : "in no pool"}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Only guests carrying a ProxMate ownership tag are moved. Moving needs the token to still reach them, so do it
        before removing the token&apos;s grant on /.
      </p>
      <Button type="button" variant="outline" onClick={move} disabled={moving} className="justify-self-start">
        {moving ? <Loader2 className="animate-spin" /> : <FolderInput />}
        Move managed guests into the pool
      </Button>
    </div>
  );
}
