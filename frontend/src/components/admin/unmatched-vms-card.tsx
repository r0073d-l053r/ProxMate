"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ShieldQuestion } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export interface UnmatchedVm {
  id: string;
  name: string;
  status: string;
  proxmoxVmId: number;
  proxmoxNode: string;
  guest: { present: boolean; name: string | null; taggedForAnotherRow: boolean };
  sharedVmid: boolean;
}

/** What's at the row's VMID, in words, for the admin deciding what to do. */
function describeGuest(vm: UnmatchedVm): string {
  if (!vm.guest.present) return "no guest at this VMID";
  const name = vm.guest.name ? `"${vm.guest.name}"` : "unnamed guest";
  if (vm.guest.taggedForAnotherRow) return `${name}, tagged for another machine`;
  return `${name}, no ProxMate tag`;
}

/**
 * Machines whose VMID holds no guest carrying their ProxMate ownership tag —
 * typically created before tags existed and not matched automatically. Every
 * action on them is refused until an admin either adopts the guest (tags it as
 * this machine's) or removes just the machine's record, leaving the guest alone.
 */
export function UnmatchedVmsCard() {
  const [vms, setVms] = useState<UnmatchedVm[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<UnmatchedVm[]>("/admin/vms/unmatched")
      .then((r) => setVms(r.data))
      .catch((err) => toast.error(apiError(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function adopt(vm: UnmatchedVm) {
    setBusy(vm.id);
    try {
      await api.post(`/admin/vms/${vm.id}/adopt`);
      toast.success(`"${vm.name}" now owns the guest at VMID ${vm.proxmoxVmId}.`);
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function removeRow(vm: UnmatchedVm) {
    if (
      !window.confirm(
        `Remove ProxMate's record of "${vm.name}"? The guest at VMID ${vm.proxmoxVmId} is left untouched on Proxmox.`,
      )
    ) {
      return;
    }
    setBusy(vm.id);
    try {
      await api.delete(`/vms/${vm.id}?rowOnly=true`);
      toast.success(`Removed the record of "${vm.name}".`);
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldQuestion className="size-4 text-muted-foreground" />
          Unconfirmed machines
        </CardTitle>
        <CardDescription>
          Machines whose Proxmox guest doesn&apos;t carry their ProxMate ownership tag. Actions on them are
          refused until you adopt the guest (only if it really is that machine) or remove the record.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {vms === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : vms.length === 0 ? (
          <p className="text-sm text-muted-foreground">Every machine&apos;s guest is confirmed.</p>
        ) : (
          <ul className="divide-y">
            {vms.map((vm) => (
              <li key={vm.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0 text-sm">
                  <div className="font-medium">{vm.name}</div>
                  <div className="text-xs text-muted-foreground">
                    VMID {vm.proxmoxVmId} on {vm.proxmoxNode} · {describeGuest(vm)}
                    {vm.sharedVmid ? " · another machine references this VMID" : ""}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null || !vm.guest.present || vm.guest.taggedForAnotherRow || vm.sharedVmid}
                    onClick={() => adopt(vm)}
                  >
                    Adopt
                  </Button>
                  <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => removeRow(vm)}>
                    Remove row
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
