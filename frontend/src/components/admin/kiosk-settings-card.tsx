"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { MonitorPlay, Loader2, Save, ShieldCheck, ShieldOff } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { AdminSettings } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";

/**
 * Kiosk-mode exit lock. Kiosk mode is a full-screen, unattended admin panel; this
 * PIN (or the admin's passkey) is required to leave it, so a passer-by can't tap
 * out into the full console. The PIN value is write-only — the server only ever
 * reports whether one is set.
 */
export function KioskSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pinSet, setPinSet] = useState(false);
  const [pin, setPin] = useState("");

  useEffect(() => {
    api
      .get<AdminSettings>("/admin/settings")
      .then((r) => setPinSet(!!r.data.kiosk?.pinSet))
      .catch((err) => toast.error(apiError(err)))
      .finally(() => setLoading(false));
  }, []);

  const digits = pin.replace(/\D/g, "");
  const canSave = digits.length >= 4 && digits.length <= 12;

  async function save() {
    setSaving(true);
    try {
      await api.put("/admin/settings/kiosk", { pin: digits });
      setPinSet(true);
      setPin("");
      toast.success("Kiosk exit PIN set.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  async function clearPin() {
    setSaving(true);
    try {
      await api.put("/admin/settings/kiosk", { pin: "" });
      setPinSet(false);
      setPin("");
      toast.success("Kiosk exit PIN cleared.");
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
          <MonitorPlay className="size-4 text-muted-foreground" />
          Kiosk mode
        </CardTitle>
        <CardDescription>
          Kiosk mode is a full-screen wall panel. Leaving it requires re-authentication so someone
          walking past can&apos;t tap out into the admin console. Unlock with a <strong>passkey</strong>
          {" "}(register one under <span className="whitespace-nowrap">Security → Passkeys</span>) or the
          exit <strong>PIN</strong> below. Your account password always works as a fallback, so you can
          never be locked out of your own panel.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div
          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
            pinSet ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
          }`}
        >
          {pinSet ? <ShieldCheck className="size-4" /> : <ShieldOff className="size-4" />}
          {loading ? "Loading…" : pinSet ? "An exit PIN is set." : "No exit PIN set (passkey/password still work)."}
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <FormField label={pinSet ? "Change PIN" : "Set PIN"} hint="4–12 digits">
            <Input
              value={pin}
              disabled={loading}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))}
              placeholder="••••"
              inputMode="numeric"
              autoComplete="off"
              type="password"
              className="font-mono tracking-widest"
            />
          </FormField>
          <div className="flex gap-2">
            <Button onClick={save} disabled={saving || loading || !canSave}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              {pinSet ? "Update" : "Set PIN"}
            </Button>
            {pinSet && (
              <Button variant="outline" onClick={clearPin} disabled={saving || loading}>
                Clear
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
