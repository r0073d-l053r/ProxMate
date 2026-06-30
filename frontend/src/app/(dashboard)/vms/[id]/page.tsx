"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Play,
  Square,
  RotateCw,
  Trash2,
  Terminal,
  SquareTerminal,
  Loader2,
  Cpu,
  MemoryStick,
  HardDrive,
  Server,
  Disc,
  Network,
  Hash,
  Lightbulb,
  Package,
  StickyNote,
  Check,
  History,
  RefreshCw,
  LineChart,
  Pencil,
  Scaling,
  RotateCcw,
  AlertTriangle,
  Tag,
  X,
} from "lucide-react";
import { api, apiError } from "@/lib/api";
import type {
  VmDetail,
  VmActivityEntry,
  VmMetrics,
  RrdTimeframe,
  MeResponse,
  Quota,
  ProxmoxIso,
  Template,
  SshKey,
} from "@/lib/types";
import { formatRam, formatBytes, formatUptime, formatDate, formatRelative } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { Sparkline } from "@/components/dashboard/sparkline";
import { VmStatusBadge } from "@/components/vm/vm-status-badge";
import { MateStatesPanel } from "@/components/vm/matestates-panel";
import { SnapshotsPanel } from "@/components/vm/snapshots-panel";
import { PowerSchedulePanel } from "@/components/vm/power-schedule-panel";
import { BackupPolicyPanel } from "@/components/vm/backup-policy-panel";
import { SharePanel } from "@/components/vm/share-panel";
import { DisksPanel } from "@/components/vm/disks-panel";
import { MigrateDialog } from "@/components/vm/migrate-dialog";
import { useAuthStore } from "@/lib/auth-store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/** Client-side optimistic state while a power action is in flight. */
type Transition = "starting" | "stopping" | "restarting" | null;

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" />
        {label}
      </span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

/**
 * Editable free-text notes for a VM ("staging — don't touch", "Minecraft server").
 * Self-contained: keeps its own draft so the detail page's 2.5 s status poll never
 * clobbers an in-progress edit. The Save button only enables once the draft differs
 * from what's stored (max 500 chars, mirrored by the backend).
 */
