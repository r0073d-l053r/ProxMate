"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Bell, BellPlus, Loader2, Trash2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { AlertRule, AlertMetric } from "@/lib/types";
import { formatRelative } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const METRIC_LABEL: Record<AlertMetric, string> = {
  cpu: "CPU usage",
  memory: "Memory usage",
  disk: "Disk usage",
  down: "Unexpectedly stops",
};

/** Human one-liner describing a saved rule. */
function ruleSummary(r: AlertRule): string {
  if (r.metric === "down") return `Alert me if this machine unexpectedly stops for ${r.sustainedMin} min`;
  return `Alert me if ${METRIC_LABEL[r.metric].toLowerCase()} stays at or above ${r.threshold}% for ${r.sustainedMin} min`;
}

/**
 * Per-VM resource alerts (DigitalOcean-style Monitoring alerts). Owner/co-owner
 * sets thresholds; the backend evaluates them on its sampling tick and emails
 * the owner when one trips. Disk alerts need the guest agent.
 */
export function AlertsPanel({ vmId, canWrite }: { vmId: string; canWrite: boolean }) {
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [metric, setMetric] = useState<AlertMetric>("cpu");
  const [threshold, setThreshold] = useState(85);
  const [sustainedMin, setSustainedMin] = useState(10);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<AlertRule[]>(`/vms/${vmId}/alerts`)
      .then((res) => setRules(res.data))
      .catch((err) => toast.error(apiError(err)));
  }, [vmId]);

  useEffect(load, [load]);

  async function add() {
    setSaving(true);
    try {
      const body =
        metric === "down"
          ? { metric, sustainedMin }
          : { metric, threshold, sustainedMin };
      await api.post(`/vms/${vmId}/alerts`, body);
      toast.success("Alert added.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setBusyId(id);
    try {
      await api.delete(`/vms/${vmId}/alerts/${id}`);
      setRules((rs) => (rs ?? []).filter((r) => r.id !== id));
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusyId(null);
    }
  }

  const needsThreshold = metric !== "down";

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Bell className="size-4 text-muted-foreground" />
          Alerts
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rules === null ? (
          <p className="py-2 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No alerts yet. Get an email if this machine runs hot, fills its disk, or unexpectedly stops.
          </p>
        ) : (
          <ul className="divide-y">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p>{ruleSummary(r)}</p>
                  {r.lastFiredAt && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Last triggered {formatRelative(r.lastFiredAt)}
                    </p>
                  )}
                </div>
                {canWrite && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busyId === r.id}
                    onClick={() => remove(r.id)}
                    aria-label="Remove alert"
                    title="Remove alert"
                  >
                    {busyId === r.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canWrite && (
          <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
            <FormField label="When" htmlFor="al-metric" className="w-40">
              <Select value={metric} onValueChange={(v) => setMetric(v as AlertMetric)}>
                <SelectTrigger id="al-metric" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cpu">CPU usage</SelectItem>
                  <SelectItem value="memory">Memory usage</SelectItem>
                  <SelectItem value="disk">Disk usage</SelectItem>
                  <SelectItem value="down">Unexpectedly stops</SelectItem>
                </SelectContent>
              </Select>
            </FormField>

            {needsThreshold && (
              <FormField label="At or above (%)" htmlFor="al-threshold" className="w-32">
                <Input
                  id="al-threshold"
                  type="number"
                  min={1}
                  max={100}
                  value={threshold}
                  onChange={(e) => setThreshold(Math.min(100, Math.max(1, Math.floor(Number(e.target.value) || 0))))}
                />
              </FormField>
            )}

            <FormField label="For (min)" htmlFor="al-sustained" className="w-28">
              <Input
                id="al-sustained"
                type="number"
                min={1}
                max={1440}
                value={sustainedMin}
                onChange={(e) => setSustainedMin(Math.min(1440, Math.max(1, Math.floor(Number(e.target.value) || 0))))}
              />
            </FormField>

            <Button onClick={add} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <BellPlus />} Add alert
            </Button>
          </div>
        )}
        {canWrite && (
          <p className="mt-2 text-xs text-muted-foreground">
            Checked every ~5 minutes; you&apos;ll get an email (and your admin&apos;s webhook, if set) when a
            threshold holds for the chosen time. Disk alerts need the guest agent installed.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
