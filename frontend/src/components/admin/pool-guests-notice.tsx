"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FolderInput, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { PoolReport } from "@/lib/types";
import { Button } from "@/components/ui/button";

/** The admin action's answer: the guests it put into the pool. */
interface MoveResult {
  pool: string;
  moved: Array<{ vmid: number; name: string }>;
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
    setMoving(true);
    try {
      const res = await api.post<MoveResult>("/admin/settings/proxmox/pool/move-guests");
      const n = res.data.moved.length;
      toast.success(n === 0 ? "Nothing needed moving." : `Moved ${n} guest${n === 1 ? "" : "s"} into ${res.data.pool}.`);
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
