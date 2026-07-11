"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Plus, Rocket, HardDrive, KeyRound, Server, Container, ArchiveRestore } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { MeResponse, ProxmoxIso, LxcTemplate, Template, VirtualMachine, SshKey } from "@/lib/types";
import { formatRam } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";
import { TemplateIcon } from "@/components/template-icon";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const RAM_OPTIONS = [1, 2, 4, 8, 16, 32];
const CUSTOM = "custom";
const CONTAINER = "container"; // LXC container source
const RESTORE = "restore"; // restore an uploaded MateState backup
const CUSTOM_DISK_DEFAULT = 20;
const CONTAINER_DISK_DEFAULT = 8;

/** A downloaded MateState is a vzdump archive — same shape the backend enforces. */
const VZDUMP_FILE_RE = /^vzdump-(qemu|lxc)-\d+-[\w.-]+\.(vma|tar)(\.(zst|gz|lzo))?$/;

/** One-click "T-shirt" sizes that pre-fill cpu/ram/disk; disk is clamped up to a
 *  template's base. Tweak any field afterwards — these are just sensible starts. */
const SIZE_PRESETS = [
  { key: "s", label: "Small", cpu: 1, ramGb: 2, diskGb: 20 },
  { key: "m", label: "Medium", cpu: 2, ramGb: 4, diskGb: 40 },
  { key: "l", label: "Large", cpu: 4, ramGb: 8, diskGb: 80 },
  { key: "xl", label: "X-Large", cpu: 8, ramGb: 16, diskGb: 160 },
] as const;

/** Snippet filename for a feature combo — must mirror the backend (sorted, hyphen-joined). */
const cloudSnippetFile = (ids: string[]) => `proxmate-${[...ids].sort().join("-")}.yaml`;

/** Best-guess default cloud-init login user from a template's OS label. */
function cloudUserForOs(os: string | null): string {
  const s = (os ?? "").toLowerCase();
  if (s.includes("ubuntu")) return "ubuntu";
  if (s.includes("fedora")) return "fedora";
  if (s.includes("alma")) return "almalinux";
  if (s.includes("rocky")) return "rocky";
  if (s.includes("centos") || s.includes("oracle")) return "cloud-user";
  if (s.includes("arch")) return "arch";
  if (s.includes("suse")) return "opensuse";
  return "debian";
}

