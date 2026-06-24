"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Package, Plus, Trash2, HardDrive, Loader2, Download, RefreshCw } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { Template, DiscoveredTemplate } from "@/lib/types";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export default function TemplatesPage() {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<Template[]>("/templates")
      .then((res) => setTemplates(res.data))
      .catch((err) => setError(apiError(err)));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Template Store"
        description="Spin up a ready-made OS build in seconds — or build a custom VM from scratch."
      >
        <Button variant="outline" render={<Link href="/vms/new" />}>
          <Plus />
          Custom VM
        </Button>
      </PageHeader>

      {isAdmin && <AdminTemplateManager onChange={load} />}

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {templates === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Package className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No templates published yet.
              {isAdmin ? " Add one from your cluster above." : " Check back later, or build a custom VM."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={t.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Package className="size-5" />
                  </div>
                  {isAdmin && <UnregisterButton id={t.id} onDone={load} />}
                </div>
                <CardTitle>{t.name}</CardTitle>
                <CardDescription>{t.description || t.os || "Linux template"}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <HardDrive className="size-3.5" /> {t.diskGb} GB base
                </span>
                <Button size="sm" render={<Link href={`/vms/new?template=${t.id}`} />}>
                  Deploy
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function UnregisterButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      disabled={busy}
      title="Remove from store"
      onClick={async () => {
        setBusy(true);
        try {
          await api.delete(`/templates/${id}`);
          toast.success("Removed from store.");
          onDone();
        } catch (err) {
          toast.error(apiError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
    </Button>
  );
}

function AdminTemplateManager({ onChange }: { onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [addingVmid, setAddingVmid] = useState<number | null>(null);

  async function loadDiscover() {
    setLoading(true);
    try {
      const res = await api.get<DiscoveredTemplate[]>("/templates/discover");
      setDiscovered(res.data);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  }

  async function add(d: DiscoveredTemplate) {
    setAddingVmid(d.vmid);
    try {
      await api.post("/templates", {
        proxmoxVmId: d.vmid,
        node: d.node,
        name: d.name,
        diskGb: d.diskGb,
      });
      toast.success(`"${d.name}" published to the store.`);
      await loadDiscover();
      onChange();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setAddingVmid(null);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm">Manage templates (admin)</CardTitle>
            <CardDescription>
              Publish a Proxmox template to the store. Tip: build a minimal VM, install the guest
              agent, then convert it to a template from its detail page.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen((o) => !o);
              if (!discovered) loadDiscover();
            }}
          >
            <Download />
            Add from cluster
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Scanning cluster…
            </div>
          ) : !discovered || discovered.length === 0 ? (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>No unpublished Proxmox templates found.</span>
              <Button variant="ghost" size="sm" onClick={loadDiscover}>
                <RefreshCw /> Rescan
              </Button>
            </div>
          ) : (
            <ul className="divide-y">
              {discovered.map((d) => (
                <li key={d.vmid} className="flex items-center justify-between py-2">
                  <div className="text-sm">
                    <span className="font-medium">{d.name}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · vmid {d.vmid} · {d.node} · {d.diskGb} GB
                    </span>
                  </div>
                  <Button size="sm" disabled={addingVmid === d.vmid} onClick={() => add(d)}>
                    {addingVmid === d.vmid ? <Loader2 className="animate-spin" /> : <Plus />}
                    Publish
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}
