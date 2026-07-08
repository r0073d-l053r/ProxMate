"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, MoveRight } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
 * Admin-only: migrate a VM to another cluster node (live if running).
 * Controlled: the detail page's Actions menu opens it via `open`/`onOpenChange`.
 */
export function MigrateDialog({
  vmId,
  currentNode,
  running,
  open,
  onOpenChange,
  onDone,
}: {
  vmId: string;
  currentNode: string;
  running: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [nodes, setNodes] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTarget("");
    setLoadingNodes(true);
    // Only the nodes THIS VM can actually migrate to (Proxmox `allowed_nodes`), so
    // the picker never offers an impossible target (e.g. node-local storage).
    api
      .get<{ current: string; targets: string[] }>(`/vms/${vmId}/migrate-targets`)
      .then((r) => setNodes(r.data.targets))
      .catch((e) => toast.error(apiError(e)))
      .finally(() => setLoadingNodes(false));
  }, [open, vmId]);

  async function migrate() {
    setBusy(true);
    try {
      await api.post(`/vms/${vmId}/migrate`, { targetNode: target });
      toast.success(`Migrating to ${target}…`);
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Migrate to another node</AlertDialogTitle>
          <AlertDialogDescription>
            Currently on <span className="font-medium text-foreground">{currentNode}</span>.{" "}
            {running
              ? "It's running, so this is a live migration (no downtime with shared storage)."
              : "It's stopped, so this is an offline migration."}{" "}
            Cross-architecture moves are blocked.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormField label="Target node">
          <Select value={target} onValueChange={(v) => setTarget(v as string)} disabled={loadingNodes || nodes.length === 0}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={loadingNodes ? "Checking eligible nodes…" : nodes.length ? "Select a node" : "No eligible nodes"} />
            </SelectTrigger>
            <SelectContent>
              {nodes.map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!loadingNodes && nodes.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              This VM can&apos;t be migrated — its disks live on storage that only exists on{" "}
              <span className="font-medium text-foreground">{currentNode}</span> (or it has a device
              attached that pins it to this host). Move its disks to shared storage to enable migration.
            </p>
          )}
        </FormField>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button onClick={migrate} disabled={busy || !target}>
            {busy ? <Loader2 className="animate-spin" /> : <MoveRight />}
            Migrate
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
