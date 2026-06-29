"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { DatabaseBackup, Loader2, Save } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { BackupPolicy } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Freq = "default" | "daily" | "weekly" | "monthly";

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DEFAULT_KEEP = 2;

const pad = (n: number) => String(n).padStart(2, "0");

/** Build a 5-field cron from the chosen frequency. */
function buildCron(freq: Freq, time: string, dow: number, dom: number): string | null {
  if (freq === "default") return null;
  const [h, m] = time.split(":").map(Number);
  const mm = m ?? 0;
  const hh = h ?? 0;
  if (freq === "daily") return `${mm} ${hh} * * *`;
  if (freq === "weekly") return `${mm} ${hh} * * ${dow}`;
  return `${mm} ${hh} ${dom} * *`; // monthly
}

/** Parse our own cron shapes back into the form state (best-effort). */
function parseCron(cron: string | null): { freq: Freq; time: string; dow: number; dom: number } | null {
  if (!cron) return { freq: "default", time: "03:00", dow: 0, dom: 1 };
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return null;
  const [min, hour, d, mon, w] = p;
  if (!/^\d+$/.test(min!) || !/^\d+$/.test(hour!) || mon !== "*") return null;
  const time = `${pad(Number(hour))}:${pad(Number(min))}`;
  if (d === "*" && w === "*") return { freq: "daily", time, dow: 0, dom: 1 };
  if (d === "*" && /^[0-6]$/.test(w!)) return { freq: "weekly", time, dow: Number(w), dom: 1 };
  if (/^\d+$/.test(d!) && w === "*") return { freq: "monthly", time, dow: 0, dom: Number(d) };
  return null;
}

/**
 * Per-VM backup policy: how often a MateState is taken and how many are kept.
 * "Cluster default" leaves the VM under the cluster-wide weekly backup; any other
 * frequency gives it its own schedule + retention. Times use the server's timezone.
 */
export function BackupPolicyPanel({ vmId }: { vmId: string }) {
  // Backup *retention* (how many to keep) is an admin-only control — regular users
  // always get the cluster default of two. The backend enforces this too.
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const [freq, setFreq] = useState<Freq>("default");
  const [time, setTime] = useState("03:00");
  const [dow, setDow] = useState(0);
  const [dom, setDom] = useState(1);
  const [keep, setKeep] = useState(DEFAULT_KEEP);

  const load = useCallback(async () => {
    try {
      const res = await api.get<BackupPolicy>(`/vms/${vmId}/backup-policy`);
      const parsed = parseCron(res.data.backupCron);
      if (parsed) {
        setFreq(parsed.freq);
        setTime(parsed.time);
        setDow(parsed.dow);
        setDom(parsed.dom);
      }
      if (res.data.backupKeep) setKeep(res.data.backupKeep);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoaded(true);
    }
  }, [vmId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      const backupCron = buildCron(freq, time, dow, dom);
      await api.put(`/vms/${vmId}/backup-policy`, {
        backupCron,
        // Only admins set retention; users always fall back to the default (2).
        backupKeep: backupCron && isAdmin ? keep : null,
      });
      toast.success("Backup policy saved.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  const custom = freq !== "default";
  const FREQS: { key: Freq; label: string }[] = [
    { key: "default", label: "Cluster default" },
    { key: "daily", label: "Daily" },
    { key: "weekly", label: "Weekly" },
    { key: "monthly", label: "Monthly" },
  ];

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <DatabaseBackup className="size-4 text-muted-foreground" />
          Backup policy
        </CardTitle>
        <CardDescription>
          How often this VM is backed up (a MateState) and how many are kept.{" "}
          <span className="font-medium text-foreground">Cluster default</span> leaves it under the
          weekly cluster-wide backup. Times use the server&apos;s timezone.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!loaded ? (
          <p className="py-2 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {FREQS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFreq(f.key)}
                  aria-pressed={freq === f.key}
                  className={
                    "rounded-md border px-3 py-1.5 text-sm transition-colors " +
                    (freq === f.key ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")
                  }
                >
                  {f.label}
                </button>
              ))}
            </div>

            {custom && (
              <div className="grid gap-3 rounded-md border p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <label className="text-xs text-muted-foreground" htmlFor="bk-time">At</label>
                    <Input id="bk-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-32" />
                  </div>
                  <div className="grid gap-1.5">
                    <label className="text-xs text-muted-foreground" htmlFor="bk-keep">Keep (most recent)</label>
                    {isAdmin ? (
                      <Input
                        id="bk-keep"
                        type="number"
                        min={1}
                        max={14}
                        value={keep}
                        onChange={(e) => setKeep(Math.min(14, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
                        className="w-24"
                      />
                    ) : (
                      <p className="flex h-9 items-center text-sm text-muted-foreground">
                        {DEFAULT_KEEP} <span className="ml-1 text-xs">· set by your administrator</span>
                      </p>
                    )}
                  </div>
                </div>

                {freq === "weekly" && (
                  <div className="grid gap-1.5">
                    <span className="text-xs text-muted-foreground">On</span>
                    <div className="flex flex-wrap gap-1">
                      {DAYS.map((label, d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setDow(d)}
                          aria-pressed={dow === d}
                          className={
                            "size-8 rounded-md border text-xs transition-colors " +
                            (dow === d ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {freq === "monthly" && (
                  <div className="grid gap-1.5">
                    <label className="text-xs text-muted-foreground" htmlFor="bk-dom">Day of month</label>
                    <Input
                      id="bk-dom"
                      type="number"
                      min={1}
                      max={28}
                      value={dom}
                      onChange={(e) => setDom(Math.min(28, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
                      className="w-24"
                    />
                  </div>
                )}
              </div>
            )}

            <div>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />}
                Save policy
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
