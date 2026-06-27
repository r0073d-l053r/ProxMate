"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Camera, Loader2, Trash2, RotateCcw, Plus, MemoryStick } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { Snapshot } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/form-field";
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

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function formatSnapTime(snaptime?: number): string {
  if (!snaptime) return "—";
  return new Date(snaptime * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Live Proxmox snapshots for a VM — instant, in-place "before I change something"
 * restore points. Separate from MateStates (durable off-host vzdump backups).
 */
export function SnapshotsPanel({ vmId, vmName }: { vmId: string; vmName: string }) {
  const [items, setItems] = useState<Snapshot[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [includeRam, setIncludeRam] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(() => {
    api
      .get<Snapshot[]>(`/vms/${vmId}/snapshots`)
      .then((res) => setItems(res.data))
      .catch((err) => toast.error(apiError(err)));
  }, [vmId]);

  useEffect(load, [load]);

  const nameValid = NAME_RE.test(name);

  async function create() {
    setBusy("create");
    try {
      await api.post(`/vms/${vmId}/snapshots`, {
        name: name.trim(),
        description: description.trim() || undefined,
        includeRam,
      });
      toast.success(`Snapshot "${name}" created.`);
      setName("");
      setDescription("");
      setIncludeRam(false);
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function rollback(snap: Snapshot) {
    setBusy(`roll-${snap.name}`);
    try {
      await api.post(`/vms/${vmId}/snapshots/${snap.name}/rollback`);
      toast.success(`Rolled ${vmName} back to "${snap.name}".`);
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(snap: Snapshot) {
    setBusy(`del-${snap.name}`);
    try {
      await api.delete(`/vms/${vmId}/snapshots/${snap.name}`);
      toast.success(`Snapshot "${snap.name}" deleted.`);
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(null);
    }
  }

  const creating = busy === "create";

  return (
    <Card className="mt-4">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Camera className="size-4 text-muted-foreground" />
              Snapshots
            </CardTitle>
            <CardDescription className="mt-1">
              Instant restore points for quick &ldquo;before I change something&rdquo; rollbacks.
              Stored on the VM&apos;s disk — for durable backups, use MateStates below.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowForm((s) => !s)} disabled={busy !== null}>
            <Plus />
            Take snapshot
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {showForm && (
          <div className="mb-4 grid gap-3 rounded-md border bg-muted/40 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="Name"
                htmlFor="snapname"
                error={name && !nameValid ? "Start with a letter; letters, numbers, _ and -." : undefined}
              >
                <Input
                  id="snapname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. before-kernel-upgrade"
                  maxLength={40}
                />
              </FormField>
              <FormField label="Description (optional)" htmlFor="snapdesc">
                <Input
                  id="snapdesc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What state is this?"
                  maxLength={200}
                />
              </FormField>
            </div>
            <label className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={includeRam}
                onChange={(e) => setIncludeRam(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="flex items-center gap-1.5 font-medium">
                  <MemoryStick className="size-3.5" /> Include memory state
                </span>
                <span className="text-xs text-muted-foreground">
                  Captures RAM too, so a rollback resumes exactly where it was — slower, and the VM
                  pauses briefly.
                </span>
              </span>
            </label>
            <div className="flex gap-2">
              <Button size="sm" onClick={create} disabled={creating || !nameValid}>
                {creating ? <Loader2 className="animate-spin" /> : <Camera />}
                Create snapshot
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)} disabled={creating}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {items === null ? (
          <p className="py-2 text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No snapshots yet. Take one before a risky change so you can roll back instantly.
          </p>
        ) : (
          <ul className="divide-y">
            {items.map((snap) => (
              <li key={snap.name} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Camera className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {snap.name}
                      {snap.vmstate ? <MemoryStick className="size-3.5 text-muted-foreground" /> : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {formatSnapTime(snap.snaptime)}
                      {snap.description ? ` · ${snap.description}` : ""}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button size="sm" variant="outline" disabled={busy !== null}>
                          {busy === `roll-${snap.name}` ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                          Roll back
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Roll {vmName} back to &ldquo;{snap.name}&rdquo;?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This reverts the VM to this snapshot. Anything written since it was taken
                          will be lost.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => rollback(snap)}>Roll back</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button size="sm" variant="ghost" disabled={busy !== null} aria-label={`Delete ${snap.name}`}>
                          {busy === `del-${snap.name}` ? <Loader2 className="animate-spin" /> : <Trash2 />}
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete snapshot &ldquo;{snap.name}&rdquo;?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This removes the restore point. The VM&apos;s current state is unaffected.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => remove(snap)}>
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
      </CardContent>
    </Card>
  );
}
