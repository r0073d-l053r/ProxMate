"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Save, Loader2, Trash2, RotateCcw, Calendar, Wrench, Archive, Download } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { MateState } from "@/lib/types";
import { formatBytes, formatDate } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const RETENTION = 2;

export function MateStatesPanel({ vmId, vmName }: { vmId: string; vmName: string }) {
  const [items, setItems] = useState<MateState[] | null>(null);
  const [downloadable, setDownloadable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<{ downloadable: boolean; items: MateState[] }>(`/vms/${vmId}/matestates`)
      .then((res) => {
        setItems(res.data.items);
        setDownloadable(res.data.downloadable);
      })
      .catch((err) => toast.error(apiError(err)));
  }, [vmId]);

  useEffect(load, [load]);

  async function requestDownload(ms: MateState) {
    setBusy(`dl-${ms.id}`);
    try {
      const res = await api.post<{ to: string }>(`/vms/${vmId}/matestates/${ms.id}/download`);
      toast.success(`Download link sent to ${res.data.to}. It works once and expires in an hour.`);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function backup() {
    setBusy("create");
    try {
      await api.post(`/vms/${vmId}/matestates`);
      toast.success("MateState created.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function restore(ms: MateState) {
    setBusy(ms.id);
    try {
      await api.post(`/vms/${vmId}/matestates/${ms.id}/restore`);
      toast.success(`Restored ${vmName} from ${formatDate(ms.createdAt)}.`);
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(ms: MateState) {
    setBusy(`del-${ms.id}`);
    try {
      await api.delete(`/vms/${vmId}/matestates/${ms.id}`);
      toast.success("MateState deleted.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(null);
    }
  }

  const creating = busy === "create";
  const atCap = items !== null && items.length >= RETENTION;

  return (
    <Card className="mt-4">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Archive className="size-4 text-muted-foreground" />
              MateStates · backups
            </CardTitle>
            <CardDescription className="mt-1">
              Weekly automatic backups, plus on-demand. We keep the {RETENTION} most recent —
              taking a new one will replace the oldest.
            </CardDescription>
          </div>
          <Button size="sm" disabled={creating} onClick={backup}>
            {creating ? <Loader2 className="animate-spin" /> : <Save />}
            New MateState
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {items === null ? (
          <p className="py-2 text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No MateStates yet. The first scheduled backup will appear here automatically.
          </p>
        ) : (
          <ul className="divide-y">
            {items.map((ms) => (
              <li key={ms.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-md",
                      ms.status === "ready" && "bg-emerald-500/10 text-emerald-500",
                      ms.status === "creating" && "bg-amber-500/10 text-amber-500",
                      ms.status === "restoring" && "bg-blue-500/10 text-blue-500",
                      ms.status === "error" && "bg-destructive/10 text-destructive",
                    )}
                  >
                    {ms.kind === "scheduled" ? <Calendar className="size-4" /> : <Wrench className="size-4" />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {formatDate(ms.createdAt)}
                      {ms.status !== "ready" && (
                        <Badge variant="outline" className="capitalize">
                          {ms.status}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {ms.kind === "scheduled" ? "Weekly" : "Manual"} · {formatBytes(ms.size)}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  {downloadable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null || ms.status !== "ready"}
                      onClick={() => requestDownload(ms)}
                      title="Email me a one-time download link for this backup"
                    >
                      {busy === `dl-${ms.id}` ? <Loader2 className="animate-spin" /> : <Download />}
                      Download
                    </Button>
                  )}
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null || ms.status !== "ready"}
                        >
                          {busy === ms.id ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                          Restore
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Restore {vmName}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This stops the VM, overwrites its disk with the backup from{" "}
                          <span className="font-medium">{formatDate(ms.createdAt)}</span>, then starts
                          it back up. Anything written since this backup will be lost.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => restore(ms)}>Restore</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null || ms.status === "restoring"}
                        >
                          {busy === `del-${ms.id}` ? <Loader2 className="animate-spin" /> : <Trash2 />}
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this MateState?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This permanently removes the backup file from Proxmox.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => remove(ms)}>
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </li>
            ))}
          </ul>
        )}
        {atCap && (
          <p className="mt-2 text-xs text-muted-foreground">
            At retention limit. Creating a new MateState will replace the oldest one.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
