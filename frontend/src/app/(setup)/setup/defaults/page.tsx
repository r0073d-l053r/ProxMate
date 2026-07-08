"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useSetupStore } from "@/lib/setup-store";
import type { ProxmoxResources } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function SetupDefaultsPage() {
  const router = useRouter();
  const setSetup = useSetupStore((s) => s.set);

  const [resources, setResources] = useState<ProxmoxResources | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [storage, setStorage] = useState("");
  const [bridge, setBridge] = useState("");
  const [isoStorage, setIsoStorage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Cloud-init "always-on base" — features installed on every cloud-init VM.
  // Pre-selected to the recommended set; the admin can change it (and later edit
  // it, plus the tenant-offered options, in the Template Store).
  const [ciCatalog, setCiCatalog] = useState<{ id: string; label: string; hint: string }[]>([]);
  const [ciOffered, setCiOffered] = useState<string[]>([]);
  const [ciBase, setCiBase] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<ProxmoxResources>("/setup/proxmox/resources");
      setResources(res.data);
    } catch (err) {
      setLoadError(apiError(err));
    } finally {
      setLoading(false);
    }
    // Best-effort — never block setup if this fails.
    try {
      const r = await api.get<{
        catalog: { id: string; label: string; hint: string }[];
        offered: string[];
        recommendedBase: string[];
      }>("/templates/cloud-init-config");
      setCiCatalog(r.data.catalog ?? []);
      setCiOffered(r.data.offered ?? []);
      setCiBase(new Set(r.data.recommendedBase ?? []));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onSubmit() {
    if (!storage || !bridge || !isoStorage) {
      toast.error("Please select a value for each default.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/setup/defaults", { storage, bridge, isoStorage });
      // Save the cloud-init always-on base (best-effort — editable later in the
      // Template Store, so a failure here never blocks finishing setup).
      if (ciCatalog.length > 0) {
        await api
          .put("/templates/cloud-init-config", { offered: ciOffered, base: [...ciBase] })
          .catch(() => {});
      }
      setSetup({ defaultStorage: storage, defaultBridge: bridge, isoStorage });
      router.push("/setup/complete");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose defaults</CardTitle>
        <CardDescription>
          These defaults are applied when users create VMs — the disk storage pool, network bridge,
          and where ISO images live.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Fetching Proxmox resources…
          </div>
        ) : loadError ? (
          <div className="grid gap-3 py-4 text-center">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" onClick={load} className="justify-self-center">
              <RefreshCw /> Retry
            </Button>
          </div>
        ) : (
          <div className="grid gap-4">
            <FormField label="Default storage pool" hint="Where VM disks are allocated">
              <Select value={storage} onValueChange={(v) => setStorage(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a storage pool" />
                </SelectTrigger>
                <SelectContent>
                  {resources?.storages.map((s) => (
                    <SelectItem key={s.name} value={s.name}>
                      {s.name}
                      <span className="text-muted-foreground"> · {s.type}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="Default network bridge">
              <Select value={bridge} onValueChange={(v) => setBridge(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a network bridge" />
                </SelectTrigger>
                <SelectContent>
                  {resources?.bridges.map((b) => (
                    <SelectItem key={b.name} value={b.name}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="ISO storage" hint="Where installer images are stored">
              <Select value={isoStorage} onValueChange={(v) => setIsoStorage(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select ISO storage" />
                </SelectTrigger>
                <SelectContent>
                  {resources?.isoStorages.map((s) => (
                    <SelectItem key={s.name} value={s.name}>
                      {s.name}
                      <span className="text-muted-foreground"> · {s.type}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {ciCatalog.length > 0 && (
              <FormField
                label="Installed on every cloud-init VM"
                hint="Auto-installed on each new VM. Change this (and which options tenants can pick) anytime in the Template Store."
              >
                <div className="grid gap-1.5 rounded-md border p-3 sm:grid-cols-2">
                  {ciCatalog.map((f) => (
                    <label key={f.id} className="flex items-start gap-2 text-xs" title={f.hint}>
                      <input
                        type="checkbox"
                        checked={ciBase.has(f.id)}
                        onChange={(e) =>
                          setCiBase((prev) => {
                            const n = new Set(prev);
                            if (e.target.checked) n.add(f.id);
                            else n.delete(f.id);
                            return n;
                          })
                        }
                        className="mt-0.5 size-3.5 accent-primary"
                      />
                      <span>{f.label}</span>
                    </label>
                  ))}
                </div>
              </FormField>
            )}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={() => router.push("/setup/proxmox")}>
            <ArrowLeft />
            Back
          </Button>
          <Button disabled={submitting || loading || !!loadError} onClick={onSubmit}>
            {submitting ? <Loader2 className="animate-spin" /> : null}
            Continue
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
