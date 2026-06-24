"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Package, Plus, Rocket, HardDrive } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { MeResponse, ProxmoxNode, ProxmoxIso, Template, VirtualMachine } from "@/lib/types";
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
const CUSTOM = "custom";
const CUSTOM_DISK_DEFAULT = 20;

export default function NewVmWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  const [quota, setQuota] = useState<MeResponse["user"]["quota"] | null>(null);
  const [nodes, setNodes] = useState<ProxmoxNode[]>([]);
  const [isos, setIsos] = useState<ProxmoxIso[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // `source` is either CUSTOM (install from ISO) or a template id (clone + autoscale).
  const [source, setSource] = useState<string>(CUSTOM);
  const [name, setName] = useState("");
  const [cpu, setCpu] = useState(1);
  const [ramGb, setRamGb] = useState(2);
  const [storageGb, setStorageGb] = useState(CUSTOM_DISK_DEFAULT);
  const [os, setOs] = useState("");
  const [node, setNode] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<MeResponse>("/auth/me"),
      api.get<ProxmoxNode[]>("/proxmox/nodes"),
      api.get<ProxmoxIso[]>("/proxmox/isos"),
      api.get<Template[]>("/templates"),
    ])
      .then(([meRes, nodesRes, isosRes, tplRes]) => {
        setQuota(meRes.data.user.quota);
        setNodes(nodesRes.data);
        setIsos(isosRes.data);
        setTemplates(tplRes.data);
        if (nodesRes.data[0]) setNode(nodesRes.data[0].node);

        // Deep-link preselect: /vms/new?template=<id> (e.g. the store's Deploy button).
        const wanted = searchParams.get("template");
        const preselected = wanted ? tplRes.data.find((t) => t.id === wanted) : undefined;
        if (preselected) {
          setSource(preselected.id);
          setStorageGb(Math.max(preselected.diskGb, 1));
        }
      })
      .catch((err) => setLoadError(apiError(err)))
      .finally(() => setLoading(false));
  }, [searchParams]);

  const template = source === CUSTOM ? null : templates.find((t) => t.id === source) ?? null;
  const isCustom = source === CUSTOM;
  const minDisk = template?.diskGb ?? 1;

  const cpuLeft = quota ? quota.cpu.max - quota.cpu.used : 0;
  const ramLeftMb = quota ? quota.ram.max - quota.ram.used : 0;
  const storageLeft = quota ? quota.storage.max - quota.storage.used : 0;

  function onSourceChange(v: string) {
    setSource(v);
    setErrors({});
    if (v === CUSTOM) {
      setStorageGb(CUSTOM_DISK_DEFAULT);
    } else {
      const t = templates.find((x) => x.id === v);
      setStorageGb(t ? Math.max(t.diskGb, 1) : CUSTOM_DISK_DEFAULT);
    }
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!/^[a-zA-Z0-9-]+$/.test(name)) e.name = "Use letters, numbers and hyphens only";
    if (cpu < 1) e.cpu = "At least 1 vCPU";
    else if (!isAdmin && cpu > cpuLeft) e.cpu = `Exceeds your remaining ${cpuLeft} vCPU`;
    if (!isAdmin && ramGb * 1024 > ramLeftMb) e.ram = `Exceeds your remaining ${formatRam(ramLeftMb)}`;
    if (storageGb < minDisk)
      e.storage = template ? `Template needs at least ${minDisk} GB` : "At least 1 GB";
    else if (!isAdmin && storageGb > storageLeft) e.storage = `Exceeds your remaining ${storageLeft} GB`;
    if (isCustom && !os) e.os = "Select an installation ISO";
    if (isCustom && !node) e.node = "Select a node";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      if (isCustom) {
        const res = await api.post<{ vm: VirtualMachine }>("/vms", {
          name,
          cpu,
          ram: ramGb * 1024,
          storage: storageGb,
          os,
          node,
        });
        toast.success(`VM "${name}" is being created.`);
        router.push(`/vms/${res.data.vm.id}`);
      } else {
        const res = await api.post<{ vm: VirtualMachine }>("/templates/deploy", {
          templateId: source,
          name,
          cpu,
          ram: ramGb * 1024,
          storage: storageGb,
        });
        toast.success(`Deploying "${name}" from ${template?.name}.`);
        router.push(`/vms/${res.data.vm.id}`);
      }
    } catch (err) {
      toast.error(apiError(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="Create a virtual machine"
        description="Build from scratch with an ISO, or clone a ready-made template — autoscaled to the size you pick."
      >
        <Button variant="ghost" render={<Link href="/vms" />}>
          <ArrowLeft />
          Back
        </Button>
      </PageHeader>

      <Card>
        {loading ? (
          <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading options…
          </CardContent>
        ) : loadError ? (
          <CardContent className="py-8 text-center text-sm text-destructive">{loadError}</CardContent>
        ) : (
          <>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
              <CardDescription>
                {isAdmin
                  ? "Creating as admin — limited only by cluster capacity."
                  : `Remaining quota: ${cpuLeft} vCPU · ${formatRam(ramLeftMb)} · ${storageLeft} GB disk`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} className="grid gap-4">
                <FormField
                  label="Source"
                  hint={
                    isCustom
                      ? "Install a fresh OS from an ISO image."
                      : template
                        ? `${template.description || template.os || "Linux template"} · ${template.diskGb} GB base`
                        : undefined
                  }
                >
                  <Select value={source} onValueChange={(v) => onSourceChange(v as string)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={CUSTOM}>
                        <span className="flex items-center gap-2">
                          <Plus className="size-3.5" /> Custom VM (install from ISO)
                        </span>
                      </SelectItem>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          <span className="flex items-center gap-2">
                            <Package className="size-3.5" /> {t.name}
                            <span className="text-muted-foreground">· {t.diskGb} GB</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>

                <FormField label="Name" htmlFor="name" error={errors.name} hint="e.g. web-server-01">
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </FormField>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label="vCPU cores" htmlFor="cpu" error={errors.cpu}>
                    <Input
                      id="cpu"
                      type="number"
                      min={1}
                      value={cpu}
                      onChange={(e) => setCpu(Number(e.target.value))}
                    />
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
                  hint={
                    template
                      ? `Minimum ${minDisk} GB (template base) — can grow, not shrink`
                      : undefined
                  }
                >
                  <Input
                    id="storage"
                    type="number"
                    min={minDisk}
                    value={storageGb}
                    onChange={(e) => setStorageGb(Number(e.target.value))}
                  />
                </FormField>

                {isCustom && (
                  <>
                    <FormField label="Installation ISO" error={errors.os}>
                      <Select value={os} onValueChange={(v) => setOs(v as string)}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={isos.length ? "Select an ISO" : "No ISOs available"} />
                        </SelectTrigger>
                        <SelectContent>
                          {isos.map((iso) => (
                            <SelectItem key={iso.volid} value={iso.name}>
                              {iso.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>

                    <FormField label="Node" error={errors.node}>
                      <Select value={node} onValueChange={(v) => setNode(v as string)}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a node" />
                        </SelectTrigger>
                        <SelectContent>
                          {nodes.map((n) => (
                            <SelectItem key={n.node} value={n.node}>
                              {n.node}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                  </>
                )}

                {!isCustom && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <HardDrive className="size-3.5" />
                    Clones stay on the template&apos;s node and storage — fast and space-efficient.
                  </p>
                )}

                <Button type="submit" disabled={submitting} className="mt-2">
                  {submitting ? (
                    <Loader2 className="animate-spin" />
                  ) : isCustom ? (
                    <Plus />
                  ) : (
                    <Rocket />
                  )}
                  {isCustom ? "Create VM" : "Deploy"}
                </Button>
              </form>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
