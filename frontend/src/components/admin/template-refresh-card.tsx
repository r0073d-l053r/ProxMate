"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Admin toggle for the monthly cloud-image auto-refresh. When on, ProxMate
 * rebuilds every importer-built template from its source URL each month, so new
 * deploys always start from a patched base. Admins can still refresh any single
 * template on demand from the Template Store.
 */
export function TemplateRefreshCard() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<{ templateRefreshEnabled: boolean }>("/admin/settings")
      .then((r) => setEnabled(!!r.data.templateRefreshEnabled))
      .catch((err) => toast.error(apiError(err)))
      .finally(() => setLoading(false));
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    try {
      await api.put("/admin/settings/template-refresh", { enabled: next });
      setEnabled(next);
      toast.success(next ? "Monthly cloud-image refresh enabled." : "Monthly cloud-image refresh disabled.");
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
          <RefreshCw className="size-4 text-muted-foreground" />
          Cloud-image freshness
        </CardTitle>
        <CardDescription>
          Rebuild every cloud-image template from its source each month so new deploys start from a
          patched base. You can also refresh any single template on demand from the Template Store.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <label className="flex items-center gap-2 text-sm select-none">
          <input
            type="checkbox"
            checked={enabled}
            disabled={loading || saving}
            onChange={(e) => toggle(e.target.checked)}
            className="size-4 rounded border-input accent-primary"
          />
          Auto-refresh cloud-image templates monthly
        </label>
      </CardContent>
    </Card>
  );
}
