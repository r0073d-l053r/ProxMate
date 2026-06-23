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
