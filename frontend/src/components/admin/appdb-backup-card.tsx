"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DatabaseBackup, Loader2, Save, HardDriveDownload } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { AdminSettings } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";

/**
 * Scheduled backups of ProxMate's OWN database. MateStates cover guest VMs;
 * this covers the users/VM records/config/encrypted secrets. Nightly snapshot
 * (VACUUM INTO, safe on the live DB) into a directory the admin points at an
 * off-host mount, with rolling retention.
 */
export function AppDbBackupCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const [dir, setDir] = useState("");
  const [keep, setKeep] = useState(7);

  useEffect(() => {
    api
      .get<AdminSettings>("/admin/settings")
      .then((r) => {
        if (r.data.appdbBackup) {
          setDir(r.data.appdbBackup.dir);
          setKeep(r.data.appdbBackup.keep);
        }
      })
      .catch((err) => toast.error(apiError(err)))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      await api.put("/admin/settings/appdb-backup", { dir: dir.trim(), keep });
      toast.success(dir.trim() ? "App-database backups configured." : "App-database backups disabled.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const r = await api.post<{ ok: boolean; file?: string; pruned?: number; error?: string }>(
        "/admin/settings/appdb-backup/run",
        {},
      );
      if (r.data.ok) {
        toast.success(`Snapshot written: ${r.data.file}${r.data.pruned ? ` (pruned ${r.data.pruned} old)` : ""}`);
      } else {
        toast.error(r.data.error ?? "Backup failed.");
      }
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseBackup className="size-4 text-muted-foreground" />
          App-database backups
        </CardTitle>
        <CardDescription>
          Nightly snapshot of ProxMate&apos;s own database (users, VM records, settings) — separate
          from MateStates, which back up the VMs themselves. Point the directory at an off-host
          mount (NFS/CIFS) so a dead host doesn&apos;t take the backups with it. Restoring also
          needs your <code className="font-mono text-xs">ENCRYPTION_KEY</code> — back that up
          separately.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
          <FormField label="Backup directory" hint="Absolute path inside the backend container/host. Empty = disabled.">
            <Input
              value={dir}
              disabled={loading}
              onChange={(e) => setDir(e.target.value)}
              placeholder="e.g. /backups/proxmate"
              className="font-mono"
            />
          </FormField>
          <FormField label="Keep" hint="Rolling snapshots">
            <Input
              type="number"
              min={1}
              max={365}
              value={keep}
              disabled={loading}
              onChange={(e) => setKeep(Math.max(1, Math.min(365, Number(e.target.value) || 7)))}
            />
          </FormField>
        </div>
        <div className="flex gap-2">
          <Button onClick={save} disabled={saving || loading}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Save
          </Button>
          <Button
            variant="outline"
            onClick={runNow}
            disabled={running || loading || !dir.trim()}
            title="Take a snapshot right now — proves the directory is writable"
          >
            {running ? <Loader2 className="animate-spin" /> : <HardDriveDownload />}
            Back up now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
