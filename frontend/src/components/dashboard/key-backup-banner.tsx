"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { KeyBackupStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";

/**
 * Admin-only warning that stays on every dashboard page until an admin confirms
 * ENCRYPTION_KEY has been backed up off this host. Every stored secret is
 * encrypted with it, so an app-database backup can't be restored without it.
 * The confirmation (who/when) is stored and audited on the server; a changed key
 * brings the warning back. The key itself is never fetched or shown.
 */
export function KeyBackupBanner() {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const [status, setStatus] = useState<KeyBackupStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    api
      .get<KeyBackupStatus>("/admin/encryption-key-backup")
      .then((r) => {
        if (active) setStatus(r.data);
      })
      .catch(() => {
        /* not reachable (or not an admin after all) — show nothing */
      });
    return () => {
      active = false;
    };
  }, [isAdmin]);

  if (!isAdmin || !status || status.confirmed) return null;

  async function confirm() {
    setSaving(true);
    try {
      const r = await api.post<KeyBackupStatus>("/admin/encryption-key-backup/confirm", {});
      setStatus(r.data);
      toast.success("Thanks — the ENCRYPTION_KEY backup is recorded.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {status.keyChanged
            ? "ENCRYPTION_KEY has changed since its backup was confirmed."
            : "Back up ENCRYPTION_KEY."}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          Every stored secret (the session signing secret, the Proxmox token, SMTP, two-factor and SSO
          secrets) is encrypted with
          the <code className="font-mono text-xs">ENCRYPTION_KEY</code> in this server&apos;s environment
          (<code className="font-mono text-xs">.env</code>). Without it, an app-database backup
          can&apos;t be restored. Copy it to a password manager or another safe place off this host.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 select-none">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="size-4 rounded border-input accent-primary"
            />
            I have stored a copy of ENCRYPTION_KEY off this host
          </label>
          <Button size="sm" variant="outline" onClick={confirm} disabled={!checked || saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Confirm backup
          </Button>
        </div>
      </div>
    </div>
  );
}