function NotesCard({
  vmId,
  initial,
  onSaved,
}: {
  vmId: string;
  initial: string | null;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = value !== (initial ?? "");

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/vms/${vmId}`, { description: value });
      toast.success("Notes saved.");
      onSaved();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <StickyNote className="size-4 text-muted-foreground" />
          Notes
        </CardTitle>
      </CardHeader>
      <CardContent>
        <textarea
          value={value}
          maxLength={500}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Add a note for this VM — e.g. what it runs, who it's for, or 'staging — don't touch'."
          className="h-24 w-full resize-none rounded-md border bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground tabular-nums">{value.length}/500</span>
          <div className="flex gap-2">
            {dirty && (
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setValue(initial ?? "")}>
                Reset
              </Button>
            )}
            <Button size="sm" disabled={saving || !dirty} onClick={save}>
              {saving ? <Loader2 className="animate-spin" /> : <Check />} Save
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Editable tags for grouping/filtering a VM. Adds/removes persist immediately via
 * PATCH (tags are sent as an array; the backend normalizes + stores them).
 */
function TagsCard({ vmId, initial, onSaved }: { vmId: string; initial: string | null; onSaved: () => void }) {
  const [tags, setTags] = useState<string[]>(() =>
    (initial ?? "").split(",").map((t) => t.trim()).filter(Boolean),
  );
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function persist(next: string[]) {
    setSaving(true);
    try {
      await api.patch(`/vms/${vmId}`, { tags: next });
      setTags(next);
      onSaved();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  function add() {
    const t = draft.trim().toLowerCase();
    if (!t) return;
    if (!/^[a-z0-9][a-z0-9 _-]{0,30}$/.test(t)) {
      toast.error("Letters, numbers, space, _ and - only.");
      return;
    }
    if (tags.includes(t)) { setDraft(""); return; }
    setDraft("");
    void persist([...tags, t]);
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Tag className="size-4 text-muted-foreground" />
          Tags
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((t) => (
            <span key={t} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
              {t}
              <button
                type="button"
                aria-label={`Remove ${t}`}
                disabled={saving}
                onClick={() => persist(tags.filter((x) => x !== t))}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {tags.length === 0 && <span className="text-sm text-muted-foreground">No tags yet.</span>}
        </div>
        <div className="mt-3 flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); add(); }
            }}
            placeholder="Add a tag — e.g. prod, web, team-a"
            maxLength={31}
            className="max-w-xs"
          />
          <Button size="sm" variant="outline" onClick={add} disabled={saving || !draft.trim()}>
            {saving ? <Loader2 className="animate-spin" /> : <Tag />} Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const TIMEFRAMES: { key: RrdTimeframe; label: string }[] = [
  { key: "hour", label: "Hour" },
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
];

/** A small metric block: label, current + peak %, and a history sparkline. */
function MetricRow({
  label,
  series,
  color,
}: {
  label: string;
  series: number[];
  color: string;
}) {
  const now = series.length ? series[series.length - 1]! : 0;
  const peak = series.length ? Math.max(...series) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          now {now.toFixed(0)}% · peak {peak.toFixed(0)}%
        </span>
      </div>
      <Sparkline data={series} max={100} className={`h-16 w-full ${color}`} />
    </div>
  );
}

/**
 * Historical CPU + memory for this VM, read from Proxmox's RRD store
 * (`GET /vms/:id/metrics`). Tenants couldn't see their own VM's trends before —
 * only the admin monitor did. Hour/Day/Week timeframes; Proxmox builds the
 * longer rollups over time, so a fresh VM starts mostly flat.
 */
function MetricsCard({ vmId }: { vmId: string }) {
  const [timeframe, setTimeframe] = useState<RrdTimeframe>("hour");
  const [metrics, setMetrics] = useState<VmMetrics | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(
    async (tf: RrdTimeframe) => {
      setMetrics(null);
      setError(false);
      try {
        const res = await api.get<VmMetrics>(`/vms/${vmId}/metrics`, { params: { timeframe: tf } });
        setMetrics(res.data);
      } catch {
        setError(true);
      }
    },
    [vmId],
  );

  useEffect(() => {
    load(timeframe);
  }, [load, timeframe]);

  const points = metrics?.points ?? [];
  const cpu = points.map((p) => (p.cpu ?? 0) * 100);
  const mem = points.map((p) => (p.maxmem ? ((p.mem ?? 0) / p.maxmem) * 100 : 0));
  const hasData = cpu.some((v) => v > 0) || mem.some((v) => v > 0);

  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          <LineChart className="size-4 text-muted-foreground" />
          Resource history
        </CardTitle>
        <div className="flex gap-1 rounded-md border p-0.5" role="tablist">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              type="button"
              role="tab"
              aria-selected={timeframe === tf.key}
              onClick={() => setTimeframe(tf.key)}
              className={
                "rounded px-2 py-0.5 text-xs transition-colors " +
                (timeframe === tf.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {tf.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Couldn&apos;t load metrics — the VM may be unreachable on Proxmox.
          </p>
        ) : metrics === null ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
        ) : !hasData ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No history for this window yet — Proxmox builds it up while the VM runs.
          </p>
        ) : (
          <div className="grid gap-4">
            <MetricRow label="CPU" series={cpu} color="text-sky-500" />
            <MetricRow label="Memory" series={mem} color="text-violet-500" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Map a raw audit action to a friendly label + a dot color for the timeline. */
const ACTIVITY_META: Record<string, { label: string; dot: string }> = {
  "vm.create": { label: "Created", dot: "bg-emerald-500" },
  "vm.start": { label: "Started", dot: "bg-emerald-500" },
  "vm.stop": { label: "Stopped", dot: "bg-amber-500" },
  "vm.stop_force": { label: "Force-stopped", dot: "bg-red-500" },
  "vm.restart": { label: "Restarted", dot: "bg-sky-500" },
  "vm.update": { label: "Notes updated", dot: "bg-muted-foreground" },
  "vm.resize": { label: "Resized", dot: "bg-sky-500" },
  "vm.rebuild": { label: "Rebuilt", dot: "bg-amber-500" },
  "vm.delete": { label: "Deleted", dot: "bg-red-500" },
  "snapshot.create": { label: "Snapshot taken", dot: "bg-sky-500" },
  "snapshot.rollback": { label: "Rolled back to snapshot", dot: "bg-amber-500" },
  "snapshot.delete": { label: "Snapshot deleted", dot: "bg-muted-foreground" },
  "vm.schedule": { label: "Schedule updated", dot: "bg-muted-foreground" },
  "vm.backup_policy": { label: "Backup policy updated", dot: "bg-muted-foreground" },
};

/**
 * A compact, owner-visible timeline of this VM's recent lifecycle events, read
 * from the audit log (`GET /vms/:id/activity`). Refreshes on demand; the actor
 * email is shown so you can tell whether you or an admin acted.
 */
function ActivityCard({ vmId }: { vmId: string }) {
  const [items, setItems] = useState<VmActivityEntry[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<VmActivityEntry[]>(`/vms/${vmId}/activity`);
      setItems(res.data);
    } catch {
      setItems([]);
    }
  }, [vmId]);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          <History className="size-4 text-muted-foreground" />
          Activity
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing} title="Refresh">
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
        </Button>
      </CardHeader>
      <CardContent>
        {items === null ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <ul className="space-y-3">
            {items.map((e) => {
              const meta = ACTIVITY_META[e.action] ?? { label: e.action, dot: "bg-muted-foreground" };
              return (
                <li key={e.id} className="flex items-start gap-3 text-sm">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${meta.dot}`} />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{meta.label}</span>
                    {e.actorEmail && (
                      <span className="text-muted-foreground"> · {e.actorEmail}</span>
                    )}
                  </div>
                  <span
                    className="shrink-0 text-xs text-muted-foreground tabular-nums"
                    title={formatDate(e.createdAt)}
                  >
                    {formatRelative(e.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

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
 */
function ResizeDialog({
  vm,
  isAdmin,
  disabled,
  onResized,
}: {
  vm: VmDetail;
  isAdmin: boolean;
  disabled: boolean;
  onResized: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [cpu, setCpu] = useState(vm.cpu);
  const [ramGb, setRamGb] = useState(Math.round(vm.ram / 1024));
  const [storageGb, setStorageGb] = useState(vm.storage);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // On open, reset the form to the VM's current size and (re)load the quota so the
  // ceilings reflect the user's other VMs.
  useEffect(() => {
    if (!open) return;
    setCpu(vm.cpu);
    setRamGb(Math.round(vm.ram / 1024));
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
  const ramMaxGb = !isAdmin && quota ? Math.floor((quota.ram.max - quota.ram.used + vm.ram) / 1024) : Infinity;
  const storageMax = !isAdmin && quota ? quota.storage.max - quota.storage.used + vm.storage : Infinity;

  const ramMb = ramGb * 1024;
  const changed = cpu !== vm.cpu || ramMb !== vm.ram || storageGb !== vm.storage;
  const activePreset = SIZE_PRESETS.find((p) => p.cpu === cpu && p.ramGb === ramGb && p.diskGb === storageGb)?.key;

  function validate(): string | null {
    if (cpu < 1) return "At least 1 vCPU.";
    if (cpu > cpuMax) return `Exceeds your remaining quota — up to ${cpuMax} vCPU.`;
    if (ramGb < 1) return "At least 1 GB of memory.";
    if (ramGb > ramMaxGb) return `Exceeds your remaining quota — up to ${ramMaxGb} GB memory.`;
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
      setOpen(false);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  const num = (v: string, min: number) => Math.max(min, Math.floor(Number(v) || 0));

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button variant="outline" disabled={disabled}>
            <Scaling />
            Resize
          </Button>
        }
      />
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
                  setRamGb(p.ramGb);
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
            <Input
              id="rs-cpu"
              type="number"
              min={1}
              value={cpu}
              onChange={(e) => { setCpu(num(e.target.value, 1)); setError(null); }}
            />
          </FormField>
          <FormField label="Memory (GB)" htmlFor="rs-ram">
            <Input
              id="rs-ram"
              type="number"
              min={1}
              value={ramGb}
              onChange={(e) => { setRamGb(num(e.target.value, 1)); setError(null); }}
            />
          </FormField>
          <FormField label="Disk (GB)" htmlFor="rs-disk">
            <Input
              id="rs-disk"
              type="number"
              min={vm.storage}
              value={storageGb}
              onChange={(e) => { setStorageGb(num(e.target.value, vm.storage)); setError(null); }}
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

/**
 * Re-image a VM in place from a fresh ISO or a template / cloud image. Destructive:
 * the current disk is wiped, but the VM keeps its id, VMID, name, and resources.
 * Cloud-init login details are re-supplied here (they're never stored). Source values
 * are encoded as `iso::<filename>` or `tpl::<id>` so one Select can list both.
 */
function RebuildDialog({
  vm,
  disabled,
  onRebuilt,
}: {
  vm: VmDetail;
  disabled: boolean;
  onRebuilt: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [isos, setIsos] = useState<ProxmoxIso[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [savedKeys, setSavedKeys] = useState<SshKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string>("");
  const [sshKey, setSshKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSource("");
    setSshKey("");
    setUsername("");
    setPassword("");
    setConfirmed(false);
    setError(null);
    setLoading(true);
    Promise.all([
      api.get<ProxmoxIso[]>("/proxmox/isos").catch(() => ({ data: [] as ProxmoxIso[] })),
      api.get<Template[]>("/templates").catch(() => ({ data: [] as Template[] })),
      api.get<SshKey[]>("/ssh-keys").catch(() => ({ data: [] as SshKey[] })),
    ])
      .then(([isoRes, tplRes, keyRes]) => {
        setIsos(isoRes.data);
        setTemplates(tplRes.data);
        setSavedKeys(keyRes.data);
      })
      .finally(() => setLoading(false));
  }, [open]);

  const isTemplate = source.startsWith("tpl::");
  const template = isTemplate ? templates.find((t) => t.id === source.slice(5)) : undefined;
  const needsCloudInit = !!template?.cloudInit;

  function validate(): string | null {
    if (!source) return "Pick an image to rebuild from.";
    if (needsCloudInit && !sshKey.trim() && !password) return "Add an SSH public key or a password to log in.";
    if (sshKey.trim() && !/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)/.test(sshKey.trim()))
      return "That doesn't look like an OpenSSH public key.";
    if (!confirmed) return "Tick the box to confirm — this erases the current disk.";
    return null;
  }

  async function submit() {
    const v = validate();
    if (v) { setError(v); return; }
    setSaving(true);
    try {
      const body = isTemplate
        ? {
            templateId: source.slice(5),
            ...(sshKey.trim() ? { sshKey: sshKey.trim() } : {}),
            ...(username.trim() ? { username: username.trim() } : {}),
            ...(password ? { password } : {}),
          }
        : { os: source.slice(5) };
      await api.post(`/vms/${vm.id}/rebuild`, body);
      toast.success("VM rebuilt — it's been re-imaged and is starting up.");
      onRebuilt();
      setOpen(false);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button variant="outline" disabled={disabled}>
            <RotateCcw />
            Rebuild
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rebuild {vm.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Re-image this VM from a fresh ISO or template. It keeps its name and{" "}
            {vm.cpu} vCPU / {formatRam(vm.ram)} / {vm.storage} GB, but{" "}
            <span className="font-medium text-foreground">its current disk and all data are erased.</span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <FormField label="Rebuild from" htmlFor="rb-source">
          <Select value={source} onValueChange={(v) => { setSource(v as string); setError(null); }}>
            <SelectTrigger id="rb-source" className="w-full">
              <SelectValue placeholder={loading ? "Loading images…" : "Choose an ISO or template"} />
            </SelectTrigger>
            <SelectContent>
              {isos.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Install ISOs</SelectLabel>
                  {isos.map((iso) => (
                    <SelectItem key={iso.volid} value={`iso::${iso.name}`}>
                      {iso.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {templates.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Templates</SelectLabel>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={`tpl::${t.id}`}>
                      {t.name}
                      {t.cloudInit ? " (cloud image)" : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        </FormField>

        {needsCloudInit && (
          <div className="grid gap-3">
            <FormField label="SSH public key" htmlFor="rb-ssh">
              <textarea
                id="rb-ssh"
                value={sshKey}
                onChange={(e) => { setSshKey(e.target.value); setError(null); }}
                placeholder="ssh-ed25519 AAAA… you@laptop"
                className="h-20 w-full resize-none rounded-md border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </FormField>
            {savedKeys.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {savedKeys.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => { setSshKey(k.publicKey); setError(null); }}
                    className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                  >
                    {k.name}
                  </button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Login user (optional)" htmlFor="rb-user">
                <Input id="rb-user" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="debian" />
              </FormField>
              <FormField label="Password (optional)" htmlFor="rb-pass">
                <Input id="rb-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="—" />
              </FormField>
            </div>
          </div>
        )}

        <label className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => { setConfirmed(e.target.checked); setError(null); }}
            className="mt-0.5"
          />
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="size-4 shrink-0 text-destructive" />
            I understand this permanently erases the current disk and its data.
          </span>
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={submit} disabled={saving || loading}>
            {saving ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Rebuild
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function VmDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  const [vm, setVm] = useState<VmDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [transition, setTransition] = useState<Transition>(null);
  const [elapsed, setElapsed] = useState(0);
  const [tplName, setTplName] = useState("");
  const [newName, setNewName] = useState("");

  const transitionRef = useRef<Transition>(null);
  const startRef = useRef(0);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const safety = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Set the optimistic transition + a safety timeout so it can never get stuck.
  const setTrans = useCallback((t: Transition) => {
    transitionRef.current = t;
    setTransition(t);
    if (t) { startRef.current = Date.now(); setElapsed(0); }
    if (safety.current) clearTimeout(safety.current);
    if (t) safety.current = setTimeout(() => { transitionRef.current = null; setTransition(null); }, 120_000);
  }, []);

  // Tick the elapsed-seconds counter while a transition is in flight, so you can
  // see how long a start/stop/reboot is taking.
  useEffect(() => {
    if (!transition) return;
    setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [transition]);

  const load = useCallback(async () => {
    try {
      const res = await api.get<VmDetail>(`/vms/${id}`);
      if (!mounted.current) return;
      setVm(res.data);
      setError(null);
      // Clear the optimistic transition once the real status reaches its target.
      const t = transitionRef.current;
      const s = res.data.status;
      if (t === "starting" && s === "running") setTrans(null);
      else if (t === "stopping" && (s === "stopped" || s === "error")) setTrans(null);
    } catch (err) {
      if (mounted.current) setError(apiError(err));
    }
  }, [id, setTrans]);

  // Live refresh: poll the VM so status, IP, uptime, and console-readiness update
  // on their own — no manual page refresh. Paused when the tab isn't visible.
  useEffect(() => {
    mounted.current = true;
    const tick = async () => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      inFlight.current = true;
      try {
        await load();
      } finally {
        inFlight.current = false;
      }
    };
    tick();
    const iv = setInterval(tick, 2500);
    return () => {
      mounted.current = false;
      clearInterval(iv);
      if (safety.current) clearTimeout(safety.current);
    };
  }, [load]);

  async function action(kind: "start" | "stop" | "restart", path: string) {
    setTrans(kind === "start" ? "starting" : kind === "stop" ? "stopping" : "restarting");
    try {
      await api.post(`/vms/${id}/${path}`);
      await load();
      // A reboot stays "running", so there's no clean completion signal — clear it shortly.
      if (kind === "restart") {
        setTimeout(() => {
          if (transitionRef.current === "restarting") setTrans(null);
        }, 8000);
      }
    } catch (err) {
      toast.error(apiError(err));
      setTrans(null);
    }
  }

  async function onDelete() {
    setPending("delete");
    try {
      await api.delete(`/vms/${id}`);
      toast.success("VM deleted.");
      router.push("/vms");
    } catch (err) {
      toast.error(apiError(err));
      setPending("delete-failed");
    }
  }

  async function onRename() {
    const trimmed = newName.trim();
    if (!trimmed) {
      toast.error("Give the VM a name.");
      return;
    }
    if (!/^[a-zA-Z0-9-]+$/.test(trimmed)) {
      toast.error("Use letters, numbers and hyphens only.");
      return;
    }
    setPending("rename");
    try {
      await api.patch(`/vms/${id}`, { name: trimmed });
      toast.success("VM renamed.");
      await load();
      setPending(null);
    } catch (err) {
      toast.error(apiError(err));
      setPending(null);
    }
  }

  async function onConvert() {
    if (!tplName.trim()) {
      toast.error("Give the template a name.");
      return;
    }
    setPending("convert");
    try {
      await api.post(`/vms/${id}/convert-template`, { name: tplName.trim() });
      toast.success("Converted to a template — find it in the Template Store.");
      router.push("/templates");
    } catch (err) {
      toast.error(apiError(err));
      setPending(null);
    }
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl">
        <Button variant="ghost" render={<Link href="/vms" />} className="mb-4">
          <ArrowLeft /> Back to VMs
        </Button>
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">{error}</CardContent>
        </Card>
      </div>
    );
  }

  if (!vm) {
    return (
      <div className="mx-auto max-w-3xl">
        <Skeleton className="mb-6 h-9 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const acting = transition !== null;
  const busy = acting || (pending !== null && pending !== "delete-failed");
  const running = vm.status === "running";
  const stopped = vm.status === "stopped" || vm.status === "error";
  // Access: owners/admins manage shares; co-owners can operate; read-only can only
  // view (the API enforces all of this — the UI just hides what won't work).
  const canWrite = vm.access !== "read-only";
  const isManager = vm.access === "owner" || vm.access === "admin" || isAdmin;

  return (
    <div className="mx-auto max-w-3xl">
      <Button variant="ghost" render={<Link href="/vms" />} className="mb-4">
        <ArrowLeft /> Back to VMs
      </Button>

      <PageHeader title={vm.name} description={vm.description ?? undefined}>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Auto-refreshing">
            <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
          </span>
          <VmStatusBadge status={transition ?? vm.status} />
          {transition && (
            <span className="text-xs text-muted-foreground tabular-nums" title="Time in this transition">
              {elapsed}s
            </span>
          )}
        </div>
      </PageHeader>

      {!canWrite && (
        <Card className="mb-6 border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 text-sm text-muted-foreground">
            You have <span className="font-medium text-foreground">read-only</span> access to this VM,
            shared by its owner. You can view its details and activity, but not operate or change it.
          </CardContent>
        </Card>
      )}

      {/* Power controls — hidden for read-only shares (the API enforces it too). */}
      {canWrite && (
      <div className="mb-6 flex flex-wrap gap-2">
        <Button onClick={() => action("start", "start")} disabled={busy || running} variant="outline">
          {transition === "starting" ? <Loader2 className="animate-spin" /> : <Play />}
          Start
        </Button>
        <Button onClick={() => action("stop", "stop")} disabled={busy || stopped} variant="outline">
          {transition === "stopping" ? <Loader2 className="animate-spin" /> : <Square />}
          Stop
        </Button>
        <Button onClick={() => action("restart", "restart")} disabled={busy || !running} variant="outline">
          {transition === "restarting" ? <Loader2 className="animate-spin" /> : <RotateCw />}
          Restart
        </Button>
        <Button variant="outline" render={<Link href={`/vms/${vm.id}/console`} />} disabled={!running || acting}>
          <Terminal />
          Console
        </Button>
        <Button
          variant="outline"
          render={<Link href={`/vms/${vm.id}/console?mode=text`} />}
          disabled={!running || acting}
          title="Text console with clickable links, copy/paste and scrollback"
        >
          <SquareTerminal />
          Text console
        </Button>

        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button variant="outline" disabled={busy} onClick={() => setNewName(vm.name)}>
                <Pencil />
                Rename
              </Button>
            }
          />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Rename {vm.name}</AlertDialogTitle>
              <AlertDialogDescription>
                Changes the VM&apos;s name here and on Proxmox. Letters, numbers and hyphens only.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <FormField label="New name" htmlFor="newName">
              <Input
                id="newName"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. web-server-02"
              />
            </FormField>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onRename} disabled={pending === "rename"}>
                {pending === "rename" ? <Loader2 className="animate-spin" /> : <Pencil />}
                Rename
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <ResizeDialog vm={vm} isAdmin={isAdmin} disabled={busy} onResized={load} />

        <RebuildDialog vm={vm} disabled={busy} onRebuilt={load} />

        {isAdmin && (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant="outline" disabled={busy}>
                  <Package />
                  Save as template
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Convert to a template</AlertDialogTitle>
                <AlertDialogDescription>
                  This stops {vm.name} and converts it into a reusable, shareable template on
                  Proxmox. It will no longer appear as a VM. Best on a minimal, configured build.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <FormField label="Template name" htmlFor="tplName">
                <Input
                  id="tplName"
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  placeholder="e.g. Debian 12 base"
                />
              </FormField>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onConvert} disabled={pending === "convert"}>
                  {pending === "convert" ? <Loader2 className="animate-spin" /> : <Package />}
                  Convert
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {isAdmin && (
          <MigrateDialog vmId={vm.id} currentNode={vm.proxmoxNode} running={running} onDone={load} />
        )}

        <div className="ml-auto">
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant="destructive" disabled={busy}>
                  <Trash2 />
                  Delete
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {vm.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently destroys the VM and its disk on Proxmox. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onDelete} disabled={pending === "delete"}>
                  {pending === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  Delete VM
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <DetailRow icon={Cpu} label="vCPU" value={`${vm.cpu} cores`} />
            <DetailRow icon={MemoryStick} label="Memory" value={formatRam(vm.ram)} />
            <DetailRow icon={HardDrive} label="Disk" value={`${vm.storage} GB`} />
            <DetailRow icon={Disc} label="OS image" value={vm.os} />
            <DetailRow icon={Server} label="Node" value={vm.proxmoxNode} />
            <DetailRow icon={Hash} label="VMID" value={vm.proxmoxVmId} />
            <DetailRow icon={Network} label="IP address" value={vm.ipAddress ?? "—"} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Live status</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {vm.live ? (
              <>
                <DetailRow icon={Play} label="State" value={vm.live.status} />
                <DetailRow
                  icon={Cpu}
                  label="CPU usage"
                  value={vm.live.cpu !== undefined ? `${(vm.live.cpu * 100).toFixed(1)}%` : "—"}
                />
                <DetailRow
                  icon={MemoryStick}
                  label="Memory used"
                  value={
                    vm.live.mem !== undefined
                      ? `${formatBytes(vm.live.mem)} / ${formatBytes(vm.live.maxmem)}`
                      : "—"
                  }
                />
                <DetailRow icon={RotateCw} label="Uptime" value={formatUptime(vm.live.uptime)} />
              </>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Live status unavailable. The VM may be stopped or Proxmox is unreachable.
              </p>
            )}
            <DetailRow icon={Hash} label="Created" value={formatDate(vm.createdAt)} />
          </CardContent>
        </Card>
      </div>

      <MetricsCard vmId={vm.id} />

      {canWrite && <NotesCard vmId={vm.id} initial={vm.description} onSaved={load} />}

      {canWrite && <TagsCard vmId={vm.id} initial={vm.tags} onSaved={load} />}

      {canWrite && <PowerSchedulePanel vmId={vm.id} />}

      <ActivityCard vmId={vm.id} />

      {canWrite && <SnapshotsPanel vmId={vm.id} vmName={vm.name} />}

      {canWrite && <MateStatesPanel vmId={vm.id} vmName={vm.name} />}

      {canWrite && <BackupPolicyPanel vmId={vm.id} />}

      {canWrite && <DisksPanel vmId={vm.id} onChanged={load} />}

      {isManager && <SharePanel vmId={vm.id} />}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Lightbulb className="size-4 text-amber-500" />
            Optimization tips
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1.5 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">VirtIO is already configured</span> —
            this VM uses a VirtIO SCSI disk and VirtIO network for max throughput.
          </p>
          <p>
            <span className="font-medium text-foreground">Install the guest agent</span> so memory
            stats and clean shutdown work. Inside the VM (Debian/Ubuntu):{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              sudo apt update &amp;&amp; sudo apt install qemu-guest-agent
            </code>
          </p>
          <p>
            <span className="font-medium text-foreground">Reuse it</span> — once configured,
            convert the VM to a Template in Proxmox to clone new ones instantly.
          </p>
          <p>
            <span className="font-medium text-foreground">Reach it from outside ProxMate</span> —
            use{" "}
            <Link href="/help" className="text-primary underline-offset-4 hover:underline">
              Tailscale (private SSH) or Cloudflare Tunnel (public web)
            </Link>
            . Don&apos;t ask for port forwarding — it isn&apos;t allowed on this cluster.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
