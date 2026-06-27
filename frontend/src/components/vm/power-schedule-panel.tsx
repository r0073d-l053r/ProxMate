"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Clock, Loader2, Play, Power, Save } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { PowerSchedule } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const pad = (n: number) => String(n).padStart(2, "0");

/** Build `m h * * dow` from a HH:MM time + selected weekday numbers. */
function buildCron(time: string, days: number[]): string {
  const [h, m] = time.split(":").map(Number);
  const dow = days.length === 7 ? "*" : [...days].sort((a, b) => a - b).join(",");
  return `${m ?? 0} ${h ?? 0} * * ${dow}`;
}

/** Parse our own `m h * * dow` shape back into a time + day set (null if it's not that shape). */
function parseCron(cron: string | null): { time: string; days: number[] } | null {
  if (!cron) return null;
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return null;
  const [min, hour, dom, mon, dow] = p;
  if (!/^\d+$/.test(min!) || !/^\d+$/.test(hour!) || dom !== "*" || mon !== "*") return null;
  let days: number[];
  if (dow === "*") days = ALL_DAYS;
  else if (/^[0-6](,[0-6])*$/.test(dow!)) days = dow!.split(",").map(Number);
  else return null;
  return { time: `${pad(Number(hour))}:${pad(Number(min))}`, days };
}

function summarize(time: string, days: number[]): string {
  const when =
    days.length === 7
      ? "every day"
      : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))
        ? "on weekdays"
        : `on ${[...days].sort((a, b) => a - b).map((d) => DAYS[d]).join(", ")}`;
  return `${time} ${when}`;
}

function DayPicker({ days, onToggle }: { days: number[]; onToggle: (d: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {DAYS.map((label, d) => (
        <button
          key={d}
          type="button"
          onClick={() => onToggle(d)}
          aria-pressed={days.includes(d)}
          className={
            "size-8 rounded-md border text-xs transition-colors " +
            (days.includes(d) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Per-VM auto start/stop schedule. A simple "at HH:MM on these days" builder for
 * each action; the panel sends 5-field cron strings the backend's per-minute tick
 * evaluates. Times are the server's timezone.
 */
export function PowerSchedulePanel({ vmId }: { vmId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const [startOn, setStartOn] = useState(false);
  const [startTime, setStartTime] = useState("08:00");
  const [startDays, setStartDays] = useState<number[]>(ALL_DAYS);

  const [stopOn, setStopOn] = useState(false);
  const [stopTime, setStopTime] = useState("00:00");
  const [stopDays, setStopDays] = useState<number[]>(ALL_DAYS);

  const load = useCallback(async () => {
    try {
      const res = await api.get<PowerSchedule>(`/vms/${vmId}/schedule`);
      const s = parseCron(res.data.startCron);
      if (s) {
        setStartOn(true);
        setStartTime(s.time);
        setStartDays(s.days);
      }
      const e = parseCron(res.data.stopCron);
      if (e) {
        setStopOn(true);
        setStopTime(e.time);
        setStopDays(e.days);
      }
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoaded(true);
    }
  }, [vmId]);

  useEffect(() => {
    load();
  }, [load]);

  function toggleDay(set: (f: (d: number[]) => number[]) => void, day: number) {
    set((d) => (d.includes(day) ? d.filter((x) => x !== day) : [...d, day]));
  }

  async function save() {
    if (startOn && startDays.length === 0) return toast.error("Pick at least one day to auto-start.");
    if (stopOn && stopDays.length === 0) return toast.error("Pick at least one day to auto-stop.");
    setSaving(true);
    try {
      await api.put(`/vms/${vmId}/schedule`, {
        startCron: startOn ? buildCron(startTime, startDays) : null,
        stopCron: stopOn ? buildCron(stopTime, stopDays) : null,
      });
      toast.success("Schedule saved.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Clock className="size-4 text-muted-foreground" />
          Power schedule
        </CardTitle>
        <CardDescription>
          Automatically start and stop this VM on a schedule — handy for dev boxes that don&apos;t
          need to run overnight. Times use the server&apos;s timezone.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!loaded ? (
          <p className="py-2 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {/* Auto-start */}
            <div className="grid gap-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={startOn} onChange={(e) => setStartOn(e.target.checked)} />
                <Play className="size-4 text-emerald-500" /> Auto-start
              </label>
              {startOn && (
                <div className="grid gap-2 pl-6">
                  <Input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-32"
                  />
                  <DayPicker days={startDays} onToggle={(d) => toggleDay(setStartDays, d)} />
                  <p className="text-xs text-muted-foreground">Starts at {summarize(startTime, startDays)}.</p>
                </div>
              )}
            </div>

            {/* Auto-stop */}
            <div className="grid gap-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={stopOn} onChange={(e) => setStopOn(e.target.checked)} />
                <Power className="size-4 text-amber-500" /> Auto-stop
              </label>
              {stopOn && (
                <div className="grid gap-2 pl-6">
                  <Input
                    type="time"
                    value={stopTime}
                    onChange={(e) => setStopTime(e.target.value)}
                    className="w-32"
                  />
                  <DayPicker days={stopDays} onToggle={(d) => toggleDay(setStopDays, d)} />
                  <p className="text-xs text-muted-foreground">
                    Gracefully shuts down at {summarize(stopTime, stopDays)}.
                  </p>
                </div>
              )}
            </div>

            <div>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />}
                Save schedule
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
