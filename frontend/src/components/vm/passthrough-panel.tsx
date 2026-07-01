"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Cpu, Loader2, Send, Unplug } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { MyPassthroughRequest, PassthroughDevice } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

/**
 * GPU / PCI passthrough for a QEMU VM. Shows attached devices (with an admin
 * Detach action), or — when nothing is attached — lets an owner/co-owner request
 * passthrough (an admin then attaches an available Proxmox resource mapping).
 * Only rendered for QEMU VMs by the detail page.
 */
export function PassthroughPanel({
  vmId,
  vmName,
  isAdmin,
  canWrite,
  onChanged,
}: {
  vmId: string;
  vmName: string;
  isAdmin: boolean;
  canWrite: boolean;
  onChanged?: () => void;
}) {
  const [devices, setDevices] = useState<PassthroughDevice[] | null>(null);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [detaching, setDetaching] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [dev, mine] = await Promise.all([
        api.get<{ devices: PassthroughDevice[] }>(`/vms/${vmId}/passthrough`),
        api.get<MyPassthroughRequest[]>("/passthrough-requests/mine").catch(() => ({ data: [] as MyPassthroughRequest[] })),
      ]);
      setDevices(dev.data.devices);
      setPending(mine.data.some((x) => x.vmId === vmId && x.status === "pending"));
    } catch {
      setDevices([]);
    }
  }, [vmId]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit() {
    setBusy(true);
    try {
      await api.post("/passthrough-requests", { vmId, reason: reason.trim() || undefined });
      toast.success("Passthrough request sent to your administrator.");
      setOpen(false);
      setReason("");
      setPending(true);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function detach(index: number) {
    setDetaching(index);
    try {
      await api.post(`/admin/vms/${vmId}/passthrough/detach`, { index });
      toast.success("Device detached. The VM was stopped to remove it.");
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setDetaching(null);
    }
  }

  const hasDevices = (devices?.length ?? 0) > 0;

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Cpu className="size-4 text-muted-foreground" />
          GPU / PCI passthrough
        </CardTitle>
      </CardHeader>
      <CardContent>
        {devices === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : hasDevices ? (
          <div className="grid gap-2">
            {devices!.map((d) => (
              <div
                key={d.slot}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-2.5"
              >
                <div className="min-w-0 text-sm">
                  <span className="font-medium">{d.mapping ?? d.raw}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{d.slot}</span>
                </div>
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={detaching !== null}
                    onClick={() => detach(d.index)}
                  >
                    {detaching === d.index ? <Loader2 className="animate-spin" /> : <Unplug />}
                    Detach
                  </Button>
                )}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              A VM with passthrough can&apos;t be migrated between nodes.{" "}
              {isAdmin ? "Detaching stops the VM to remove the device." : "Ask an admin to detach it."}
            </p>
          </div>
        ) : pending ? (
          <p className="text-sm text-muted-foreground">
            A GPU / PCI passthrough request for this VM is pending your administrator&apos;s review.
          </p>
        ) : canWrite ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Need a GPU or other PCI device on this VM? Request it — an admin attaches an available
              device. The VM is stopped to attach, and afterwards it can&apos;t be migrated between nodes.
            </p>
            <div>
              <AlertDialog open={open} onOpenChange={setOpen}>
                <AlertDialogTrigger
                  render={
                    <Button size="sm" variant="outline">
                      <Cpu /> Request GPU / PCI passthrough
                    </Button>
                  }
                />
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Request passthrough for {vmName}</AlertDialogTitle>
                    <AlertDialogDescription>
                      Tell your administrator what you need. They&apos;ll attach an available GPU / PCI
                      device (the VM will be stopped to attach it) or deny the request.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <FormField label="Reason (optional)" htmlFor="pt-reason">
                    <textarea
                      id="pt-reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={3}
                      maxLength={1000}
                      placeholder="e.g. CUDA / ML training, video transcoding, a specific device…"
                      className="w-full resize-y rounded-lg border border-input bg-transparent p-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                  </FormField>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                    <Button onClick={submit} disabled={busy}>
                      {busy ? <Loader2 className="animate-spin" /> : <Send />}
                      Send request
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No PCI device is attached to this VM.</p>
        )}
      </CardContent>
    </Card>
  );
}
