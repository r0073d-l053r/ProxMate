"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Import, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { ManagedUser } from "@/lib/types";
import { formatRam } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ImportableGuest {
  vmid: number;
  node: string;
  name: string | null;
  type: "qemu" | "lxc";
  status: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  /** The Proxmox pool it is in, or null. */
  pool?: string | null;
}

/** The API's refusal when importing would move the guest out of another Proxmox pool. */
function isPoolMoveRefusal(err: unknown): boolean {
  const data = (err as { response?: { data?: { code?: string } } })?.response?.data;
  return data?.code === "pool_move";
}

/** One guest's resources, in words, for the list and the dialog. */
export function guestSummary(g: ImportableGuest): string {
  return `${g.type === "lxc" ? "Container" : "VM"} · ${g.cpu} vCPU · ${formatRam(g.ramMb)} · ${g.diskGb} GB · ${g.status}`;
}

/**
 * Proxmox guests ProxMate doesn't manage yet (no machine references them, no
 * ProxMate tag, not a template). An admin picks an owner and imports one: it gets
 * its ownership tag, the default bridge and isolation firewall, and counts toward
 * the owner's quota unless imported as a grant.
 */
export function ImportGuestsCard() {
  const [guests, setGuests] = useState<ImportableGuest[] | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [picked, setPicked] = useState<ImportableGuest | null>(null);
  const [ownerId, setOwnerId] = useState("");
  const [countQuota, setCountQuota] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<ImportableGuest[]>("/admin/guests/importable")
      .then((r) => setGuests(r.data))
      .catch((err) => toast.error(apiError(err)));
  }, []);

  useEffect(() => {
    load();
    api
      .get<ManagedUser[]>("/users")
      .then((r) => setUsers(r.data))
      .catch(() => setUsers([]));
  }, [load]);

  function open(g: ImportableGuest) {
    setPicked(g);
    setOwnerId("");
    setCountQuota(true);
    setError(null);
  }

  async function submit() {
    if (!picked) return;
    if (!ownerId) {
      setError("Choose who will own this machine.");
      return;
    }
    setBusy(true);
    const body = { vmid: picked.vmid, ownerId, ...(countQuota ? {} : { quotaExempt: true }) };
    try {
      let res;
      try {
        res = await api.post<{ poolNote?: string | null }>("/admin/guests/import", body);
      } catch (err) {
        // The guest is in another Proxmox pool: importing moves it into ProxMate's.
        if (!isPoolMoveRefusal(err) || !window.confirm(`${apiError(err)}\n\nMove it and import?`)) throw err;
        res = await api.post<{ poolNote?: string | null }>("/admin/guests/import", { ...body, movePool: true });
      }
      toast.success(`Imported "${picked.name ?? picked.vmid}" (VMID ${picked.vmid}).`);
      if (res.data?.poolNote) toast.info(res.data.poolNote, { duration: 12000 });
      setPicked(null);
      load();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Import className="size-4 text-muted-foreground" />
          Import existing guests
        </CardTitle>
        <CardDescription>
          Proxmox guests ProxMate doesn&apos;t manage yet. Importing one hands it to a user: it is tagged as
          theirs, moved to the default bridge with the isolation firewall, and counted toward their quota.
          With a Proxmox pool configured it is also added to that pool. A token scoped to the pool only sees
          guests already in it, so this list then shows only those.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {guests === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : guests.length === 0 ? (
          <p className="text-sm text-muted-foreground">Every guest on the cluster is already managed.</p>
        ) : (
          <ul className="divide-y">
            {guests.map((g) => (
              <li key={g.vmid} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0 text-sm">
                  <div className="font-medium">{g.name ?? "(unnamed)"}</div>
                  <div className="text-xs text-muted-foreground">
                    VMID {g.vmid} on {g.node} · {guestSummary(g)}
                  </div>
                </div>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => open(g)}>
                  Import
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AlertDialog open={picked !== null} onOpenChange={(o) => !o && setPicked(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import {picked?.name ?? `VMID ${picked?.vmid}`}</AlertDialogTitle>
            <AlertDialogDescription>
              VMID {picked?.vmid} on {picked?.node} · {picked ? guestSummary(picked) : ""}. Its network
              interfaces move to the default bridge and get the isolation firewall, as a new machine&apos;s do.
              Guests with disks of another guest, host devices or a privileged container are refused.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FormField label="Owner">
            <Select value={ownerId} onValueChange={(v) => { setOwnerId(v as string); setError(null); }}>
              <SelectTrigger className="w-full" aria-label="Owner">
                <SelectValue placeholder="Choose a user" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.displayName} <span className="text-muted-foreground">· {u.email}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3">
            <input
              type="checkbox"
              checked={countQuota}
              onChange={(e) => setCountQuota(e.target.checked)}
              className="mt-0.5 size-4 accent-primary"
            />
            <span className="text-sm">
              <span className="font-medium">Count against their quota</span>
              <span className="block text-xs text-muted-foreground">
                Unchecked = a grant on top of their quota (they can use it but not resize it).
              </span>
            </span>
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={submit} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Import />}
              Import
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
