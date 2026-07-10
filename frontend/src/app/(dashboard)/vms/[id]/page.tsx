"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowLeftRight,
  Archive,
  ChevronDown,
  Code2,
  Copy,
  Cpu,
  Disc,
  HardDrive,
  Hash,
  Lightbulb,
  Loader2,
  MemoryStick,
  Network,
  Package,
  Pencil,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Scaling,
  Server,
  Square,
  SquareTerminal,
  Terminal,
  Trash2,
} from "lucide-react";
import { SiTailscale } from "react-icons/si";
import { TemplateIcon } from "@/components/template-icon";
import { api, apiBaseUrl, apiError } from "@/lib/api";
import type { IdeCapability, VmDetail } from "@/lib/types";
import { copyText } from "@/lib/clipboard";
import { formatRam, formatBytes, formatUptime, formatDate } from "@/lib/format";
import { VmStatusBadge } from "@/components/vm/vm-status-badge";
import { NotesCard } from "@/components/vm/notes-card";
import { TagsCard } from "@/components/vm/tags-card";
import { MetricsCard } from "@/components/vm/metrics-card";
import { ActivityCard } from "@/components/vm/activity-card";
import { ResizeDialog } from "@/components/vm/resize-dialog";
import { RebuildDialog } from "@/components/vm/rebuild-dialog";
import { MigrateDialog } from "@/components/vm/migrate-dialog";
import { MateStatesPanel } from "@/components/vm/matestates-panel";
import { SnapshotsPanel } from "@/components/vm/snapshots-panel";
import { PowerSchedulePanel } from "@/components/vm/power-schedule-panel";
import { BackupPolicyPanel } from "@/components/vm/backup-policy-panel";
import { SharePanel } from "@/components/vm/share-panel";
import { DisksPanel } from "@/components/vm/disks-panel";
import { PassthroughPanel } from "@/components/vm/passthrough-panel";
import { RecoveryPanel } from "@/components/vm/recovery-panel";
import { AlertsPanel } from "@/components/vm/alerts-panel";
import { useAuthStore } from "@/lib/auth-store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Client-side optimistic state while a power action is in flight. */
type Transition = "starting" | "stopping" | "restarting" | null;

/** Which of the page's modal dialogs is open (all driven from the Actions menu). */
type ActiveDialog = "rename" | "resize" | "rebuild" | "convert" | "migrate" | "duplicate" | "delete" | null;

/** DigitalOcean-style top-level sections of the detail page. */
const TAB_VALUES = ["overview", "insights", "backups", "activity", "settings"] as const;
type TabValue = (typeof TAB_VALUES)[number];

function isTabValue(v: string | null): v is TabValue {
  return !!v && (TAB_VALUES as readonly string[]).includes(v);
}

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

