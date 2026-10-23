"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { IdeInstallLog } from "@/lib/types";
import { cleanLogText } from "@/lib/guest-files";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * The tail of the ProxMate IDE install log, read from the guest through the
 * agent. Shown as plain text in a <pre> (never as HTML), with refresh and
 * download. The VM's owner or an admin only; the server enforces that too.
 */
export function IdeLogDialog({
  vmId,
  vmName,
  open,
  onOpenChange,
}: {
  vmId: string;
  vmName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = useState<IdeInstallLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchLog = useCallback(() => {
    api
      .get<IdeInstallLog>(`/ide/${vmId}/install-log`)
      .then((r) => {
        setData({ ...r.data, log: cleanLogText(r.data.log ?? "") });
        setError(null);
      })
      .catch((err) => setError(apiError(err)))
      .finally(() => setLoading(false));
  }, [vmId]);

  useEffect(() => {
    if (open) fetchLog();
  }, [open, fetchLog]);

  function load() {
    setLoading(true);
    fetchLog();
  }

  function download() {
    if (!data) return;
    const blob = new Blob([data.log], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${vmName.replace(/[^A-Za-z0-9._-]/g, "_") || "vm"}-ide-install.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-3xl">
        <AlertDialogHeader>
          <AlertDialogTitle>IDE install log — {vmName}</AlertDialogTitle>
          <AlertDialogDescription>
            The end of <code>{data?.path ?? "/var/log/pmide-provision.log"}</code> inside the machine, read
            through the QEMU guest agent.
            {data?.truncated && " Older lines are left out."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : data?.missing ? (
          <p className="text-sm text-muted-foreground">
            There is no install log in this machine yet — no install has started, or the file was removed.
          </p>
        ) : (
          <pre
            data-testid="ide-log"
            className="max-h-[60vh] overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all"
          >
            {data ? data.log || "(empty)" : "Loading…"}
          </pre>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
          <Button variant="outline" onClick={download} disabled={!data || data.missing || loading}>
            <Download />
            Download
          </Button>
          <Button variant="outline" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
