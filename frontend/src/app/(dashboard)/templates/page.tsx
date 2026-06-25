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
  Cloud,
  Container,
} from "lucide-react";
import { api, apiError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useAuthStore } from "@/lib/auth-store";
import type { Template, DiscoveredTemplate, CuratedImage } from "@/lib/types";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

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

      {isAdmin && <AddCloudImagePanel onChange={load} />}
      {isAdmin && <CloudInitExtrasCard />}
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
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t.name}
          {t.cloudInit && (
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <Cloud className="size-3" /> Cloud-init
            </Badge>
          )}
        </CardTitle>
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
      title="Delete template (store + Proxmox)"
      onClick={async () => {
        if (
          !window.confirm(
            "Delete this template from the store AND from the Proxmox cluster?\n\n" +
              "Any VMs already cloned from it must be deleted first.",
          )
        )
          return;
        setBusy(true);
        try {
          await api.delete(`/templates/${id}`);
          toast.success("Template deleted from the store and Proxmox.");
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

interface CloudInitBundle {
  features: string[];
  label: string;
  file: string;
  volid: string;
  content: string;
  command: string;
  nodesReady: string[];
}

interface CloudInitExtras {
  storage: string;
  snippetsEnabled: boolean;
  features: { id: string; label: string; hint: string }[];
  bundles: CloudInitBundle[];
}

function CloudInitExtrasCard() {
  const [extras, setExtras] = useState<CloudInitExtras | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api
      .get<CloudInitExtras>("/templates/cloud-init-extras")
      .then((r) => setExtras(r.data))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function enable() {
    setBusy(true);
    try {
      const r = await api.post<CloudInitExtras>("/templates/cloud-init-extras/enable");
      setExtras(r.data);
      setOpen(true);
      toast.success("Snippets enabled — now place the snippets below on each node.");
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(cmd: string) {
    (await copyText(cmd)) ? toast.success("Command copied.") : toast.error("Couldn't copy — select it manually.");
  }

  if (!extras) return null;

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Container className="size-4" /> Cloud-init extras (admin)
            </CardTitle>
            <CardDescription>
              Enables the &ldquo;Install Docker / Tailscale&rdquo; checkboxes when tenants deploy a cloud image.
              Proxmox&apos;s API can&apos;t create snippet files, so each is a one-time manual step per node.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Set up"}
          </Button>
        </div>
        <div className="mt-1">
          <Badge variant={extras.snippetsEnabled ? "secondary" : "outline"}>
            {extras.snippetsEnabled ? "✓" : "○"} snippets enabled
          </Badge>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="grid gap-4 text-sm">
          {!extras.snippetsEnabled && (
            <div>
              <p className="mb-2 text-muted-foreground">
                Step 1 — enable the <code>snippets</code> content type on <code>{extras.storage}</code> (ProxMate does
                this via the API):
              </p>
              <Button size="sm" disabled={busy} onClick={enable}>
                {busy ? <Loader2 className="animate-spin" /> : <Check />} Enable snippets
              </Button>
            </div>
          )}
          <div className="grid gap-3">
            <p className="text-muted-foreground">
              {extras.snippetsEnabled ? "" : "Step 2 — "}On <strong>each Proxmox node</strong>, run the command for each
              option you want to offer. (The combined snippet is needed only if a tenant selects more than one.)
            </p>
            {extras.bundles.map((b) => {
              const ready = b.nodesReady.length > 0;
              return (
                <div key={b.file} className="rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="font-medium">{b.label}</span>
                    <Badge variant={ready ? "secondary" : "outline"} className="text-[10px]">
                      {ready ? `✓ ${b.nodesReady.join(", ")}` : "○ not placed"}
                    </Badge>
                  </div>
                  <div className="relative">
                    <pre className="max-h-48 overflow-auto rounded-md border bg-muted/60 p-3 pr-16 text-xs">
                      {b.command}
                    </pre>
                    <Button
                      size="sm"
                      variant="outline"
                      className="absolute right-2 top-2"
                      onClick={() => copy(b.command)}
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              );
            })}
            <Button variant="ghost" size="sm" onClick={load}>
              <RefreshCw /> Re-check nodes
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function AddCloudImagePanel({ onChange }: { onChange: () => void }) {
  const [images, setImages] = useState<CuratedImage[] | null>(null);
  const [choice, setChoice] = useState(""); // a curated image id or "custom"
  const [name, setName] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customOs, setCustomOs] = useState("");
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    api
      .get<CuratedImage[]>("/templates/cloud-images")
      .then((r) => setImages(r.data))
      .catch(() => setImages([]));
  }, []);

  const isCustom = choice === "custom";
  const selected = images?.find((i) => i.id === choice);

  function onChoice(v: string) {
    setChoice(v);
    const img = images?.find((i) => i.id === v);
    if (img && !name) setName(img.label);
  }

  async function add() {
    const imageUrl = isCustom ? customUrl.trim() : selected?.url;
    const os = isCustom ? customOs.trim() || undefined : selected?.os;
    if (!imageUrl || !name.trim()) {
      toast.error("Pick an image and give it a name.");
      return;
    }
    setBuilding(true);
    try {
      // The image download + import takes minutes, so allow a long timeout.
      await api.post("/templates/cloud-image", { name: name.trim(), imageUrl, os }, { timeout: 20 * 60 * 1000 });
      toast.success(`"${name}" built and added to the store.`);
      setChoice("");
      setName("");
      setCustomUrl("");
      setCustomOs("");
      onChange();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBuilding(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Cloud className="size-4" /> Add a cloud image (admin)
        </CardTitle>
        <CardDescription>
          A one-click cloud-init OS. ProxMate downloads the image and builds a template — users deploy it
          with their SSH key and it&apos;s ready to log into on first boot, no installer.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <label className="text-xs font-medium">Image</label>
            <Select value={choice} onValueChange={(v) => onChoice(v as string)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={images ? "Choose a cloud image" : "Loading…"} />
              </SelectTrigger>
              <SelectContent>
                {images?.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom image URL…</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs font-medium">Store name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Debian 12" />
          </div>
        </div>

        {isCustom && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <label className="text-xs font-medium">Image URL (.qcow2 / .img)</label>
              <Input
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://…/image.qcow2"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs font-medium">OS label (optional)</label>
              <Input value={customOs} onChange={(e) => setCustomOs(e.target.value)} placeholder="e.g. Rocky Linux 9" />
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button size="sm" disabled={building || !choice} onClick={add}>
            {building ? <Loader2 className="animate-spin" /> : <Download />}
            {building ? "Building…" : "Add to store"}
          </Button>
          {building && (
            <span className="text-xs text-muted-foreground">
              Downloading &amp; importing the image — this can take a few minutes.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
