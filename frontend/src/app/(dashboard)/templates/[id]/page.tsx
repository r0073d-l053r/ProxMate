"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Rocket, Package } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { MeResponse, Template, VirtualMachine } from "@/lib/types";
import { formatRam } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const RAM_OPTIONS = [1, 2, 4, 8, 16, 32];

export default function DeployTemplatePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  const [template, setTemplate] = useState<Template | null>(null);
  const [quota, setQuota] = useState<MeResponse["user"]["quota"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [cpu, setCpu] = useState(1);
  const [ramGb, setRamGb] = useState(2);
  const [storageGb, setStorageGb] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([api.get<Template[]>("/templates"), api.get<MeResponse>("/auth/me")])
      .then(([tplRes, meRes]) => {
        const t = tplRes.data.find((x) => x.id === id) ?? null;
        setTemplate(t);
        setQuota(meRes.data.user.quota);
        if (t) setStorageGb(Math.max(t.diskGb, 1));
        if (!t) setLoadError("Template not found.");
      })
      .catch((err) => setLoadError(apiError(err)))
      .finally(() => setLoading(false));
  }, [id]);

  const cpuLeft = quota ? quota.cpu.max - quota.cpu.used : 0;
  const ramLeftMb = quota ? quota.ram.max - quota.ram.used : 0;
  const storageLeft = quota ? quota.storage.max - quota.storage.used : 0;
  const minDisk = template?.diskGb ?? 1;

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!/^[a-zA-Z0-9-]+$/.test(name)) e.name = "Use letters, numbers and hyphens only";
    if (cpu < 1) e.cpu = "At least 1 vCPU";
    else if (!isAdmin && cpu > cpuLeft) e.cpu = `Exceeds your remaining ${cpuLeft} vCPU`;
    if (!isAdmin && ramGb * 1024 > ramLeftMb) e.ram = `Exceeds your remaining ${formatRam(ramLeftMb)}`;
    if (storageGb < minDisk) e.storage = `Template needs at least ${minDisk} GB`;
    else if (!isAdmin && storageGb > storageLeft) e.storage = `Exceeds your remaining ${storageLeft} GB`;
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ vm: VirtualMachine }>("/templates/deploy", {
        templateId: id,
        name,
        cpu,
        ram: ramGb * 1024,
        storage: storageGb,
      });
      toast.success(`Deploying "${name}" from ${template?.name}.`);
      router.push(`/vms/${res.data.vm.id}`);
    } catch (err) {
      toast.error(apiError(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Deploy from template" description="A pre-built OS image, autoscaled to the size you pick.">
        <Button variant="ghost" render={<Link href="/templates" />}>
          <ArrowLeft />
          Store
        </Button>
      </PageHeader>

      <Card>
        {loading ? (
          <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </CardContent>
        ) : loadError || !template ? (
          <CardContent className="py-8 text-center text-sm text-destructive">
            {loadError ?? "Template not found."}
          </CardContent>
        ) : (
          <>
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Package className="size-4" />
                </div>
                <CardTitle>{template.name}</CardTitle>
              </div>
              <CardDescription>
                {template.description || template.os || "Linux template"} ·{" "}
                {isAdmin
                  ? "limited only by cluster capacity"
                  : `remaining ${cpuLeft} vCPU · ${formatRam(ramLeftMb)} · ${storageLeft} GB`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} className="grid gap-4">
                <FormField label="Name" htmlFor="name" error={errors.name} hint="e.g. web-01">
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </FormField>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label="vCPU cores" htmlFor="cpu" error={errors.cpu}>
                    <Input id="cpu" type="number" min={1} value={cpu} onChange={(e) => setCpu(Number(e.target.value))} />
                  </FormField>
                  <FormField label="Memory" error={errors.ram}>
                    <Select value={String(ramGb)} onValueChange={(v) => setRamGb(Number(v))}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RAM_OPTIONS.map((gb) => (
                          <SelectItem key={gb} value={String(gb)}>
                            {gb} GB
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                </div>

                <FormField
                  label="Disk size (GB)"
                  htmlFor="storage"
                  error={errors.storage}
                  hint={`Minimum ${minDisk} GB (template base) — can grow, not shrink`}
                >
                  <Input
                    id="storage"
                    type="number"
                    min={minDisk}
                    value={storageGb}
                    onChange={(e) => setStorageGb(Number(e.target.value))}
                  />
                </FormField>

                <Button type="submit" disabled={submitting} className="mt-2">
                  {submitting ? <Loader2 className="animate-spin" /> : <Rocket />}
                  Deploy
                </Button>
              </form>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
