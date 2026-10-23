"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { FolderKanban } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { ProjectsView } from "@/lib/types";
import { PageHeader } from "@/components/dashboard/page-header";
import { ProjectsBoard, type BulkPower } from "@/components/projects/projects-board";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const WINDOWS = [1, 7, 14] as const;
// POST /api/vms/bulk takes at most this many ids per call.
const BULK_MAX = 50;

export default function ProjectsPage() {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const [days, setDays] = useState<number>(7);
  const [view, setView] = useState<ProjectsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.get<ProjectsView>("/projects", { params: { days } });
    setView(res.data);
  }, [days]);

  useEffect(() => {
    let live = true;
    api
      .get<ProjectsView>("/projects", { params: { days } })
      .then((res) => { if (live) { setView(res.data); setError(null); } })
      .catch((err) => { if (live) setError(apiError(err)); });
    return () => { live = false; };
  }, [days]);

  // Project power actions go through the same bulk endpoint as the VMs list, so
  // every per-VM lock and ownership check applies; failures are reported per VM.
  async function runBulk(key: string, action: BulkPower, ids: string[]) {
    // One project action at a time, so one finishing can't clear another's spinner.
    if (busyKey) return;
    setBusyKey(key);
    try {
      let ok = 0;
      let failed = 0;
      for (let i = 0; i < ids.length; i += BULK_MAX) {
        const res = await api.post<{ results: { ok: boolean }[] }>("/vms/bulk", { action, ids: ids.slice(i, i + BULK_MAX) });
        ok += res.data.results.filter((r) => r.ok).length;
        failed += res.data.results.filter((r) => !r.ok).length;
      }
      toast.success(`${action}: ${ok} ok${failed ? `, ${failed} failed` : ""}.`);
      await load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusyKey(null);
    }
  }

  const empty = view !== null && view.owners.length === 0 && !view.shared;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Projects"
        description={
          isAdmin
            ? "Every owner's VMs, grouped by project."
            : "Your VMs grouped by project, with allocation and average usage."
        }
      >
        <div className="flex items-center gap-1" role="group" aria-label="Usage window">
          {WINDOWS.map((d) => (
            <Button key={d} size="sm" variant={days === d ? "secondary" : "ghost"} aria-pressed={days === d} onClick={() => setDays(d)}>
              {d}d
            </Button>
          ))}
        </div>
      </PageHeader>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {view === null && error ? null : view === null ? (
        <Card>
          <CardContent className="grid gap-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </CardContent>
        </Card>
      ) : empty ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <FolderKanban className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No virtual machines yet.</p>
            <Button render={<Link href="/vms" />} variant="outline">
              Go to Virtual Machines
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            Put a VM in a project from its page or with <span className="font-medium">Move to project…</span> on the
            Virtual Machines list. Usage is averaged over the last {view.days} day{view.days === 1 ? "" : "s"} while
            each VM was running.
          </p>
          <ProjectsBoard view={view} isAdmin={isAdmin} busyKey={busyKey} onBulk={runBulk} />
        </>
      )}
    </div>
  );
}
