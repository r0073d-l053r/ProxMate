"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowUpCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Download,
  ExternalLink,
  Copy,
  Info,
} from "lucide-react";
import { api, apiError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { UpdateCheck, UpdateStatus } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function UpdatesCard() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const mounted = useRef(true);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await api.get<UpdateStatus>("/admin/updates/status");
      if (mounted.current) setStatus(res.data);
    } catch {
      // Backend may be briefly down mid-rebuild — keep the last known status.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refreshStatus();
    return () => {
      mounted.current = false;
    };
  }, [refreshStatus]);

  // While an update is queued/running, poll the host updater's status file.
  const busyState = status?.state === "queued" || status?.state === "running";
  useEffect(() => {
    if (!busyState) return;
    const iv = setInterval(refreshStatus, 4000);
    return () => clearInterval(iv);
  }, [busyState, refreshStatus]);

  async function runCheck() {
    setChecking(true);
    try {
      const res = await api.get<UpdateCheck>("/admin/updates/check", { params: { force: true } });
      setCheck(res.data);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setChecking(false);
    }
  }

  async function apply() {
    const tag = check?.tag;
    if (!tag) return;
    // Close the confirm dialog right away so it doesn't sit on top of the
    // progress card (the Base UI action button doesn't auto-close like Radix).
    setConfirmOpen(false);
    setApplying(true);
    // Show progress immediately — the host updater takes a moment to write its
    // first real status, and we don't want a dead gap where nothing is happening.
    setStatus((s) => ({
      enabled: s?.enabled ?? true,
      current: check?.current ?? s?.current ?? "…",
      state: "queued",
      tag,
      message: "Queued — the host updater will pick this up shortly.",
    }));
    try {
      await api.post("/admin/updates/apply", { tag });
      toast.success("Update queued — ProxMate will rebuild and restart.");
      await refreshStatus();
    } catch (err) {
      toast.error(apiError(err));
      await refreshStatus(); // re-sync to the real state if queuing failed
    } finally {
      setApplying(false);
    }
  }

  const current = status?.current ?? check?.current ?? "…";
  const enabled = status?.enabled ?? false;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ArrowUpCircle className="size-5" /> Updates
            </CardTitle>
            <CardDescription>
              You&apos;re running <span className="font-mono">v{current}</span>. Check GitHub for a newer release.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={runCheck} disabled={checking}>
            {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Check for updates
          </Button>
        </div>
      </CardHeader>

      <CardContent className="grid gap-4">
        {/* Active update progress */}
        {status && status.state !== "idle" && (
          <div className="rounded-md border p-3 text-sm">
            <div className="flex items-center gap-2 font-medium">
              {(status.state === "queued" || status.state === "running") && <Loader2 className="size-4 animate-spin" />}
              {status.state === "success" && <CheckCircle2 className="size-4 text-emerald-500" />}
              {status.state === "error" && <Info className="size-4 text-destructive" />}
              {status.state === "queued" && "Update queued…"}
              {status.state === "running" && `Updating to ${status.tag ?? ""}…`}
              {status.state === "success" && `Updated to ${status.tag ?? ""}.`}
              {status.state === "error" && "Update failed."}
            </div>
            {status.message && <p className="mt-1 text-xs text-muted-foreground">{status.message}</p>}
            {(status.state === "queued" || status.state === "running") && (
              <>
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 rounded-full bg-primary [animation:progress-indeterminate_1.4s_ease-in-out_infinite]" />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  ProxMate is rebuilding and restarting — this page may briefly disconnect.
                </p>
              </>
            )}
            {status.state === "success" && (
              <Button size="sm" className="mt-2" onClick={() => window.location.reload()}>
                Reload
              </Button>
            )}
          </div>
        )}

        {/* Check result */}
        {check && !check.updateAvailable && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-emerald-500" />
            {check.latest
              ? `You're on the latest version (v${check.latest}).`
              : `No published releases found for ${check.repo}.`}
          </div>
        )}

        {check?.updateAvailable && (
          <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-medium">
                <Badge>Update available</Badge>
                {check.name || `v${check.latest}`}
                {check.publishedAt && (
                  <span className="text-xs text-muted-foreground">· {fmtDate(check.publishedAt)}</span>
                )}
              </span>
              {check.url && (
                <a
                  href={check.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                >
                  View release <ExternalLink className="size-3" />
                </a>
              )}
            </div>

            {check.notes && (
              <pre className="mb-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-background/60 p-3 text-xs">
                {check.notes}
              </pre>
            )}

            {enabled ? (
              <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <AlertDialogTrigger
                  render={
                    <Button size="sm" disabled={applying || busyState}>
                      {applying ? <Loader2 className="animate-spin" /> : <Download />}
                      Install update
                    </Button>
                  }
                />
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Install {check.tag}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This pulls the new release, rebuilds the containers, applies any database migrations, and
                      restarts ProxMate. The app will be briefly unavailable while it restarts. Make sure you have a
                      recent backup of the ProxMate database.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={apply}>Install</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <div className="grid gap-2 text-sm">
                <p className="flex items-center gap-1.5 text-muted-foreground">
                  <Info className="size-4" /> One-click updates aren&apos;t set up on this server. Update from the host:
                </p>
                <div className="relative">
                  <pre className="overflow-auto rounded-md border bg-muted/60 p-3 pr-16 text-xs">
                    {`cd /opt/proxmate\n./deploy/update.sh ${check.tag}`}
                  </pre>
                  <Button
                    size="sm"
                    variant="outline"
                    className="absolute right-2 top-2"
                    onClick={async () =>
                      (await copyText(`cd /opt/proxmate && ./deploy/update.sh ${check.tag}`))
                        ? toast.success("Copied.")
                        : toast.error("Couldn't copy.")
                    }
                  >
                    <Copy />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  To enable the one-click button, follow “Updating ProxMate” in <code>DEPLOYMENT.md</code> (install the
                  updater unit and set <code>SELF_UPDATE_ENABLED=true</code>).
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
