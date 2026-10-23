"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Camera, Loader2, Save } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { AdminSettings } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NumberInput } from "@/components/ui/number-input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";

const MAX_KEEP = 10;

/**
 * Admin settings for the automatic snapshot ProxMate takes of a VM before a
 * resize, a data-disk grow or a rescue boot, and how many of those to keep per
 * VM. Snapshots the users take themselves are never removed by this.
 */
export function AutoSnapshotCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [keep, setKeep] = useState(3);

  useEffect(() => {
    api
      .get<AdminSettings>("/admin/settings")
      .then((r) => {
        if (r.data.autoSnapshot) {
          setEnabled(r.data.autoSnapshot.enabled);
          setKeep(r.data.autoSnapshot.keep);
        }
      })
      .catch((err) => toast.error(apiError(err)))
      .finally(() => setLoading(false));
  }, []);

  const keepValid = Number.isInteger(keep) && keep >= 1 && keep <= MAX_KEEP;

  async function save() {
    setSaving(true);
    try {
      await api.put("/admin/settings/auto-snapshot", { enabled, keep });
      toast.success(enabled ? `Automatic snapshots on (keeping ${keep} per VM).` : "Automatic snapshots off.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="size-4 text-muted-foreground" />
          Automatic snapshots
        </CardTitle>
        <CardDescription>
          Before a VM is resized (CPU, memory or disk), has a data disk grown, or boots into rescue
          mode, ProxMate takes a snapshot named <code>pm-auto-…</code> so the change can be rolled back.
          If the snapshot can&apos;t be taken, the change is refused; a VM whose storage doesn&apos;t
          support snapshots goes ahead without one, and the user is told. Containers are skipped.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <label className="flex items-center gap-2 text-sm select-none">
          <input
            type="checkbox"
            checked={enabled}
            disabled={loading || saving}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 rounded border-input accent-primary"
          />
          Take a snapshot before risky changes
        </label>
        <FormField
          label="Automatic snapshots kept per VM"
          htmlFor="auto-snap-keep"
          error={keepValid ? undefined : `Between 1 and ${MAX_KEEP}.`}
        >
          <NumberInput
            id="auto-snap-keep"
            min={1}
            max={MAX_KEEP}
            value={keep}
            disabled={loading || saving || !enabled}
            onValueChange={setKeep}
            className="w-28"
          />
        </FormField>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>Only the oldest automatic snapshots are removed to stay at this number — never one a user took.</li>
          <li>They count toward the 12-snapshot limit per VM and use space on the VM&apos;s storage.</li>
          <li>
            A rebuild isn&apos;t covered: it deletes the VM together with all of its snapshots, so take a
            backup first.
          </li>
          <li>On local (non-shared) storage, a VM with snapshots may not live-migrate.</li>
        </ul>
        <div>
          <Button onClick={save} disabled={loading || saving || !keepValid}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
