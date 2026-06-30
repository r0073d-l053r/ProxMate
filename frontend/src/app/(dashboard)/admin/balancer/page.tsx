"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Scale,
  RefreshCw,
  Loader2,
  Save,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Wand2,
} from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { BalancerResponse, BalancerMode, BalancePlan } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { FormField } from "@/components/form-field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MODE_LABEL: Record<BalancerMode, string> = {
  off: "Off",
  recommend: "Recommend only",
  auto: "Auto-apply",
};

/** Bar colour by memory-load band: comfortable / warm / hot. */
function loadColor(pct: number): string {
  if (pct >= 85) return "bg-destructive";
  if (pct >= 65) return "bg-amber-500";
  return "bg-primary";
}

export default function BalancerPage() {
  const [data, setData] = useState<BalancerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);

  // Settings form (seeded from the server each load).
  const [mode, setMode] = useState<BalancerMode>("off");
  const [thresholdPct, setThresholdPct] = useState(15);
  const [maxMoves, setMaxMoves] = useState(5);
  const [excludeText, setExcludeText] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const seed = useCallback((res: BalancerResponse) => {
    setData(res);
    setMode(res.settings.mode);
    setThresholdPct(res.settings.thresholdPct);
    setMaxMoves(res.settings.maxMoves);
    setExcludeText(res.settings.exclude.join(", "));
    setSelected(new Set(res.plan?.moves.map((m) => m.vmId) ?? []));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<BalancerResponse>("/admin/balancer")
      .then((r) => seed(r.data))
      .catch((e) => toast.error(apiError(e)))
      .finally(() => setLoading(false));
  }, [seed]);

  useEffect(load, [load]);

  function parseExclude(): number[] {
    return [
      ...new Set(
        excludeText
          .split(",")
          .map((s) => Math.floor(Number(s.trim())))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    ];
  }

  async function saveSettings() {
    setSaving(true);
    try {
      const r = await api.put<BalancerResponse>("/admin/balancer", {
        mode,
        thresholdPct,
        maxMoves,
        exclude: parseExclude(),
      });
      seed(r.data);
      toast.success("Balancer settings saved.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  async function apply() {
    const plan = data?.plan;
    if (!plan) return;
    const moves = plan.moves
      .filter((m) => selected.has(m.vmId))
      .map((m) => ({ vmId: m.vmId, toNode: m.toNode }));
    if (moves.length === 0) {
      toast.error("Select at least one migration to apply.");
      return;
    }
    setApplying(true);
    try {
      const r = await api.post<{ started: number }>("/admin/balancer/apply", { moves });
      toast.success(
        `Started ${r.data.started} migration${r.data.started === 1 ? "" : "s"} — they run in the background and can take a few minutes.`,
      );
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setApplying(false);
    }
  }

  const plan = data?.plan ?? null;
  const dirty =
    data != null &&
    (mode !== data.settings.mode ||
      thresholdPct !== data.settings.thresholdPct ||
      maxMoves !== data.settings.maxMoves ||
      parseExclude().join(",") !== data.settings.exclude.join(","));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Cluster Balancer"
        description="Even out node memory load by live-migrating ProxMate-managed guests — DRS-style, with architecture and anti-affinity guardrails."
      >
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : ""} /> Recompute
        </Button>
      </PageHeader>

      {/* ── Settings ───────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Scale className="size-4 text-muted-foreground" /> Policy
          </CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground">Off</span> disables balancing.{" "}
            <span className="font-medium text-foreground">Recommend only</span> surfaces a plan you
            apply by hand. <span className="font-medium text-foreground">Auto-apply</span> migrates
            automatically every ~15 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid items-start gap-3 sm:grid-cols-3">
            <FormField label="Mode" htmlFor="b-mode">
              <Select value={mode} onValueChange={(v) => setMode(v as BalancerMode)}>
                <SelectTrigger id="b-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["off", "recommend", "auto"] as BalancerMode[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {MODE_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label="Imbalance tolerance (%)"
              htmlFor="b-threshold"
              hint="Act when node load spread exceeds this"
            >
              <Input
                id="b-threshold"
                type="number"
                min={5}
                max={50}
                value={thresholdPct}
                onChange={(e) =>
                  setThresholdPct(Math.min(50, Math.max(5, Math.floor(Number(e.target.value) || 0))))
                }
              />
            </FormField>
            <FormField
              label="Max moves / run"
              htmlFor="b-maxmoves"
              hint="Cap migrations per pass"
            >
              <Input
                id="b-maxmoves"
                type="number"
                min={1}
                max={20}
                value={maxMoves}
                onChange={(e) =>
                  setMaxMoves(Math.min(20, Math.max(1, Math.floor(Number(e.target.value) || 0))))
                }
              />
            </FormField>
          </div>
          <FormField
            label="Never move (VMIDs)"
            htmlFor="b-exclude"
            hint="Comma-separated. You can also tag a VM 'pin' or 'no-balance'."
          >
            <Input
              id="b-exclude"
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
              placeholder="e.g. 100, 142"
            />
          </FormField>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Anti-affinity: tag guests <code className="rounded bg-muted px-1">aa:&lt;group&gt;</code> to
              keep group members on separate nodes.
            </p>
            <Button onClick={saveSettings} disabled={saving || !dirty}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              Save policy
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Plan ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Wand2 className="size-4 text-muted-foreground" /> Cluster load &amp; plan
          </CardTitle>
          {plan && (
            <CardDescription>
              Memory-load spread:{" "}
              <span className="font-medium text-foreground">{plan.currentSpreadPct}%</span>
              {plan.moves.length > 0 && (
                <>
                  {" "}
                  → <span className="font-medium text-foreground">{plan.projectedSpreadPct}%</span> after
                  the plan
                </>
              )}{" "}
              · tolerance {plan.thresholdPct}%
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="grid gap-4">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : !plan ? (
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <AlertTriangle className="size-4 text-destructive" />
              {data?.error ?? "Couldn't reach the cluster to compute a plan."}
            </div>
          ) : (
            <>
              <NodeLoads plan={plan} />

              {mode === "off" ? (
                <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                  Balancer is <span className="font-medium text-foreground">off</span>. Switch to{" "}
                  <span className="font-medium text-foreground">Recommend only</span> or{" "}
                  <span className="font-medium text-foreground">Auto-apply</span> above to act on the
                  load above.
                </p>
              ) : plan.balanced && plan.moves.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
                  <CheckCircle2 className="size-4 text-primary" />
                  {plan.reason}
                </div>
              ) : plan.moves.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                  <AlertTriangle className="size-4 text-amber-500" />
                  {plan.reason}
                </div>
              ) : (
                <MovePlan
                  plan={plan}
                  mode={mode}
                  selected={selected}
                  setSelected={setSelected}
                  applying={applying}
                  onApply={apply}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Per-node memory-load bars (+ CPU and movable-guest count for context). */
function NodeLoads({ plan }: { plan: BalancePlan }) {
  return (
    <ul className="grid gap-2.5">
      {plan.nodes.map((n) => (
        <li key={n.name} className="grid gap-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2">
              <span className="font-medium">{n.name}</span>
              <Badge variant="outline" className="font-normal">
                {n.arch}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {n.vmCount} movable · CPU {n.cpuPct}%
              </span>
            </span>
            <span className="tabular-nums text-muted-foreground">
              {formatBytes(n.memUsed)} / {formatBytes(n.memTotal)} ·{" "}
              <span className="font-medium text-foreground">{n.loadPct}%</span>
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all ${loadColor(n.loadPct)}`}
              style={{ width: `${Math.min(100, n.loadPct)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The recommended migrations with per-move selection and an apply action. */
function MovePlan({
  plan,
  mode,
  selected,
  setSelected,
  applying,
  onApply,
}: {
  plan: BalancePlan;
  mode: BalancerMode;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  applying: boolean;
  onApply: () => void;
}) {
  const allSelected = plan.moves.every((m) => selected.has(m.vmId));

  function toggle(vmId: string) {
    const next = new Set(selected);
    if (next.has(vmId)) next.delete(vmId);
    else next.add(vmId);
    setSelected(next);
  }

  return (
    <div className="grid gap-3">
      {mode === "auto" && (
        <p className="rounded-md border border-primary/40 bg-primary/5 p-2.5 text-xs text-muted-foreground">
          Auto-apply is on — these migrations run automatically on the next pass. You can also apply
          them now.
        </p>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {plan.moves.length} recommended migration{plan.moves.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className="text-xs text-primary hover:underline"
          onClick={() =>
            setSelected(allSelected ? new Set() : new Set(plan.moves.map((m) => m.vmId)))
          }
        >
          {allSelected ? "Clear all" : "Select all"}
        </button>
      </div>

      <ul className="grid gap-1.5">
        {plan.moves.map((m) => (
          <li
            key={m.vmId}
            className="flex items-center gap-3 rounded-md border p-2.5 text-sm"
          >
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={selected.has(m.vmId)}
              onChange={() => toggle(m.vmId)}
              aria-label={`Select migration for ${m.name}`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 font-medium">
                <span className="truncate">{m.name}</span>
                <span className="text-xs font-normal text-muted-foreground">#{m.proxmoxVmId}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {m.fromNode} <ArrowRight className="size-3" /> {m.toNode} · {formatBytes(m.memBytes)} RAM
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex justify-end">
        <Button onClick={onApply} disabled={applying || selected.size === 0}>
          {applying ? <Loader2 className="animate-spin" /> : <Wand2 />}
          Apply {selected.size > 0 ? `${selected.size} ` : ""}migration{selected.size === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}
