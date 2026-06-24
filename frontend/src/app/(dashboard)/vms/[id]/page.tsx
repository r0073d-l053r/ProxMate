"use client";

import { useCallback, useEffect, useState } from "react";
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
} from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { VmDetail } from "@/lib/types";
import { formatRam, formatBytes, formatUptime, formatDate } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { VmStatusBadge } from "@/components/vm/vm-status-badge";
import { MateStatesPanel } from "@/components/vm/matestates-panel";
import { useAuthStore } from "@/lib/auth-store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/form-field";
import { Skeleton } from "@/components/ui/skeleton";
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

export default function VmDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  const [vm, setVm] = useState<VmDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [tplName, setTplName] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api.get<VmDetail>(`/vms/${id}`);
      setVm(res.data);
    } catch (err) {
      setError(apiError(err));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function action(kind: "start" | "stop" | "restart", path: string) {
    setPending(kind);
    try {
      await api.post(`/vms/${id}/${path}`);
      toast.success(`VM ${kind} requested.`);
      await load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setPending(null);
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

  const busy = pending !== null && pending !== "delete-failed";
  const running = vm.status === "running";
  const stopped = vm.status === "stopped" || vm.status === "error";

  return (
    <div className="mx-auto max-w-3xl">
      <Button variant="ghost" render={<Link href="/vms" />} className="mb-4">
        <ArrowLeft /> Back to VMs
      </Button>

      <PageHeader title={vm.name} description={vm.description ?? undefined}>
        <VmStatusBadge status={vm.status} />
      </PageHeader>

      {/* Power controls */}
      <div className="mb-6 flex flex-wrap gap-2">
        <Button onClick={() => action("start", "start")} disabled={busy || running} variant="outline">
          {pending === "start" ? <Loader2 className="animate-spin" /> : <Play />}
          Start
        </Button>
        <Button onClick={() => action("stop", "stop")} disabled={busy || stopped} variant="outline">
          {pending === "stop" ? <Loader2 className="animate-spin" /> : <Square />}
          Stop
        </Button>
        <Button onClick={() => action("restart", "restart")} disabled={busy || !running} variant="outline">
          {pending === "restart" ? <Loader2 className="animate-spin" /> : <RotateCw />}
          Restart
        </Button>
        <Button variant="outline" render={<Link href={`/vms/${vm.id}/console`} />} disabled={!running}>
          <Terminal />
          Console
        </Button>

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

      <MateStatesPanel vmId={vm.id} vmName={vm.name} />

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
