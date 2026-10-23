"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Loader2, Send } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Admin switch for the weekly per-tenant usage digest. Each user still opts in
 * from their own Security page (off by default); this turns the digest off for
 * everyone. "Send me a preview" emails the admin their OWN digest — it never
 * mails a tenant — so the format and SMTP delivery can be checked.
 */
export function UsageDigestCard() {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    api
      .get<{ usageDigestEnabled?: boolean }>("/admin/settings")
      .then((r) => setEnabled(r.data.usageDigestEnabled !== false))
      .catch((err) => toast.error(apiError(err)))
      .finally(() => setLoading(false));
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    try {
      await api.put("/admin/settings/usage-digest", { enabled: next });
      setEnabled(next);
      toast.success(next ? "Weekly usage digest enabled." : "Weekly usage digest disabled for everyone.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  async function preview() {
    setPreviewing(true);
    try {
      const r = await api.post<{ ok: boolean; to: string }>("/admin/settings/usage-digest/preview");
      toast.success(`Preview sent to ${r.data.to}.`);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-4" /> Weekly usage digest
        </CardTitle>
        <CardDescription>
          A weekly email to each user who opts in on their Security page: their machines, running time,
          average CPU and memory, and quota in use. Only their own machines, never anyone else&rsquo;s. Sent
          Mondays at 08:00 server time (UTC in Docker; USAGE_DIGEST_CRON); needs SMTP.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <label className="flex items-center gap-2 text-sm select-none">
          <input
            type="checkbox"
            checked={enabled}
            disabled={loading || saving}
            onChange={(e) => toggle(e.target.checked)}
            className="size-4 rounded border-input accent-primary"
          />
          Send the weekly digest to users who opted in
        </label>
        <div>
          <Button type="button" variant="outline" onClick={preview} disabled={previewing}>
            {previewing ? <Loader2 className="animate-spin" /> : <Send />}
            Send me a preview
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