/** A Settings-tab row: label + explanation on the left, one action on the right. */
function SettingRow({
  title,
  description,
  action,
}: {
  title: string;
  description: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
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
  const [dupName, setDupName] = useState("");
  // Typed-name confirmation for the destructive delete — must match vm.name exactly.
  const [deleteText, setDeleteText] = useState("");
  const [dialog, setDialog] = useState<ActiveDialog>(null);

  // ProxMate IDE availability for this user (admin policy) — gates the Console
  // menu entry. Fetched once; failure just hides the entry.
  const [ideCap, setIdeCap] = useState<IdeCapability | null>(null);
  useEffect(() => {
    api
      .get<IdeCapability>("/ide/config")
      .then((r) => setIdeCap(r.data))
      .catch(() => setIdeCap(null));
  }, []);

  // Active tab, deep-linkable via ?tab= (e.g. /vms/abc?tab=backups). Kept in the
  // URL with replaceState so switching tabs never adds history entries.
  const [tab, setTabState] = useState<TabValue>(() => {
    if (typeof window === "undefined") return "overview";
    const t = new URLSearchParams(window.location.search).get("tab");
    return isTabValue(t) ? t : "overview";
  });
  const setTab = useCallback((t: TabValue) => {
    setTabState(t);
    const url = new URL(window.location.href);
    if (t === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", t);
    window.history.replaceState(null, "", url);
  }, []);

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
      setDialog(null);
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

  async function onDuplicate() {
    const trimmed = dupName.trim();
    if (!/^[a-zA-Z0-9-]+$/.test(trimmed)) {
      toast.error("Use letters, numbers and hyphens only.");
      return;
    }
    setPending("duplicate");
    try {
      const res = await api.post<{ id: string }>(`/vms/${id}/duplicate`, { name: trimmed });
      toast.success("Duplicated — opening the copy.");
      router.push(`/vms/${res.data.id}`);
    } catch (err) {
      toast.error(apiError(err));
      setPending(null);
    }
  }

  async function onCopy(label: string, value: string) {
    const ok = await copyText(value);
    if (ok) toast.success(`${label} copied.`);
    else toast.error("Couldn't copy — select the address and copy manually.");
  }

  if (error) {
    return (
      <div className="mx-auto max-w-5xl">
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
      <div className="mx-auto max-w-5xl">
        <Skeleton className="mb-6 h-9 w-48" />
        <Skeleton className="mb-4 h-10 w-full max-w-md" />
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
  // Containers (LXC) don't support the QEMU-only features: rebuild, convert to
  // template, live migration, extra data disks, and snapshots.
  const isLxc = vm.type === "lxc";

  // Read-only shares don't get the Backups / Settings tabs — if a deep link asks
  // for one anyway, land on Overview instead of an empty panel.
  const activeTab: TabValue = !canWrite && (tab === "backups" || tab === "settings") ? "overview" : tab;

  return (
    <div className="mx-auto max-w-5xl">
      <Button variant="ghost" render={<Link href="/vms" />} className="mb-4">
        <ArrowLeft /> Back to VMs
      </Button>

      {/* DigitalOcean-style header: identity + status on the left, the two things
          you reach for most — Console and Actions — pinned on the right. */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{vm.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <VmStatusBadge status={transition ?? vm.status} />
            {transition && (
              <span className="tabular-nums" title="Time in this transition">
                {elapsed}s
              </span>
            )}
            {isLxc && (
              <span className="rounded border px-1.5 py-0.5 text-[10px] font-medium">LXC</span>
            )}
            {vm.hasPassthrough && (
              <span className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                <Cpu className="size-2.5" /> GPU/PCI
              </span>
            )}
            <span className="flex items-center gap-1">
              <Server className="size-3.5" />
              {vm.proxmoxNode}
            </span>
            <span className="flex items-center gap-1">
              <Hash className="size-3.5" />
              {vm.proxmoxVmId}
            </span>
            <span className="hidden max-w-56 items-center gap-1.5 sm:flex">
              <TemplateIcon os={vm.os} name={vm.os} className="size-3.5 shrink-0" />
              <span className="truncate" title={vm.os}>
                {vm.os}
              </span>
            </span>
          </div>
        </div>

        {canWrite && (
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" disabled={!running || acting}>
                    <Terminal />
                    Console
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuItem onClick={() => router.push(`/vms/${vm.id}/console`)}>
                  <Terminal />
                  Graphical (noVNC)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push(`/vms/${vm.id}/console?mode=text`)}>
                  <SquareTerminal />
                  Text — links, copy/paste
                </DropdownMenuItem>
                {ideCap?.available && vm.type !== "lxc" && (
                  <DropdownMenuItem
                    disabled={!running}
                    onClick={() =>
                      window.open(
                        `${apiBaseUrl}/ide/${vm.id}/proxy/`,
                        `proxmate-ide-${vm.id}`,
                        "popup,width=1500,height=940",
                      )
                    }
                  >
                    <Code2 />
                    ProxMate IDE — code + AI
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    window.open(
                      `/console-popout/${vm.id}`,
                      `proxmate-console-${vm.id}`,
                      "popup,width=960,height=540",
                    )
                  }
                >
                  <PictureInPicture2 />
                  Pop out text console
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button>
                    Actions
                    <ChevronDown className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuGroup>
                  <DropdownMenuItem disabled={busy || running} onClick={() => action("start", "start")}>
                    <Play />
                    Start
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={busy || stopped} onClick={() => action("stop", "stop")}>
                    <Square />
                    Stop
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={busy || !running} onClick={() => action("restart", "restart")}>
                    <RotateCw />
                    Restart
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    disabled={busy}
                    onClick={() => {
                      setNewName(vm.name);
                      setDialog("rename");
                    }}
                  >
                    <Pencil />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={busy} onClick={() => setDialog("resize")}>
                    <Scaling />
                    Resize
                  </DropdownMenuItem>
                  {!isLxc && (
                    <DropdownMenuItem disabled={busy} onClick={() => setDialog("rebuild")}>
                      <RotateCcw />
                      Rebuild
                    </DropdownMenuItem>
                  )}
                  {!isLxc && (
                    <DropdownMenuItem
                      disabled={busy}
                      onClick={() => {
                        setDupName(`${vm.name}-copy`);
                        setDialog("duplicate");
                      }}
                    >
                      <Copy />
                      Duplicate
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                {isAdmin && !isLxc && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem disabled={busy} onClick={() => setDialog("migrate")}>
                        <ArrowLeftRight />
                        Migrate to node
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={busy}
                        onClick={() => {
                          setTplName("");
                          setDialog("convert");
                        }}
                      >
                        <Package />
                        Save as template
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={busy} onClick={() => setDialog("delete")}>
                  <Trash2 />
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {!canWrite && (
        <Card className="mb-6 border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 text-sm text-muted-foreground">
            You have <span className="font-medium text-foreground">read-only</span> access to this VM,
            shared by its owner. You can view its details and activity, but not operate or change it.
          </CardContent>
        </Card>
      )}

      {vm.rescueBoot && (
        <Card className="mb-6 border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">Rescue mode</span> — this machine is booted
              from the rescue ISO. Repair it via the console, then exit rescue to boot from disk again.
            </span>
            {canWrite && (
              <Button variant="outline" size="sm" onClick={() => setTab("settings")}>
                Manage in Settings
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={(v) => setTab(v as TabValue)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
          {canWrite && <TabsTrigger value="backups">Backups &amp; Snapshots</TabsTrigger>}
          <TabsTrigger value="activity">Activity</TabsTrigger>
          {canWrite && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <div className="grid items-start gap-4 lg:grid-cols-5">
            <div className="grid gap-4 lg:col-span-3">
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

              <Card>
                <CardHeader>
                  <CardTitle>Configuration</CardTitle>
                </CardHeader>
                <CardContent className="divide-y">
                  <DetailRow icon={Cpu} label="vCPU" value={`${vm.cpu} cores`} />
                  <DetailRow icon={MemoryStick} label="Memory" value={formatRam(vm.ram)} />
                  <DetailRow icon={HardDrive} label="Disk" value={`${vm.storage} GB`} />
                  <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Disc className="size-4" />
                      OS image
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 font-medium">
                      <TemplateIcon os={vm.os} name={vm.os} className="size-4 shrink-0" />
                      <span className="truncate" title={vm.os}>
                        {vm.os}
                      </span>
                    </span>
                  </div>
                </CardContent>
              </Card>

              {canWrite && <NotesCard vmId={vm.id} initial={vm.description} onSaved={load} />}
            </div>

            <div className="grid gap-4 lg:col-span-2">
              <Card>
                <CardHeader>
                  <CardTitle>Connection details</CardTitle>
                </CardHeader>
                <CardContent className="divide-y">
                  <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Network className="size-4" />
                      IP address
                    </span>
                    <span className="flex items-center gap-1 font-medium">
                      {vm.ipAddress ?? "—"}
                      {vm.ipAddress && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => onCopy("IP address", vm.ipAddress!)}
                          title="Copy IP address"
                          aria-label="Copy IP address"
                        >
                          <Copy />
                        </Button>
                      )}
                    </span>
                  </div>
                  {vm.tailscaleIp && (
                    <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
                      <span
                        className="flex items-center gap-2 text-muted-foreground"
                        title="Tailscale is running inside this machine — reach it at this address from any device on your tailnet."
                      >
                        <SiTailscale className="size-4" />
                        Tailscale IP
                      </span>
                      <span className="flex items-center gap-1 font-medium">
                        {vm.tailscaleIp}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => onCopy("Tailscale IP", vm.tailscaleIp!)}
                          title="Copy Tailscale IP"
                          aria-label="Copy Tailscale IP"
                        >
                          <Copy />
                        </Button>
                      </span>
                    </div>
                  )}
                  <DetailRow icon={Server} label="Node" value={vm.proxmoxNode} />
                  <DetailRow icon={Hash} label="VMID" value={vm.proxmoxVmId} />
                </CardContent>
              </Card>

              {canWrite && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Archive className="size-4 text-muted-foreground" />
                      Backups
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      Weekly MateStates backups with rolling retention
                      {!isLxc ? ", plus instant snapshots for quick restore points" : ""}.
                    </p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => setTab("backups")}>
                      Manage backups
                    </Button>
                  </CardContent>
                </Card>
              )}

              {canWrite && <TagsCard vmId={vm.id} initial={vm.tags} onSaved={load} />}

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Lightbulb className="size-4 text-amber-500" />
                    Optimization tips
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-1.5 text-sm text-muted-foreground">
                  {isLxc ? (
                    <p>
                      <span className="font-medium text-foreground">Lightweight by design</span> — this is an
                      LXC container: it shares the host kernel, boots in seconds, and reports its IP and stats
                      without a guest agent. Live migration, extra data disks, and snapshots aren&apos;t
                      available for containers.
                    </p>
                  ) : (
                    <>
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
                    </>
                  )}
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
          </div>
        </TabsContent>

        <TabsContent value="insights" className="pt-4">
          <MetricsCard vmId={vm.id} tall />
          <p className="mt-3 text-xs text-muted-foreground">
            Live ticks every second (rolling two-minute window, zoomed to the activity); Day and Week
            come from Proxmox&apos;s metric store and fill in as the VM keeps running.
          </p>
        </TabsContent>

        {canWrite && (
          <TabsContent value="backups">
            <MateStatesPanel vmId={vm.id} vmName={vm.name} />
            <BackupPolicyPanel vmId={vm.id} />
            {!isLxc && <SnapshotsPanel vmId={vm.id} vmName={vm.name} />}
          </TabsContent>
        )}

        <TabsContent value="activity" className="pt-4">
          <ActivityCard vmId={vm.id} />
        </TabsContent>

        {canWrite && (
          <TabsContent value="settings">
            <Card className="mt-4">
              <CardHeader>
                <CardTitle className="text-sm">General</CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                <SettingRow
                  title="Name"
                  description={
                    <>
                      <span className="font-medium text-foreground">{vm.name}</span> — shown here and on
                      Proxmox.
                    </>
                  }
                  action={
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setNewName(vm.name);
                        setDialog("rename");
                      }}
                    >
                      <Pencil />
                      Rename
                    </Button>
                  }
                />
                <SettingRow
                  title="Size"
                  description={`${vm.cpu} vCPU · ${formatRam(vm.ram)} · ${vm.storage} GB disk. Disk can only grow.`}
                  action={
                    <Button variant="outline" disabled={busy} onClick={() => setDialog("resize")}>
                      <Scaling />
                      Resize
                    </Button>
                  }
                />
              </CardContent>
            </Card>

            <PowerSchedulePanel vmId={vm.id} />

            {!isLxc && <DisksPanel vmId={vm.id} onChanged={load} />}

            {!isLxc && (
              <PassthroughPanel
                vmId={vm.id}
                vmName={vm.name}
                isAdmin={isAdmin}
                canWrite={canWrite}
                onChanged={load}
              />
            )}

            <AlertsPanel vmId={vm.id} canWrite={canWrite} />

            {!isLxc && <RecoveryPanel vm={vm} busy={busy} onChanged={load} />}

            {isManager && <SharePanel vmId={vm.id} />}

            {isAdmin && !isLxc && (
              <Card className="mt-4">
                <CardHeader>
                  <CardTitle className="text-sm">Admin</CardTitle>
                </CardHeader>
                <CardContent className="divide-y">
                  <SettingRow
                    title="Migrate to another node"
                    description={`Currently on ${vm.proxmoxNode}. Live for a running VM; cross-architecture moves are blocked.`}
                    action={
                      <Button variant="outline" disabled={busy} onClick={() => setDialog("migrate")}>
                        <ArrowLeftRight />
                        Migrate
                      </Button>
                    }
                  />
                  <SettingRow
                    title="Save as template"
                    description="Stop this VM and convert it into a reusable Template Store image."
                    action={
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setTplName("");
                          setDialog("convert");
                        }}
                      >
                        <Package />
                        Convert
                      </Button>
                    }
                  />
                </CardContent>
              </Card>
            )}

            <Card className="mt-4 border-destructive/40">
              <CardHeader>
                <CardTitle className="text-sm text-destructive">Danger zone</CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                {!isLxc && (
                  <SettingRow
                    title="Rebuild"
                    description="Re-image from a fresh ISO or template. Keeps name and resources — erases the current disk."
                    action={
                      <Button variant="outline" disabled={busy} onClick={() => setDialog("rebuild")}>
                        <RotateCcw />
                        Rebuild
                      </Button>
                    }
                  />
                )}
                <SettingRow
                  title={isLxc ? "Delete container" : "Delete VM"}
                  description="Permanently destroy it and its disk on Proxmox. This cannot be undone."
                  action={
                    <Button variant="destructive" disabled={busy} onClick={() => setDialog("delete")}>
                      <Trash2 />
                      Delete
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* ── Dialogs (opened from the Actions menu and the Settings tab) ───────── */}

      <AlertDialog open={dialog === "rename"} onOpenChange={(o: boolean) => setDialog(o ? "rename" : null)}>
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

      <ResizeDialog
        vm={vm}
        isAdmin={isAdmin}
        open={dialog === "resize"}
        onOpenChange={(o) => setDialog(o ? "resize" : null)}
        onResized={load}
      />

      {!isLxc && (
        <RebuildDialog
          vm={vm}
          open={dialog === "rebuild"}
          onOpenChange={(o) => setDialog(o ? "rebuild" : null)}
          onRebuilt={load}
        />
      )}

      {isAdmin && !isLxc && (
        <MigrateDialog
          vmId={vm.id}
          currentNode={vm.proxmoxNode}
          running={running}
          open={dialog === "migrate"}
          onOpenChange={(o) => setDialog(o ? "migrate" : null)}
          onDone={load}
        />
      )}

      <AlertDialog open={dialog === "duplicate"} onOpenChange={(o: boolean) => setDialog(o ? "duplicate" : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Duplicate {vm.name}</AlertDialogTitle>
            <AlertDialogDescription>
              Makes a full, independent copy — same size, OS, disk contents and tags — as a brand-new
              machine you own. The source must be{" "}
              <span className="font-medium text-foreground">stopped</span> first, and the copy counts
              against your quota. It boots on its own once ready.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FormField label="New machine name" htmlFor="dupName">
            <Input
              id="dupName"
              value={dupName}
              onChange={(e) => setDupName(e.target.value)}
              placeholder="e.g. web-server-02"
            />
          </FormField>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onDuplicate} disabled={pending === "duplicate" || !dupName.trim()}>
              {pending === "duplicate" ? <Loader2 className="animate-spin" /> : <Copy />}
              Duplicate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === "convert"} onOpenChange={(o: boolean) => setDialog(o ? "convert" : null)}>
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

      <AlertDialog
        open={dialog === "delete"}
        onOpenChange={(o: boolean) => {
          setDialog(o ? "delete" : null);
          if (!o) setDeleteText("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {vm.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This <span className="font-semibold text-foreground">permanently destroys</span> the{" "}
              {isLxc ? "container" : "VM"} and its disk on Proxmox —{" "}
              <span className="font-semibold text-foreground">it can never be brought back</span>. Its
              backups and snapshots are removed with it, so if there&apos;s anything on this machine
              you want to keep, save it first (see the{" "}
              <button
                type="button"
                className="font-medium text-primary underline-offset-4 hover:underline"
                onClick={() => {
                  setDialog(null);
                  setDeleteText("");
                  setTab("backups");
                }}
              >
                Backups &amp; Snapshots
              </button>{" "}
              tab).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FormField label={`Type "${vm.name}" to confirm`} htmlFor="deleteConfirm">
            <Input
              id="deleteConfirm"
              autoFocus
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              placeholder={vm.name}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={onDelete}
              disabled={pending === "delete" || deleteText.trim() !== vm.name}
            >
              {pending === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Delete {isLxc ? "container" : "VM"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
