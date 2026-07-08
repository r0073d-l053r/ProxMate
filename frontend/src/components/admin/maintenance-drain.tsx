"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Wrench,
  Loader2,
  ArrowRight,
  AlertTriangle,
  HardDriveDownload,
  ServerCog,
} from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { BalancerNodeView, DrainPlan } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const AUTO = "__auto__";

/**
 * Maintenance mode: pick a node about to go down and evacuate every
 * ProxMate-managed guest off it — auto-placed on best-fit nodes, or all pushed
 * to one chosen target. Running guests move live (no downtime).
 */
export function MaintenanceDrain({
  nodes,
  onApplied,
}: {
  nodes: BalancerNodeView[];
  onApplied: () => void;
}) {
  const names = nodes.map((n) => n.name);
  const [node, setNode] = useState(names[0] ?? "");
  const [target, setTarget] = useState(AUTO);
  const [plan, setPlan] = useState<DrainPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);

  // Only online nodes are valid drain targets (you can't push guests onto an
  // offline node). Per-guest storage eligibility is enforced by the drain planner.
  const others = nodes.filter((n) => n.online && n.name !== node).map((n) => n.name);

  function onNodeChange(v: string) {
    setNode(v);
    setPlan(null);
    if (v === target) setTarget(AUTO);
  }

  async function makePlan() {
    if (!node) return;
    setPlanning(true);
    setPlan(null);
    try {
      const body: { node: string; targetNode?: string } = { node };
      if (target !== AUTO) body.targetNode = target;
      const r = await api.post<DrainPlan>("/admin/balancer/drain", body);
      setPlan(r.data);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setPlanning(false);
    }
  }

  async function drain() {
    if (!plan || plan.moves.length === 0) return;
    setApplying(true);
    try {
      const r = await api.post<{ started: number }>("/admin/balancer/apply", {
        moves: plan.moves.map((m) => ({ vmId: m.vmId, toNode: m.toNode })),
      });
      toast.success(
        `Draining ${node} — started ${r.data.started} migration${r.data.started === 1 ? "" : "s"} in the background.`,
      );
      setPlan(null);
      onApplied();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Wrench className="size-4 text-muted-foreground" /> Maintenance mode (node drain)
        </CardTitle>
        <CardDescription>
          Evacuate a node before powering it down for maintenance. Running guests move{" "}
          <span className="font-medium text-foreground">live</span> (no downtime with shared storage);
          stopped guests move offline. Architecture and anti-affinity rules are honored.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <FormField label="Node to drain" htmlFor="drain-node">
            <Select value={node} onValueChange={(v) => onNodeChange(v as string)}>
              <SelectTrigger id="drain-node" className="w-full">
                <SelectValue placeholder="Select a node" />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((n) => (
                  <SelectItem key={n.name} value={n.name} disabled={!n.online}>
                    {n.name}
                    {n.online ? "" : " (offline)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Migrate to" htmlFor="drain-target">
            <Select value={target} onValueChange={(v) => setTarget(v as string)}>
              <SelectTrigger id="drain-target" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>Auto — best fit</SelectItem>
                {others.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <Button variant="outline" onClick={makePlan} disabled={planning || !node}>
            {planning ? <Loader2 className="animate-spin" /> : <HardDriveDownload />}
            Plan drain
          </Button>
        </div>

        {plan && (
          <div className="grid gap-3">
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2.5 text-sm">
              <ServerCog className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>{plan.reason}</span>
            </div>

            {plan.moves.length > 0 && (
              <ul className="grid gap-1.5">
                {plan.moves.map((m) => (
                  <li
                    key={m.vmId}
                    className="flex items-center justify-between gap-2 rounded-md border p-2.5 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-medium">
                        <span className="truncate">{m.name}</span>
                        <span className="text-xs font-normal text-muted-foreground">
                          #{m.proxmoxVmId}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {m.fromNode} <ArrowRight className="size-3" /> {m.toNode} ·{" "}
                        {formatBytes(m.memBytes)} RAM
                      </div>
                    </div>
                    <Badge variant={m.running ? "secondary" : "outline"} className="font-normal">
                      {m.running ? "live" : "offline"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}

            {plan.blockers.length > 0 && (
              <div className="grid gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="size-4 text-amber-500" />
                  {plan.blockers.length} guest{plan.blockers.length === 1 ? "" : "s"} can&apos;t be
                  auto-evacuated
                </div>
                <ul className="grid gap-0.5 text-xs text-muted-foreground">
                  {plan.blockers.map((b) => (
                    <li key={b.proxmoxVmId}>
                      <span className="font-medium text-foreground">{b.name}</span> (#{b.proxmoxVmId}) —{" "}
                      {b.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {plan.moves.length > 0 && (
              <div className="flex justify-end">
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button disabled={applying}>
                        {applying ? <Loader2 className="animate-spin" /> : <Wrench />}
                        Drain {node} ({plan.moves.length})
                      </Button>
                    }
                  />
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Drain {node}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This starts {plan.moves.length} migration
                        {plan.moves.length === 1 ? "" : "s"} off {node}
                        {plan.blockers.length > 0
                          ? `. ${plan.blockers.length} guest(s) still need to be handled manually before you power the node off.`
                          : ". Once they finish, the node has no ProxMate guests left and is safe to take down."}{" "}
                        Migrations run in the background and can take a few minutes.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={applying}>Cancel</AlertDialogCancel>
                      <Button onClick={drain} disabled={applying}>
                        {applying ? <Loader2 className="animate-spin" /> : <Wrench />}
                        Start drain
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
