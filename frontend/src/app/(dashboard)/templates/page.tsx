"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Package,
  Plus,
  Trash2,
  HardDrive,
  Loader2,
  Download,
  RefreshCw,
  KeyRound,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { Template, DiscoveredTemplate } from "@/lib/types";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
            <TemplateCard key={t.id} t={t} isAdmin={isAdmin} onChange={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({
  t,
  isAdmin,
  onChange,
}: {
  t: Template;
  isAdmin: boolean;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(t.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/templates/${t.id}`, { notes });
      toast.success("Notes saved.");
      setEditing(false);
      onChange();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Package className="size-5" />
          </div>
          {isAdmin && <UnregisterButton id={t.id} onDone={onChange} />}
        </div>
        <CardTitle>{t.name}</CardTitle>
        <CardDescription>{t.description || t.os || "Linux template"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {editing ? (
          <div className="grid gap-2">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Default login & setup notes shown to users — e.g. user: debian / pass: changeme"
              className="h-24 w-full resize-none rounded-md border bg-background p-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="animate-spin" /> : <Check />} Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setNotes(t.notes ?? "");
                }}
              >
                <X /> Cancel
              </Button>
            </div>
          </div>
        ) : t.notes ? (
          <div className="rounded-md bg-muted/60 p-2.5 text-xs">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
              <KeyRound className="size-3.5" /> Login & notes
            </div>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">{t.notes}</p>
          </div>
        ) : isAdmin ? (
          <p className="text-xs text-muted-foreground italic">No login notes yet — add them so users can sign in.</p>
        ) : null}

        <div className="mt-auto flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <HardDrive className="size-3.5" /> {t.diskGb} GB base
          </span>
          <div className="flex items-center gap-1">
            {isAdmin && !editing && (
              <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} title="Edit notes">
                <Pencil />
              </Button>
            )}
            <Button size="sm" render={<Link href={`/vms/new?template=${t.id}`} />}>
              Deploy
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
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

  const loadDiscover = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<DiscoveredTemplate[]>("/templates/discover");
      setDiscovered(res.data);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm">Manage templates (admin)</CardTitle>
            <CardDescription>
              Publish a Proxmox template to the store. Add login notes so users know how to sign in.
              Tip: build a minimal VM, install the guest agent, then convert it to a template from its
              detail page.
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
                <DiscoveredRow
                  key={d.vmid}
                  d={d}
                  onPublished={() => {
                    loadDiscover();
                    onChange();
                  }}
                />
              ))}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function DiscoveredRow({ d, onPublished }: { d: DiscoveredTemplate; onPublished: () => void }) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function publish() {
    setBusy(true);
    try {
      await api.post("/templates", {
        proxmoxVmId: d.vmid,
        node: d.node,
        name: d.name,
        diskGb: d.diskGb,
        notes: notes.trim() || undefined,
      });
      toast.success(`"${d.name}" published to the store.`);
      onPublished();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-medium">{d.name}</span>
          <span className="text-muted-foreground">
            {" "}
            · vmid {d.vmid} · {d.node} · {d.diskGb} GB
          </span>
        </div>
        <Button size="sm" disabled={busy} onClick={publish}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Publish
        </Button>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional login notes shown to users — e.g. user: debian / pass: changeme"
        className="mt-2 h-16 w-full resize-none rounded-md border bg-background p-2 text-xs outline-none focus:ring-2 focus:ring-ring"
      />
    </li>
  );
}
