"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { HardDrive, Loader2, Plus, Trash2, MoveUp } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { VmDisk } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/** Grow a single data disk (grow-only). */
function GrowDiskDialog({ vmId, disk, onDone }: { vmId: string; disk: VmDisk; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState(disk.sizeGb + 10);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/vms/${vmId}/disks/${disk.slot}`, { sizeGb: size });
      toast.success(`${disk.slot} grown to ${size} GB.`);
      setOpen(false);
      onDone();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o: boolean) => {
        setOpen(o);
        if (o) setSize(disk.sizeGb + 10);
      }}
    >
      <AlertDialogTrigger
        render={
          <Button size="sm" variant="ghost" title="Grow disk">
            <MoveUp />
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Grow {disk.slot}</AlertDialogTitle>
          <AlertDialogDescription>
            Disks can only grow, never shrink. Currently {disk.sizeGb} GB. You may need to extend the
            filesystem inside the VM afterwards.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          type="number"
          min={disk.sizeGb + 1}
          value={size}
          onChange={(e) => setSize(Math.max(disk.sizeGb + 1, Math.floor(Number(e.target.value) || 0)))}
          aria-label="New disk size in GB"
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button onClick={save} disabled={busy || size <= disk.sizeGb}>
            {busy ? <Loader2 className="animate-spin" /> : <MoveUp />}
            Grow to {size} GB
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Extra-data-disk management for a VM (attach / grow / remove). */
export function DisksPanel({ vmId, onChanged }: { vmId: string; onChanged?: () => void }) {
  const [disks, setDisks] = useState<VmDisk[] | null>(null);
  const [newSize, setNewSize] = useState(20);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<VmDisk[]>(`/vms/${vmId}/disks`)
      .then((r) => setDisks(r.data))
      .catch((e) => toast.error(apiError(e)));
  }, [vmId]);

  useEffect(load, [load]);

  async function add() {
    setBusy(true);
    try {
      await api.post(`/vms/${vmId}/disks`, { sizeGb: newSize });
      toast.success(`Added a ${newSize} GB data disk.`);
      load();
      onChanged?.();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(slot: string) {
    try {
      await api.delete(`/vms/${vmId}/disks/${slot}`);
      toast.success(`Removed ${slot}.`);
      load();
      onChanged?.();
    } catch (err) {
      toast.error(apiError(err));
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <HardDrive className="size-4 text-muted-foreground" /> Disks
        </CardTitle>
        <CardDescription>
          The root disk is managed from the VM resize controls. Add extra data disks here — they count
          toward the owner&apos;s storage quota.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {disks === null ? (
          <p className="py-2 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="grid gap-1.5">
            {disks.map((d) => (
              <li key={d.slot} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <div className="text-sm">
                  <span className="font-medium">{d.slot}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {d.sizeGb} GB · {d.storage}
                  </span>
                  {d.isRoot && (
                    <Badge variant="outline" className="ml-2 font-normal">
                      root
                    </Badge>
                  )}
                </div>
                {!d.isRoot && (
                  <div className="flex items-center gap-1">
                    <GrowDiskDialog vmId={vmId} disk={d} onDone={() => { load(); onChanged?.(); }} />
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button size="sm" variant="ghost" title="Remove disk">
                            <Trash2 />
                          </Button>
                        }
                      />
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove {d.slot}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This detaches and permanently destroys the {d.sizeGb} GB volume and its data.
                            This cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <Button variant="destructive" onClick={() => remove(d.slot)}>
                            <Trash2 /> Remove disk
                          </Button>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-end gap-2">
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="disk-size">
              New data disk (GB)
            </label>
            <Input
              id="disk-size"
              type="number"
              min={1}
              value={newSize}
              onChange={(e) => setNewSize(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              className="w-32"
            />
          </div>
          <Button size="sm" onClick={add} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            Add disk
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
