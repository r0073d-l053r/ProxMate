"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { DeployBatch } from "@/lib/bulk-deploy";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const POLL_MS = 3000;

/**
 * Per-copy progress of a bulk template deploy, polled until every copy has
 * settled. Each copy deploys on its own, so one failing doesn't stop the rest.
 */
export function BulkDeployProgress({ batchId, initial }: { batchId: string; initial?: DeployBatch }) {
  const [batch, setBatch] = useState<DeployBatch | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await api.get<DeployBatch>(`/templates/deploy-bulk/${batchId}`);
        if (stopped) return;
        setBatch(r.data);
        setError(null);
        if (!r.data.finishedAt) timer = setTimeout(poll, POLL_MS);
      } catch (err) {
        if (stopped) return;
        // The server keeps a batch's progress only for a while (and not across a
        // restart); its machines are unaffected, so stop asking.
        if ((err as { response?: { status?: number } })?.response?.status === 404) {
          setError("This batch's progress is no longer available — its machines are listed under Machines.");
          setGone(true);
          return;
        }
        setError(apiError(err));
        timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [batchId]);

  const items = batch?.items ?? [];
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "failed").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{batch ? `Deploying ${items.length} × ${batch.templateName}` : "Deploying…"}</CardTitle>
        <CardDescription>
          {batch?.finishedAt
            ? `Finished: ${done} deployed${failed ? `, ${failed} failed` : ""}.`
            : `${done} of ${items.length} deployed${failed ? `, ${failed} failed` : ""} — a few at a time.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
        <ul className="divide-y">
          {items.map((i) => (
            <li key={i.index} className="flex items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 font-medium">
                  {i.status === "done" ? (
                    <CheckCircle2 className="size-3.5 text-primary" />
                  ) : i.status === "failed" ? (
                    <XCircle className="size-3.5 text-destructive" />
                  ) : i.status === "deploying" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Clock className="size-3.5 text-muted-foreground" />
                  )}
                  {i.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  VMID {i.proxmoxVmId} on {i.node} · {i.status}
                  {i.error ? ` — ${i.error}` : ""}
                </div>
              </div>
              {i.status === "done" && (
                <Button size="sm" variant="outline" render={<Link href={`/vms/${i.vmId}`} />}>
                  Open
                </Button>
              )}
            </li>
          ))}
        </ul>
        {(batch?.finishedAt || gone) && (
          <Button className="mt-4" variant="outline" render={<Link href="/vms" />}>
            Go to machines
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
