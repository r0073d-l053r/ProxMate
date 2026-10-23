"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Scaling, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { VmDetail, MeResponse, Quota } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
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
} from "@/components/ui/alert-dialog";

/** Smallest guest memory the backend accepts (MB). */
const MIN_RAM_MB = 64;

/** MB shown as GB, rounded to two decimals for display only. */
const gbLabel = (mb: number) => String(Math.round((mb / 1024) * 100) / 100);

/** One-click "T-shirt" sizes for the resize dialog (mirror the create wizard). */
const SIZE_PRESETS = [
  { key: "s", label: "Small", cpu: 1, ramGb: 2, diskGb: 20 },
  { key: "m", label: "Medium", cpu: 2, ramGb: 4, diskGb: 40 },
  { key: "l", label: "Large", cpu: 4, ramGb: 8, diskGb: 80 },
  { key: "xl", label: "X-Large", cpu: 8, ramGb: 16, diskGb: 160 },
] as const;

/**
 * In-place resize of a VM's vCPU / memory / disk. Disk is grow-only (Proxmox can't
 * shrink). Quota is checked here for a friendly error and re-checked server-side.
 * CPU/RAM changes the guest can't hot-plug take effect on the next reboot; after a
 * disk grow the filesystem still has to be extended inside the guest.
 *
 * Controlled: the detail page's Actions menu opens it via `open`/`onOpenChange`.
 */
export function ResizeDialog({
  vm,
  isAdmin,
  open,
  onOpenChange,
  onResized,
}: {
  vm: VmDetail;
  isAdmin: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResized: () => void;
}) {
  const [quota, setQuota] = useState<Quota | null>(null);
  const [cpu, setCpu] = useState(vm.cpu);
  // Memory is edited in GB but kept exact in MB: the field shows a rounded GB value
  // (a VM with 1000 MB opens as "0.98"), while an untouched field stays exactly
  // vm.ram and is never sent (or quota-checked) as a change nobody asked for.
  const [ramMb, setRamMb] = useState(vm.ram);
  const [ramInput, setRamInput] = useState(gbLabel(vm.ram));
  const [storageGb, setStorageGb] = useState(vm.storage);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // On open, reset the form to the VM's current size and (re)load the quota so the
  // ceilings reflect the user's other VMs.
  useEffect(() => {
    if (!open) return;
    setCpu(vm.cpu);
    setRamMb(vm.ram);
    setRamInput(gbLabel(vm.ram));
    setStorageGb(vm.storage);
    setError(null);
    if (!isAdmin) {
      api
        .get<MeResponse>("/auth/me")
        .then((r) => setQuota(r.data.user.quota))
        .catch(() => setQuota(null));
    }
  }, [open, vm.cpu, vm.ram, vm.storage, isAdmin]);

  // Per-field ceilings from remaining quota — the VM's own current size is freed
  // first, so a resize is judged on the delta (matches the backend).
  const cpuMax = !isAdmin && quota ? quota.cpu.max - quota.cpu.used + vm.cpu : Infinity;
  const ramMaxMb = !isAdmin && quota ? quota.ram.max - quota.ram.used + vm.ram : Infinity;
  const ramMaxGb = Math.floor((ramMaxMb / 1024) * 100) / 100;
  const storageMax = !isAdmin && quota ? quota.storage.max - quota.storage.used + vm.storage : Infinity;

  const changed = cpu !== vm.cpu || ramMb !== vm.ram || storageGb !== vm.storage;
  const activePreset = SIZE_PRESETS.find((p) => p.cpu === cpu && p.ramGb * 1024 === ramMb && p.diskGb === storageGb)?.key;

  function validate(): string | null {
    if (cpu < 1) return "At least 1 vCPU.";
    if (cpu > cpuMax) return `Exceeds your remaining quota — up to ${cpuMax} vCPU.`;
    if (ramMb < MIN_RAM_MB) return `At least ${MIN_RAM_MB} MB of memory.`;
    if (ramMb > ramMaxMb) return `Exceeds your remaining quota — up to ${ramMaxGb} GB memory.`;
    if (storageGb < vm.storage) return `Disks can only grow — minimum ${vm.storage} GB.`;
    if (storageGb > storageMax) return `Exceeds your remaining quota — up to ${storageMax} GB disk.`;
    if (!changed) return "Nothing to change.";
    return null;
  }

  async function submit() {
    const v = validate();
    if (v) { setError(v); return; }
    setSaving(true);
    try {
      await api.patch(`/vms/${vm.id}`, {
        ...(cpu !== vm.cpu ? { cpu } : {}),
        ...(ramMb !== vm.ram ? { ram: ramMb } : {}),
        ...(storageGb !== vm.storage ? { storage: storageGb } : {}),
      });
      toast.success(
        "VM resized. CPU/RAM changes may need a reboot; grow the filesystem inside the guest to use new disk space.",
      );
      onResized();
      onOpenChange(false);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  const gb = (v: string) => Math.max(0, Number(v) || 0);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Resize {vm.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Change vCPU, memory and disk. Disk can only grow. CPU/RAM the guest can&apos;t hot-plug
            apply on the next reboot; after growing the disk, extend the filesystem inside the VM.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-wrap gap-2">
          {SIZE_PRESETS.map((p) => {
            const wouldShrinkDisk = p.diskGb < vm.storage;
            return (
              <button
                key={p.key}
                type="button"
                disabled={wouldShrinkDisk}
                aria-pressed={activePreset === p.key}
                onClick={() => {
                  setCpu(p.cpu);
                  setRamMb(p.ramGb * 1024);
                  setRamInput(String(p.ramGb));
                  setStorageGb(Math.max(p.diskGb, vm.storage));
                  setError(null);
                }}
                title={wouldShrinkDisk ? "Would shrink the disk — not allowed" : undefined}
                className={
                  "rounded-md border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
                  (activePreset === p.key ? "border-primary bg-primary/10" : "hover:bg-accent")
                }
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <FormField label="vCPU" htmlFor="rs-cpu">
            <NumberInput
              id="rs-cpu"
              min={1}
              value={cpu}
              onValueChange={(v) => { setCpu(v); setError(null); }}
            />
          </FormField>
          <FormField label="Memory (GB)" htmlFor="rs-ram">
            <Input
              id="rs-ram"
              type="number"
              min={MIN_RAM_MB / 1024}
              step="any"
              value={ramInput}
              onChange={(e) => {
                setRamInput(e.target.value);
                setRamMb(Math.round(gb(e.target.value) * 1024));
                setError(null);
              }}
            />
          </FormField>
          <FormField label="Disk (GB)" htmlFor="rs-disk">
            <NumberInput
              id="rs-disk"
              min={vm.storage}
              value={storageGb}
              onValueChange={(v) => { setStorageGb(v); setError(null); }}
            />
          </FormField>
        </div>

        {!isAdmin && quota && (
          <p className="text-xs text-muted-foreground">
            With your other VMs, this one can go up to {cpuMax} vCPU · {ramMaxGb} GB RAM · {storageMax} GB disk.
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={saving || !changed}>
            {saving ? <Loader2 className="animate-spin" /> : <Scaling />}
            Apply
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
