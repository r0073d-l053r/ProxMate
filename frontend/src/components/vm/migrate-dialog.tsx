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
  const [blockers, setBlockers] = useState<Array<{ node: string; reason: string }>>([]);
  const [localDisks, setLocalDisks] = useState<Array<{ volid: string }>>([]);
  const [target, setTarget] = useState("");
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTarget("");
    setLoadingNodes(true);
    // Only the nodes THIS VM can actually migrate to (Proxmox `allowed_nodes`), so
    // the picker never offers an impossible target (e.g. node-local storage).
    // `blockers` carries Proxmox's per-node REASON, which is the difference between
    // "no eligible nodes" and "pve-1: storage not available there: tank".
    api
      .get<{
        current: string;
        targets: string[];
        blockers?: Array<{ node: string; reason: string }>;
        localDisks?: Array<{ volid: string }>;
      }>(`/vms/${vmId}/migrate-targets`)
      .then((r) => {
        setNodes(r.data.targets);
        setBlockers(r.data.blockers ?? []);
        setLocalDisks(r.data.localDisks ?? []);
      })
      .catch((e) => toast.error(apiError(e)))
      .finally(() => setLoadingNodes(false));
  }, [open, vmId]);

  // The storages that are actually pinning this guest, deduped for a short hint.
  const pinningStorages = [
    ...new Set(localDisks.map((d) => d.volid.split(":")[0]).filter(Boolean)),
  ] as string[];

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
            <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
              <p className="font-medium text-foreground">Why this VM can&apos;t be migrated</p>
              {blockers.length > 0 ? (
                <ul className="mt-1.5 grid gap-1 text-muted-foreground">
                  {blockers.map((b) => (
                    <li key={b.node}>
                      {b.node === "*" ? (
                        b.reason
                      ) : (
                        <>
                          <span className="font-medium text-foreground">{b.node}</span> — {b.reason}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted-foreground">
                  Proxmox reported no eligible target nodes.
                </p>
              )}
              {pinningStorages.length > 0 && (
                <p className="mt-2 text-muted-foreground">
                  Its disks are on{" "}
                  <span className="font-medium text-foreground">{pinningStorages.join(", ")}</span>.
                  Moving them to storage every node can see (Hardware → Disk → Move Storage) makes
                  this VM migratable.
                </p>
              )}
            </div>
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
