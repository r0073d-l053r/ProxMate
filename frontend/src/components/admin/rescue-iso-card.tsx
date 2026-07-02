"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { LifeBuoy, Loader2, Save } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { ProxmoxIso } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE = "__none__";

/**
 * Admin picker for the cluster's rescue ISO — the image tenants' "Boot into
 * rescue" (VM Settings → Recovery) attaches. A live-CD style ISO such as
 * SystemRescue works best.
 */
export function RescueIsoCard() {
  const [isos, setIsos] = useState<ProxmoxIso[]>([]);
  const [value, setValue] = useState<string>(NONE);
  const [initial, setInitial] = useState<string>(NONE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<{ rescueIso: string | null }>("/admin/settings"),
      api.get<ProxmoxIso[]>("/proxmox/isos").catch(() => ({ data: [] as ProxmoxIso[] })),
    ])
      .then(([settings, isoRes]) => {
        setIsos(isoRes.data);
        const current = settings.data.rescueIso || NONE;
        setValue(current);
        setInitial(current);
      })
      .catch((err) => toast.error(apiError(err)))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      await api.put("/admin/settings/rescue", { iso: value === NONE ? "" : value });
      setInitial(value);
      toast.success(value === NONE ? "Rescue ISO cleared." : "Rescue ISO saved.");
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
          <LifeBuoy className="size-4 text-muted-foreground" />
          Rescue ISO
        </CardTitle>
        <CardDescription>
          The image &quot;Boot into rescue&quot; (VM Settings → Recovery) starts from — pick a live-CD
          style ISO like SystemRescue. Users can&apos;t enter rescue mode until one is set.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Select value={value} onValueChange={(v) => setValue(v as string)}>
          <SelectTrigger className="w-full sm:max-w-md">
            <SelectValue placeholder={loading ? "Loading ISOs…" : "Choose an ISO"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None (rescue mode disabled)</SelectItem>
            {isos.map((iso) => (
              <SelectItem key={iso.volid} value={iso.volid}>
                {iso.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={save} disabled={saving || loading || value === initial}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} Save
        </Button>
      </CardContent>
    </Card>
  );
}
