"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  ImagePlus,
  Search,
  ChevronsUpDown,
  Cpu,
} from "lucide-react";
import { api, apiError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatRelative } from "@/lib/format";
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
import { TemplateIcon, fileToIconDataUrl } from "@/components/template-icon";

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
  const [icon, setIcon] = useState(t.icon);
  const [saving, setSaving] = useState(false);

  async function onPickIcon(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    try {
      setIcon(await fileToIconDataUrl(file));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load that image.");
    }
  }

  async function save() {
    setSaving(true);
    try {
      // Only send the icon when it changed (the data-URI can be a few KB).
      await api.patch(`/templates/${t.id}`, { notes, ...(icon !== t.icon ? { icon } : {}) });
      toast.success("Template updated.");
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
          <div className="flex size-9 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-primary">
            <TemplateIcon os={t.os} name={t.name} icon={t.icon} className="size-5" />
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
          {t.arch && (
            <Badge variant="outline" className="gap-1 text-[10px]">
              <Cpu className="size-3" /> {t.arch === "arm64" ? "ARM64" : "x86-64"}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{t.description || t.os || "Linux template"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {editing ? (
          <div className="grid gap-2">
            <div className="flex items-center gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/40">
                <TemplateIcon os={t.os} name={t.name} icon={icon} className="size-7" />
              </div>
              <div className="flex flex-col items-start gap-1">
                <label className="cursor-pointer">
                  <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:bg-muted">
                    <ImagePlus className="size-3.5" /> Upload icon
                  </span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="hidden"
                    onChange={onPickIcon}
                  />
                </label>
                {icon ? (
                  <button
                    type="button"
                    onClick={() => setIcon(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Use OS default
                  </button>
                ) : (
                  <span className="text-xs text-muted-foreground">Auto-matched to {t.os || "the OS"}</span>
                )}
              </div>
            </div>
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
                  setIcon(t.icon);
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
            {isAdmin && !editing && t.cloudInit && t.sourceUrl && (
              <RefreshTemplateButton t={t} onDone={onChange} />
            )}
            {isAdmin && !editing && (
              <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} title="Edit notes & icon">
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

/**
 * Admin: rebuild a cloud-image template from its source URL so new deploys start
 * from a freshly-downloaded, patched base. Long-running (re-downloads the image);
 * repoints the same store entry and removes the old Proxmox template.
 */
function RefreshTemplateButton({ t, onDone }: { t: Template; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      disabled={busy}
      title={
        t.refreshedAt
          ? `Rebuild from the latest cloud image (last refreshed ${formatRelative(t.refreshedAt)})`
          : "Rebuild from the latest cloud image"
      }
      onClick={async () => {
        if (
          !window.confirm(
            "Rebuild this template from the latest upstream cloud image?\n\n" +
              "New deploys will start from the fresh, patched image. Existing VMs are unaffected. " +
              "This re-downloads the image and can take a few minutes.",
          )
        )
          return;
        setBusy(true);
        try {
          await api.post(`/templates/${t.id}/refresh`);
          toast.success("Template refreshed from the latest cloud image.");
          onDone();
        } catch (err) {
          toast.error(apiError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
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
  onDemand: boolean;
  features: { id: string; label: string; hint: string }[];
  base: { id: string; label: string }[];
  catalog: { id: string; label: string; hint: string }[];
  offered: string[];
  baseSelected: string[];
  recommendedBase: string[];
  bundles: CloudInitBundle[];
}

function CloudInitExtrasCard() {
  const [extras, setExtras] = useState<CloudInitExtras | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  // Admin selection (editable copies of extras.offered / extras.baseSelected).
  const [offeredSel, setOfferedSel] = useState<Set<string>>(new Set());
  const [baseSel, setBaseSel] = useState<Set<string>>(new Set());
  // Searchable snippet picker state.
  const [query, setQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [comboOpen, setComboOpen] = useState(false);
  const comboRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api
      .get<CloudInitExtras>("/templates/cloud-init-extras")
      .then((r) => {
        setExtras(r.data);
        setOfferedSel(new Set(r.data.offered));
        setBaseSel(new Set(r.data.baseSelected));
      })
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  function toggle(setter: (fn: (s: Set<string>) => Set<string>) => void, id: string, on: boolean) {
    setter((prev) => {
      const n = new Set(prev);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  async function saveSelection() {
    setSaving(true);
    try {
      await api.put("/templates/cloud-init-config", { offered: [...offeredSel], base: [...baseSel] });
      toast.success("Cloud-init options saved.");
      load(); // re-fetch the FULL extras (config PUT returns only the selection)
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setSaving(false);
    }
  }

  // Close the picker dropdown when clicking outside it.
  useEffect(() => {
    if (!comboOpen) return;
    function onDown(e: MouseEvent) {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) setComboOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [comboOpen]);

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

  const allBundles = extras.bundles ?? [];
  const selectedBundle = allBundles.find((b) => b.file === selectedFile) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? allBundles.filter(
        (b) => b.label.toLowerCase().includes(q) || b.features.some((f) => f.toLowerCase().includes(q)),
      )
    : allBundles;

  function selectBundle(b: CloudInitBundle) {
    setSelectedFile(b.file);
    setQuery(b.label);
    setComboOpen(false);
  }

  return (
    // overflow-visible so the snippet picker's dropdown isn't clipped by the
    // card's rounded-corner overflow-hidden.
    <Card className="mb-6 overflow-visible">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Container className="size-4" /> Cloud-init extras (admin)
            </CardTitle>
            <CardDescription>
              {extras.onDemand
                ? "ProxMate writes these cloud-init snippets automatically when a tenant deploys — there is nothing to place per node."
                : "Enables the cloud-init install checkboxes when tenants deploy a cloud image. Proxmox's API can't create snippet files, so each is a one-time manual step per node."}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Configure"}
          </Button>
        </div>
        <div className="mt-1">
          {extras.onDemand ? (
            <Badge variant="secondary">✓ automatic ({extras.storage})</Badge>
          ) : (
            <Badge variant={extras.snippetsEnabled ? "secondary" : "outline"}>
              {extras.snippetsEnabled ? "✓" : "○"} snippets enabled
            </Badge>
          )}
        </div>
      </CardHeader>
      {extras.onDemand && extras.base.length > 0 && (
        <CardContent className="text-sm text-muted-foreground">
          Every cloud-init VM also automatically gets:{" "}
          <span className="text-foreground">{extras.base.map((b) => b.label).join(", ")}</span>.
        </CardContent>
      )}
      {open && (
        <CardContent className="grid gap-4 text-sm">
          {/* Admin picks which options tenants see + which install on every VM. */}
          <div className="grid gap-3 rounded-md border p-3">
            <p className="text-sm font-medium">Options offered to tenants</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {extras.catalog.map((f) => (
                <label key={"off-" + f.id} className="flex items-start gap-2 text-xs" title={f.hint}>
                  <input
                    type="checkbox"
                    checked={offeredSel.has(f.id)}
                    onChange={(e) => toggle(setOfferedSel, f.id, e.target.checked)}
                    className="mt-0.5 size-3.5 accent-primary"
                  />
                  <span>{f.label}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-sm font-medium">
              Installed automatically on every VM{" "}
              {!extras.onDemand && (
                <span className="text-xs font-normal text-muted-foreground">(needs automatic mode)</span>
              )}
            </p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {extras.catalog.map((f) => (
                <label
                  key={"base-" + f.id}
                  className={"flex items-start gap-2 text-xs " + (extras.onDemand ? "" : "opacity-50")}
                  title={f.hint}
                >
                  <input
                    type="checkbox"
                    disabled={!extras.onDemand}
                    checked={baseSel.has(f.id)}
                    onChange={(e) => toggle(setBaseSel, f.id, e.target.checked)}
                    className="mt-0.5 size-3.5 accent-primary"
                  />
                  <span>{f.label}</span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={saving} onClick={saveSelection}>
                {saving ? <Loader2 className="animate-spin" /> : <Check />} Save selection
              </Button>
              {extras.onDemand && extras.recommendedBase.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setBaseSel(new Set(extras.recommendedBase))}>
                  Use recommended base
                </Button>
              )}
            </div>
          </div>

          {!extras.onDemand && (
            <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
              Prefer no manual steps? ProxMate can write these snippets itself. Mount a shared storage&apos;s{" "}
              <code>snippets/</code> directory into the backend container as <code>SNIPPET_DIR</code> and set{" "}
              <code>SNIPPET_STORAGE</code> to that storage id, then restart — this section switches to automatic. See the
              deployment docs.
            </div>
          )}
          {!extras.onDemand && !extras.snippetsEnabled && (
            <div>
              <p className="mb-2 text-muted-foreground">
                Enable the <code>snippets</code> content type on <code>{extras.storage}</code> (ProxMate does this via
                the API):
              </p>
              <Button size="sm" disabled={busy} onClick={enable}>
                {busy ? <Loader2 className="animate-spin" /> : <Check />} Enable snippets
              </Button>
            </div>
          )}
          <div className="grid gap-3">
            <p className="text-muted-foreground">
              {extras.onDemand
                ? "Browse a snippet to see or copy the exact cloud-init code ProxMate writes (it places these automatically — this is reference/override)."
                : "Pick an option to see its one-time setup command, then run it on each Proxmox node you want to offer it on."}
            </p>

            {/* Searchable snippet picker */}
            <div ref={comboRef} className="relative">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setComboOpen(true);
                    setSelectedFile(null);
                  }}
                  onFocus={() => setComboOpen(true)}
                  placeholder="Search snippets — e.g. Docker, Tailscale…"
                  className="pl-8 pr-8"
                  aria-label="Search cloud-init snippets"
                />
                <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
              {comboOpen && (
                <div className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-lg border bg-popover p-1 shadow-md ring-1 ring-foreground/10">
                  {filtered.length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                      No snippet matches &ldquo;{query}&rdquo;.
                    </p>
                  ) : (
                    filtered.map((b) => {
                      const ready = b.nodesReady.length > 0;
                      const active = selectedFile === b.file;
                      return (
                        <button
                          key={b.file}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectBundle(b);
                          }}
                          className={
                            "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent " +
                            (active ? "bg-accent" : "")
                          }
                        >
                          <span className="flex items-center gap-2">
                            {active ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                            {b.label}
                          </span>
                          {!extras.onDemand && (
                            <Badge variant={ready ? "secondary" : "outline"} className="text-[10px]">
                              {ready ? "✓ placed" : "○ not placed"}
                            </Badge>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            {/* Selected snippet's setup command */}
            {selectedBundle && (
              <div className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-medium">{selectedBundle.label}</span>
                  {!extras.onDemand && (
                    <Badge
                      variant={selectedBundle.nodesReady.length > 0 ? "secondary" : "outline"}
                      className="text-[10px]"
                    >
                      {selectedBundle.nodesReady.length > 0
                        ? `✓ ${selectedBundle.nodesReady.join(", ")}`
                        : "○ not placed"}
                    </Badge>
                  )}
                </div>
                <div className="relative">
                  <pre className="max-h-48 overflow-auto rounded-md border bg-muted/60 p-3 pr-16 text-xs">
                    {selectedBundle.command}
                  </pre>
                  <Button
                    size="sm"
                    variant="outline"
                    className="absolute right-2 top-2"
                    onClick={() => copy(selectedBundle.command)}
                  >
                    Copy
                  </Button>
                </div>
              </div>
            )}

            {!extras.onDemand && (
              <Button variant="ghost" size="sm" onClick={load}>
                <RefreshCw /> Re-check nodes
              </Button>
            )}
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
  const [elapsed, setElapsed] = useState(0); // seconds since the build started

  useEffect(() => {
    api
      .get<CuratedImage[]>("/templates/cloud-images")
      .then((r) => setImages(r.data))
      .catch(() => setImages([]));
  }, []);

  // Tick an elapsed counter while a build runs — drives the progress bar.
  useEffect(() => {
    if (!building) return;
    setElapsed(0);
    const iv = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [building]);

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
    // Curated images know their arch; for a custom URL the backend infers it
    // from the filename (…-arm64.img / …-amd64.qcow2).
    const arch = isCustom ? undefined : selected?.arch;
    if (!imageUrl || !name.trim()) {
      toast.error("Pick an image and give it a name.");
      return;
    }
    setBuilding(true);
    try {
      // The image download + import takes minutes, so allow a long timeout.
      await api.post("/templates/cloud-image", { name: name.trim(), imageUrl, os, arch }, { timeout: 20 * 60 * 1000 });
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
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">Downloading &amp; importing — this can take a few minutes.</span>
                <span className="tabular-nums">
                  {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-1000 ease-linear"
                  style={{ width: `${Math.min(95, Math.round((elapsed / 180) * 100))}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
