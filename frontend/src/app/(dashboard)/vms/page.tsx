"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Plus, MonitorPlay, Play, Square, RotateCw, X, Trash2, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { VirtualMachine, UserGroup } from "@/lib/types";
import { formatRam, formatDate } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { OwnerGroupHeader } from "@/components/dashboard/owner-group-header";
import { VmStatusBadge } from "@/components/vm/vm-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
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

export function parseTags(csv: string | null): string[] {
  return (csv ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

/**
 * Bulk-delete confirmation. Destroying several VMs at once is a footgun, so this
 * gates it behind a *typed* confirmation: the Delete button stays disabled until
 * the user types the exact number of selected VMs.
 */
function BulkDeleteDialog({ count, busy, onConfirm }: { count: number; busy: boolean; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const ready = text.trim() === String(count);
  return (
    <AlertDialog open={open} onOpenChange={(o: boolean) => { setOpen(o); if (!o) setText(""); }}>
      <AlertDialogTrigger
        render={
          <Button size="sm" variant="destructive" disabled={busy}>
            <Trash2 /> Delete
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {count} VM{count === 1 ? "" : "s"}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently destroys each selected VM and its disk on Proxmox — this cannot be undone.
            Type <strong>{count}</strong> below to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          autoFocus
          inputMode="numeric"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Type ${count} to confirm`}
          aria-label="Type the number of VMs to confirm deletion"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy || !ready}
            onClick={() => { onConfirm(); setOpen(false); }}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete {count}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function TagChips({ tags, onClick }: { tags: string[]; onClick?: (t: string) => void }) {
  if (tags.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {tags.map((t) => (
        <button
          key={t}
          type="button"
          onClick={onClick ? () => onClick(t) : undefined}
          className={
            "rounded-full border px-2 py-0.5 text-xs text-muted-foreground " +
            (onClick ? "hover:bg-muted" : "cursor-default")
          }
        >
          {t}
        </button>
      ))}
    </div>
  );
}

interface Selection {
  selected: Set<string>;
  toggle: (id: string) => void;
}

/** The VM table, reused for each owner group (admin) and the user's own list. */
function VmTable({
  vms,
  selection,
  onTagClick,
}: {
  vms: VirtualMachine[];
  selection?: Selection;
  onTagClick?: (t: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {selection && <TableHead className="w-8" />}
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Resources</TableHead>
          <TableHead>OS</TableHead>
          <TableHead>IP address</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {vms.map((vm) => (
          <TableRow key={vm.id}>
            {selection && (
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={`Select ${vm.name}`}
                  checked={selection.selected.has(vm.id)}
                  onChange={() => selection.toggle(vm.id)}
                  className="size-4 align-middle accent-primary"
                />
              </TableCell>
            )}
            <TableCell>
              <Link href={`/vms/${vm.id}`} className="font-medium hover:underline">
                {vm.name}
              </Link>
              {(vm.access === "co-owner" || vm.access === "read-only") && (
                <span className="ml-2 align-middle rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  Shared · {vm.access}
                </span>
              )}
              <TagChips tags={parseTags(vm.tags)} onClick={onTagClick} />
            </TableCell>
            <TableCell>
              <VmStatusBadge status={vm.status} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              {vm.cpu} vCPU · {formatRam(vm.ram)} · {vm.storage} GB
            </TableCell>
            <TableCell className="text-muted-foreground">{vm.os}</TableCell>
            <TableCell className="text-muted-foreground">{vm.ipAddress ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{formatDate(vm.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The user's own VM list: tag filter + multi-select + bulk power/delete actions. */
function OwnVmList({ vms, reload }: { vms: VirtualMachine[]; reload: () => Promise<void> }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    vms.forEach((v) => parseTags(v.tags).forEach((t) => s.add(t)));
    return [...s].sort();
  }, [vms]);

  const shown = activeTag ? vms.filter((v) => parseTags(v.tags).includes(activeTag)) : vms;

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function runBulk(action: "start" | "stop" | "restart" | "delete") {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const res = await api.post<{ results: { id: string; ok: boolean; error?: string }[] }>("/vms/bulk", { action, ids });
      const ok = res.data.results.filter((r) => r.ok).length;
      const failed = res.data.results.length - ok;
      toast.success(`${action}: ${ok} ok${failed ? `, ${failed} failed` : ""}.`);
      setSelected(new Set());
      await reload();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Filter:</span>
          {allTags.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setActiveTag((cur) => (cur === t ? null : t))}
              aria-pressed={activeTag === t}
              className={
                "rounded-full border px-2 py-0.5 text-xs transition-colors " +
                (activeTag === t ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")
              }
            >
              {t}
            </button>
          ))}
          {activeTag && (
            <button type="button" onClick={() => setActiveTag(null)} className="text-xs text-muted-foreground hover:text-foreground">
              <X className="inline size-3" /> clear
            </button>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => runBulk("start")}>
            <Play /> Start
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => runBulk("stop")}>
            <Square /> Stop
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => runBulk("restart")}>
            <RotateCw /> Restart
          </Button>
          <BulkDeleteDialog count={selected.size} busy={busy} onConfirm={() => runBulk("delete")} />
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <VmTable vms={shown} selection={{ selected, toggle }} onTagClick={(t) => setActiveTag(t)} />
    </div>
  );
}

export default function VmsPage() {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const [vms, setVms] = useState<VirtualMachine[] | null>(null); // user view
  const [groups, setGroups] = useState<UserGroup[] | null>(null); // admin view
  const [error, setError] = useState<string | null>(null);

  const reloadOwn = useCallback(async () => {
    const res = await api.get<VirtualMachine[]>("/vms");
    setVms(res.data);
  }, []);

  useEffect(() => {
    if (isAdmin) {
      api
        .get<UserGroup[]>("/admin/all-vms")
        .then((res) => setGroups(res.data))
        .catch((err) => setError(apiError(err)));
    } else {
      reloadOwn().catch((err) => setError(apiError(err)));
    }
  }, [isAdmin, reloadOwn]);

  const ownerGroups = groups?.filter((g) => g.vms.length > 0) ?? [];
  const totalVms = groups?.reduce((n, g) => n + g.vms.length, 0) ?? 0;

  const loading = isAdmin ? groups === null : vms === null;
  const empty = isAdmin ? totalVms === 0 : vms?.length === 0;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Virtual Machines"
        description={isAdmin ? "Every VM on the cluster, separated by owner." : "Your virtual machines."}
      >
        <Button render={<Link href="/vms/new" />}>
          <Plus />
          New VM
        </Button>
      </PageHeader>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {loading ? (
        <Card>
          <CardContent className="grid gap-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </CardContent>
        </Card>
      ) : empty ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <MonitorPlay className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No virtual machines yet.</p>
            <Button render={<Link href="/vms/new" />} variant="outline">
              <Plus />
              Create your first VM
            </Button>
          </CardContent>
        </Card>
      ) : isAdmin ? (
        <div className="grid gap-4">
          {ownerGroups.map((g) => (
            <Card key={g.id}>
              <CardContent className="grid gap-3">
                <OwnerGroupHeader group={g} />
                <VmTable vms={g.vms} />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent>
            <OwnVmList vms={vms ?? []} reload={reloadOwn} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