export default function NewVmWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  const [quota, setQuota] = useState<MeResponse["user"]["quota"] | null>(null);
  const [isos, setIsos] = useState<ProxmoxIso[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [lxcTemplates, setLxcTemplates] = useState<LxcTemplate[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // `source` is CUSTOM (install from ISO), CONTAINER (LXC from a template), or a
  // QEMU template id (clone + autoscale).
  const [source, setSource] = useState<string>(CUSTOM);
  const [name, setName] = useState("");
  const [cpu, setCpu] = useState(1);
  const [ramGb, setRamGb] = useState(2);
  const [storageGb, setStorageGb] = useState(CUSTOM_DISK_DEFAULT);
  const [os, setOs] = useState("");
  // LXC container deploys only:
  const [lxcTemplate, setLxcTemplate] = useState("");
  // Cloud-init template deploys only:
  const [sshKey, setSshKey] = useState("");
  const [savedKeys, setSavedKeys] = useState<SshKey[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [cloudFeatures, setCloudFeatures] = useState<{ id: string; label: string; hint: string }[]>([]);
  const [cloudNodes, setCloudNodes] = useState<Record<string, string[]>>({}); // node → present snippet files
  const [cloudBase, setCloudBase] = useState<{ id: string; label: string }[]>([]); // always-on base
  // On-demand snippet writing: ProxMate writes the combo at deploy, so every offered
  // feature is deployable on any node — the per-node "is the snippet placed?" gate
  // only applies to the manual fallback.
  const [cloudOnDemand, setCloudOnDemand] = useState(false);
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);
  // Restore-from-upload only:
  const [restoreEnabled, setRestoreEnabled] = useState(false);
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // Admin-only deploy options: deploy INTO a tenant's account (optionally without
  // counting toward their quota) and/or pin the target node. "self"/"auto" =
  // the normal behavior every tenant gets.
  const SELF = "self";
  const AUTO_NODE = "auto";
  const [adminUsers, setAdminUsers] = useState<{ id: string; email: string; displayName: string }[]>([]);
  const [adminNodes, setAdminNodes] = useState<string[]>([]);
  const [forUserId, setForUserId] = useState<string>(SELF);
  const [countQuota, setCountQuota] = useState(true);
  const [nodeChoice, setNodeChoice] = useState<string>(AUTO_NODE);

  const meId = useAuthStore((s) => s.user?.id);
  useEffect(() => {
    if (!isAdmin) return;
    // Both are conveniences — never block the wizard if they fail.
    api
      .get<{ id: string; email: string; displayName: string }[]>("/admin/all-vms")
      .then((r) => setAdminUsers(r.data.filter((u) => u.id !== meId)))
      .catch(() => setAdminUsers([]));
    api
      .get<{ nodes: { name: string; online: boolean }[] }>("/admin/nodes")
      .then((r) => setAdminNodes(r.data.nodes.filter((n) => n.online).map((n) => n.name)))
      .catch(() => setAdminNodes([]));
  }, [isAdmin, meId]);

  useEffect(() => {
    Promise.all([
      api.get<MeResponse>("/auth/me"),
      api.get<ProxmoxIso[]>("/proxmox/isos"),
      api.get<Template[]>("/templates"),
      // Cloud-init "extras" (Docker/Tailscale) availability — never block the wizard.
      api
        .get<{
          features: { id: string; label: string; hint: string }[];
          nodes: Record<string, string[]>;
          base?: { id: string; label: string }[];
          onDemand?: boolean;
        }>("/templates/cloud-init-status")
        .catch(() => ({ data: { features: [], nodes: {}, base: [], onDemand: false } })),
      // Saved SSH keys — offered as quick-pick for cloud-init deploys. Never block.
      api.get<SshKey[]>("/ssh-keys").catch(() => ({ data: [] as SshKey[] })),
      // LXC OS templates (vztmpl) available on the cluster. Never block the wizard.
      api.get<LxcTemplate[]>("/vms/lxc-templates").catch(() => ({ data: [] as LxcTemplate[] })),
      // Whether restore-from-upload is available (backup share mounted rw). Never block.
      api.get<{ enabled: boolean }>("/vms/restore-capability").catch(() => ({ data: { enabled: false } })),
    ])
      .then(([meRes, isosRes, tplRes, extrasRes, keysRes, lxcRes, restoreRes]) => {
        setQuota(meRes.data.user.quota);
        setIsos(isosRes.data);
        setTemplates(tplRes.data);
        setCloudFeatures(extrasRes.data.features ?? []);
        setCloudNodes(extrasRes.data.nodes ?? {});
        setCloudBase(extrasRes.data.base ?? []);
        setCloudOnDemand(extrasRes.data.onDemand === true);
        setSavedKeys(keysRes.data ?? []);
        setLxcTemplates(lxcRes.data ?? []);
        setRestoreEnabled(restoreRes.data.enabled === true);

        // Deep-link preselect: /vms/new?template=<id> (e.g. the store's Deploy button).
        const wanted = searchParams.get("template");
        const preselected = wanted ? tplRes.data.find((t) => t.id === wanted) : undefined;
        if (preselected) {
          setSource(preselected.id);
          setStorageGb(Math.max(preselected.diskGb, 1));
          if (preselected.cloudInit) setUsername(cloudUserForOs(preselected.os));
        }
      })
      .catch((err) => setLoadError(apiError(err)))
      .finally(() => setLoading(false));
  }, [searchParams]);

  const isContainer = source === CONTAINER;
  const isRestore = source === RESTORE;
  const template =
    source === CUSTOM || isContainer || isRestore ? null : templates.find((t) => t.id === source) ?? null;
  const isCustom = source === CUSTOM;
  const isCloud = !!template?.cloudInit;
  const nodeSnippets = isCloud && template ? cloudNodes[template.proxmoxNode] ?? [] : [];
  // On-demand: every offered feature is deployable (ProxMate writes the combo at
  // deploy). Manual fallback: only features whose snippet is placed on this node.
  const availableFeatures = !isCloud
    ? []
    : cloudOnDemand
      ? cloudFeatures
      : cloudFeatures.filter((f) => nodeSnippets.includes(cloudSnippetFile([f.id])));
  // A combo deploy needs the combined snippet present too — but only in manual mode;
  // on-demand writes whatever combo is selected.
  const bundleReady =
    cloudOnDemand || selectedFeatures.length === 0 || nodeSnippets.includes(cloudSnippetFile(selectedFeatures));
  const minDisk = template?.diskGb ?? 1;

  // Which preset (if any) the current cpu/ram/disk match, so its chip highlights.
  const activePreset = SIZE_PRESETS.find(
    (p) => p.cpu === cpu && p.ramGb === ramGb && storageGb === Math.max(p.diskGb, minDisk),
  )?.key;

  function applyPreset(p: (typeof SIZE_PRESETS)[number]) {
    setCpu(p.cpu);
    setRamGb(p.ramGb);
    setStorageGb(Math.max(p.diskGb, minDisk));
    setErrors({});
  }

  const cpuLeft = quota ? quota.cpu.max - quota.cpu.used : 0;
  const ramLeftMb = quota ? quota.ram.max - quota.ram.used : 0;
  const storageLeft = quota ? quota.storage.max - quota.storage.used : 0;

  // A preset is selectable only if the user's *remaining* quota can fit it (admins
  // are bounded by cluster capacity, not quota). Over-quota presets are disabled.
  const presetFits = (p: (typeof SIZE_PRESETS)[number]) => {
    if (isAdmin) return true;
    return (
      p.cpu <= cpuLeft &&
      p.ramGb * 1024 <= ramLeftMb &&
      Math.max(p.diskGb, minDisk) <= storageLeft
    );
  };

  function onSourceChange(v: string) {
    setSource(v);
    setErrors({});
    setSelectedFeatures([]);
    if (v === CUSTOM) {
      setStorageGb(CUSTOM_DISK_DEFAULT);
    } else if (v === CONTAINER || v === RESTORE) {
      setStorageGb(CONTAINER_DISK_DEFAULT);
    } else {
      const t = templates.find((x) => x.id === v);
      setStorageGb(t ? Math.max(t.diskGb, 1) : CUSTOM_DISK_DEFAULT);
      if (t?.cloudInit) setUsername((u) => u || cloudUserForOs(t.os));
    }
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!/^[a-zA-Z0-9-]+$/.test(name)) e.name = "Use letters, numbers and hyphens only";
    if (isRestore) {
      // Sizing comes from inside the backup (quota is enforced server-side from
      // the archive's embedded config), so only the name + file matter here.
      if (!backupFile) e.backupFile = "Choose your downloaded MateState backup file";
      else if (!VZDUMP_FILE_RE.test(backupFile.name))
        e.backupFile = "That doesn't look like a MateState backup (expected vzdump-…-….vma.zst / .tar.zst)";
      setErrors(e);
      return Object.keys(e).length === 0;
    }
    if (cpu < 1) e.cpu = "At least 1 vCPU";
    else if (!isAdmin && cpu > cpuLeft) e.cpu = `Exceeds your remaining ${cpuLeft} vCPU`;
    if (!isAdmin && ramGb * 1024 > ramLeftMb) e.ram = `Exceeds your remaining ${formatRam(ramLeftMb)}`;
    if (storageGb < minDisk)
      e.storage = template ? `Template needs at least ${minDisk} GB` : "At least 1 GB";
    else if (!isAdmin && storageGb > storageLeft) e.storage = `Exceeds your remaining ${storageLeft} GB`;
    if (isCustom && !os) e.os = "Select an installation ISO";
    if (isContainer) {
      if (!lxcTemplate) e.lxcTemplate = "Select a container template";
      if (!sshKey.trim() && !password) e.sshKey = "Add an SSH public key (or set a root password below)";
      else if (sshKey.trim() && !/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)/.test(sshKey.trim()))
        e.sshKey = "That doesn't look like an OpenSSH public key";
      if (password && password.length < 5) e.password = "Use at least 5 characters";
    }
    if (isCloud) {
      if (!sshKey.trim() && !password) e.sshKey = "Add an SSH public key (or set a password below)";
      else if (sshKey.trim() && !/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)/.test(sshKey.trim()))
        e.sshKey = "That doesn't look like an OpenSSH public key";
      if (username && !/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) e.username = "Lowercase letters, digits, _ and -";
      if (selectedFeatures.length > 0 && !bundleReady)
        e.features = "This combination isn't set up on the template's node — ask an admin to add its snippet.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  /** The admin-only create options actually selected (empty for tenants/defaults). */
  function adminOpts(allowNode: boolean): { forUserId?: string; quotaExempt?: boolean; node?: string } {
    if (!isAdmin) return {};
    const forTenant = forUserId !== SELF;
    return {
      ...(forTenant ? { forUserId } : {}),
      // The checkbox only matters when deploying for a tenant (admins bypass quota).
      ...(forTenant && !countQuota ? { quotaExempt: true } : {}),
      ...(allowNode && nodeChoice !== AUTO_NODE ? { node: nodeChoice } : {}),
    };
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      if (isRestore) {
        const form = new FormData();
        form.append("name", name);
        form.append("file", backupFile!);
        const res = await api.post<{ vm: VirtualMachine }>("/vms/restore-upload", form, {
          onUploadProgress: (p) => {
            if (p.total) setUploadPct(Math.round((p.loaded / p.total) * 100));
          },
        });
        setUploadPct(null);
        toast.success(`"${name}" is being restored from your backup.`);
        router.push(`/vms/${res.data.vm.id}`);
      } else if (isCustom) {
        const res = await api.post<{ vm: VirtualMachine }>("/vms", {
          name,
          cpu,
          ram: ramGb * 1024,
          storage: storageGb,
          os,
          // Tenants never send a node — the backend auto-schedules. Admins may
          // pin one (or deploy for a tenant) via the admin options below.
          ...adminOpts(true),
        });
        toast.success(`VM "${name}" is being created.`);
        router.push(`/vms/${res.data.vm.id}`);
      } else if (isContainer) {
        const res = await api.post<{ vm: VirtualMachine }>("/vms/containers", {
          name,
          cpu,
          ram: ramGb * 1024,
          storage: storageGb,
          template: lxcTemplate,
          sshKey: sshKey.trim() || undefined,
          password: password || undefined,
          ...adminOpts(true),
        });
        toast.success(`Container "${name}" is being created.`);
        router.push(`/vms/${res.data.vm.id}`);
      } else {
        const res = await api.post<{ vm: VirtualMachine }>("/templates/deploy", {
          templateId: source,
          name,
          cpu,
          ram: ramGb * 1024,
          storage: storageGb,
          ...(isCloud
            ? {
                sshKey: sshKey.trim() || undefined,
                username: username || undefined,
                password: password || undefined,
                features: selectedFeatures.length ? selectedFeatures : undefined,
              }
            : {}),
          // Template clones stay on the template's node — no node option here.
          ...adminOpts(false),
        });
        toast.success(`Deploying "${name}" from ${template?.name}.`);
        router.push(`/vms/${res.data.vm.id}`);
      }
    } catch (err) {
      toast.error(apiError(err));
      setUploadPct(null);
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
                      : isContainer
                        ? "A lightweight Linux container (LXC) from an OS template — boots in seconds."
                        : isRestore
                          ? "Rebuild a machine from a MateState backup you downloaded — perfect for migrating between clusters or ProxMate instances."
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
                      <SelectItem value={CONTAINER}>
                        <span className="flex items-center gap-2">
                          <Container className="size-3.5" /> Container (LXC)
                        </span>
                      </SelectItem>
                      {templates.length > 0 && (
                        <SelectGroup>
                          <SelectSeparator />
                          <SelectLabel>Template Store</SelectLabel>
                          {templates.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              <span className="flex items-center gap-2">
                                <TemplateIcon os={t.os} name={t.name} icon={t.icon} className="size-3.5" /> {t.name}
                                <span className="text-muted-foreground">· {t.diskGb} GB</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                      {restoreEnabled && (
                        <SelectGroup>
                          <SelectSeparator />
                          <SelectItem value={RESTORE}>
                            <span className="flex items-center gap-2">
                              <ArchiveRestore className="size-3.5" /> Restore from old build
                              <span className="text-muted-foreground">· upload your MateState backup</span>
                            </span>
                          </SelectItem>
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                </FormField>

                {template?.notes && (
                  <div className="rounded-md bg-muted/60 p-3 text-xs">
                    <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                      <KeyRound className="size-3.5" /> Login &amp; notes for {template.name}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-muted-foreground">{template.notes}</p>
                  </div>
                )}

                {/* Admin-only deploy options — tenants never see these (and the API
                    rejects them from non-admins). Restore-uploads don't support them. */}
                {isAdmin && !isRestore && (
                  <div className="grid gap-3 rounded-md border bg-muted/40 p-3">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <Rocket className="size-3.5" /> Admin options
                    </div>
                    <FormField
                      label="Deploy for"
                      hint={forUserId === SELF ? "Your own VM (admin account)." : "The VM lands in this tenant's account — they own it."}
                    >
                      <Select value={forUserId} onValueChange={(v) => setForUserId(v as string)}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={SELF}>Myself (admin)</SelectItem>
                          {adminUsers.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                              {u.displayName} <span className="text-muted-foreground">· {u.email}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                    {forUserId !== SELF && (
                      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border bg-background p-3">
                        <input
                          type="checkbox"
                          checked={countQuota}
                          onChange={(e) => setCountQuota(e.target.checked)}
                          className="mt-0.5 size-4 accent-primary"
                        />
                        <span className="text-sm">
                          <span className="font-medium">Count against their quota</span>
                          <span className="block text-xs text-muted-foreground">
                            Unchecked = a grant on top of their quota: this VM never consumes it, even
                            when resized.
                          </span>
                        </span>
                      </label>
                    )}
                    {(isCustom || isContainer) ? (
                      <FormField
                        label="Node"
                        hint="Auto-select places it on the best-capacity eligible node."
                      >
                        <Select value={nodeChoice} onValueChange={(v) => setNodeChoice(v as string)}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={AUTO_NODE}>Auto-select (recommended)</SelectItem>
                            {adminNodes.map((n) => (
                              <SelectItem key={n} value={n}>
                                <span className="flex items-center gap-2">
                                  <Server className="size-3.5" /> {n}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormField>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Template deploys stay on the template&apos;s node (linked clone) — no node
                        choice here.
                      </p>
                    )}
                  </div>
                )}

                <FormField label="Name" htmlFor="name" error={errors.name} hint="e.g. web-server-01">
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </FormField>

                {!isRestore && (
                <>
                <FormField label="Size" hint="A quick start — fine-tune any field below.">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {SIZE_PRESETS.map((p) => {
                      const fits = presetFits(p);
                      return (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() => applyPreset(p)}
                          disabled={!fits}
                          aria-pressed={activePreset === p.key}
                          title={fits ? undefined : "Exceeds your remaining quota"}
                          className={
                            "rounded-lg border p-2.5 text-left transition-colors " +
                            (!fits
                              ? "cursor-not-allowed opacity-40"
                              : activePreset === p.key
                                ? "border-primary bg-primary/10"
                                : "hover:border-primary/50 hover:bg-muted")
                          }
                        >
                          <div className="text-sm font-medium">{p.label}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {p.cpu} vCPU · {p.ramGb} GB
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {Math.max(p.diskGb, minDisk)} GB disk
                          </div>
                        </button>
                      );
                    })}
                  </div>
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
                </>
                )}

                {isRestore && (
                  <>
                    <FormField
                      label="MateState backup file"
                      htmlFor="backup-file"
                      error={errors.backupFile}
                      hint="The vzdump archive from your MateState download email (.vma.zst for VMs, .tar.zst for containers)."
                    >
                      <Input
                        id="backup-file"
                        type="file"
                        accept=".zst,.gz,.lzo,.vma,.tar"
                        onChange={(e) => {
                          setBackupFile(e.target.files?.[0] ?? null);
                          setErrors({});
                        }}
                        className="cursor-pointer file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1 file:text-xs file:font-medium"
                      />
                    </FormField>

                    {uploadPct !== null && (
                      <div>
                        <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                          <span>Uploading backup…</span>
                          <span>{uploadPct}%</span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${uploadPct}%` }}
                          />
                        </div>
                        {uploadPct === 100 && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Upload complete — restoring on the cluster (this can take a few minutes)…
                          </p>
                        )}
                      </div>
                    )}

                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Server className="size-3.5" />
                      The machine keeps the CPU, memory and disk sizes stored inside the backup (they
                      count against your quota), gets a fresh network identity, and is placed on the
                      best node automatically.
                    </p>
                  </>
                )}

                {isCloud && (
                  <>
                    <FormField
                      label="SSH public key"
                      htmlFor="sshkey"
                      error={errors.sshKey}
                      hint="Injected on first boot so you can SSH in right away — paste the output of `cat ~/.ssh/id_ed25519.pub`."
                    >
                      {savedKeys.length > 0 && (
                        <div className="mb-2 flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">Use a saved key:</span>
                          {savedKeys.map((k) => (
                            <button
                              key={k.id}
                              type="button"
                              onClick={() => setSshKey(k.publicKey)}
                              className={
                                "rounded-full border px-2.5 py-0.5 text-xs transition-colors " +
                                (sshKey === k.publicKey
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "hover:bg-muted")
                              }
                            >
                              {k.name}
                            </button>
                          ))}
                        </div>
                      )}
                      <textarea
                        id="sshkey"
                        value={sshKey}
                        onChange={(e) => setSshKey(e.target.value)}
                        placeholder="ssh-ed25519 AAAA… you@laptop"
                        className="h-20 w-full resize-none rounded-md border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Save keys for reuse in{" "}
                        <Link href="/security" className="text-primary underline-offset-4 hover:underline">
                          Security → SSH keys
                        </Link>
                        .
                      </p>
                    </FormField>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <FormField label="Username" htmlFor="ciuser" error={errors.username} hint="The login user to create.">
                        <Input
                          id="ciuser"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          placeholder="debian"
                        />
                      </FormField>
                      <FormField label="Password (optional)" htmlFor="cipassword" hint="SSH key is recommended.">
                        <Input
                          id="cipassword"
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                      </FormField>
                    </div>
                    {availableFeatures.length > 0 && (
                      <div className="grid gap-2">
                        {availableFeatures.map((f) => {
                          const checked = selectedFeatures.includes(f.id);
                          return (
                            <label
                              key={f.id}
                              className="flex cursor-pointer items-start gap-2.5 rounded-md border bg-muted/40 p-3"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) =>
                                  setSelectedFeatures((s) =>
                                    e.target.checked ? [...s, f.id] : s.filter((x) => x !== f.id),
                                  )
                                }
                                className="mt-0.5 size-4 accent-primary"
                              />
                              <span className="text-sm">
                                <span className="flex items-center gap-1.5 font-medium">
                                  <Container className="size-3.5" /> {f.label}
                                </span>
                                <span className="text-xs text-muted-foreground">{f.hint}</span>
                              </span>
                            </label>
                          );
                        })}
                        {errors.features && <p className="text-xs text-destructive">{errors.features}</p>}
                      </div>
                    )}
                    {cloudBase.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Also installed on every VM: {cloudBase.map((b) => b.label).join(", ")}.
                      </p>
                    )}
                  </>
                )}

                {isContainer && (
                  <>
                    <FormField label="Container template" error={errors.lxcTemplate}>
                      <Select
                        value={lxcTemplate}
                        onValueChange={(v) => {
                          setLxcTemplate(v as string);
                          setErrors({});
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue
                            placeholder={lxcTemplates.length ? "Select a template" : "No container templates available"}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {lxcTemplates.map((t) => (
                            <SelectItem key={t.volid} value={t.volid}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>

                    <FormField
                      label="SSH public key"
                      htmlFor="ct-sshkey"
                      error={errors.sshKey}
                      hint="Added to the container's root authorized_keys so you can SSH in — or set a root password below."
                    >
                      {savedKeys.length > 0 && (
                        <div className="mb-2 flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">Use a saved key:</span>
                          {savedKeys.map((k) => (
                            <button
                              key={k.id}
                              type="button"
                              onClick={() => setSshKey(k.publicKey)}
                              className={
                                "rounded-full border px-2.5 py-0.5 text-xs transition-colors " +
                                (sshKey === k.publicKey
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "hover:bg-muted")
                              }
                            >
                              {k.name}
                            </button>
                          ))}
                        </div>
                      )}
                      <textarea
                        id="ct-sshkey"
                        value={sshKey}
                        onChange={(e) => setSshKey(e.target.value)}
                        placeholder="ssh-ed25519 AAAA… you@laptop"
                        className="h-20 w-full resize-none rounded-md border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                      />
                    </FormField>

                    <FormField
                      label="Root password (optional)"
                      htmlFor="ct-password"
                      error={errors.password}
                      hint="SSH key is recommended. At least 5 characters if set."
                    >
                      <Input
                        id="ct-password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </FormField>

                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Server className="size-3.5" />
                      ProxMate places the container on a node that has this template, with the most free
                      capacity.
                    </p>
                  </>
                )}

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

                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Server className="size-3.5" />
                      ProxMate automatically places your VM on a node that has this ISO, with the most
                      free capacity.
                    </p>
                  </>
                )}

                {!isCustom && !isContainer && !isRestore && (
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
                  ) : isContainer ? (
                    <Container />
                  ) : isRestore ? (
                    <ArchiveRestore />
                  ) : (
                    <Rocket />
                  )}
                  {isCustom
                    ? "Create VM"
                    : isContainer
                      ? "Create container"
                      : isRestore
                        ? uploadPct !== null
                          ? "Restoring…"
                          : "Upload & restore"
                        : "Deploy"}
                </Button>
              </form>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
