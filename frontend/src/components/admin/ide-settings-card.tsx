"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Code2, Loader2, Plus, Save, Trash2, PlugZap } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { AdminSettings, IdeLocalModel, IdeTier, ModelVisibility, IdeLlmKey } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TIER_OPTIONS: Array<{ value: IdeTier; label: string; hint: string }> = [
  { value: "off", label: "Off", hint: "Nobody can open the IDE." },
  { value: "admin", label: "Admins only", hint: "Keep the IDE to yourself." },
  { value: "tenants", label: "Admins + tenants", hint: "Everyone with a VM can open the IDE on it." },
];

const VISIBILITY_OPTIONS: Array<{ value: ModelVisibility; label: string }> = [
  { value: "admin", label: "Admin only" },
  { value: "shared", label: "Shared with tenants" },
  { value: "none", label: "None (hidden)" },
];

/**
 * Admin policy for ProxMate IDE. Local models are sourced from the admin's own
 * saved AI keys (Security → AI keys): pick a source, Test to list its models,
 * choose one, and set who may use it (admin-only / shared / none). Tenants never
 * see the source endpoint or key — the gateway resolves it per request.
 */
export function IdeSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState<IdeTier>("off");
  const [allowByoKeys, setAllowByoKeys] = useState(false);
  const [models, setModels] = useState<IdeLocalModel[]>([]);
  const [sources, setSources] = useState<IdeLlmKey[]>([]);
  // model ids reachable at each source key's endpoint, filled in on "Test".
  const [modelsByKey, setModelsByKey] = useState<Record<string, string[]>>({});
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<AdminSettings>("/admin/settings").then((r) => {
        const ide = r.data.ide;
        if (!ide) return;
        setEnabled(ide.enabled);
        setAllowByoKeys(ide.allowByoKeys);
        setModels(ide.localModels ?? []);
      }),
      api.get<IdeLlmKey[]>("/admin/ide/sources").then((r) => setSources(r.data)),
    ])
      .catch((err) => toast.error(apiError(err)))
      .finally(() => setLoading(false));
  }, []);

  function updateModel(i: number, patch: Partial<IdeLocalModel>) {
    setModels((rows) => rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function addModel() {
    setModels((rows) => [...rows, { model: "", sourceKeyId: sources[0]?.id ?? "", visibility: "none" }]);
  }
  function removeModel(i: number) {
    setModels((rows) => rows.filter((_, idx) => idx !== i));
  }

  async function testSource(keyId: string) {
    if (!keyId) return;
    setTesting(keyId);
    try {
      const r = await api.post<{ ok: boolean; models: string[]; error?: string }>("/admin/ide/test-source", { keyId });
      if (r.data.ok) {
        setModelsByKey((m) => ({ ...m, [keyId]: r.data.models }));
        toast.success(`Connected — ${r.data.models.length} model${r.data.models.length === 1 ? "" : "s"} found.`);
      } else {
        toast.error(`Couldn't reach that endpoint: ${r.data.error ?? "unreachable"}`);
      }
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setTesting(null);
    }
  }

  async function save() {
    const clean = models
      .filter((m) => m.model.trim() && m.sourceKeyId)
      .map((m) => ({
        ...(m.id ? { id: m.id } : {}),
        nickname: m.nickname?.trim() || undefined,
        model: m.model.trim(),
        sourceKeyId: m.sourceKeyId,
        visibility: m.visibility,
      }));
    setSaving(true);
    try {
      await api.put("/admin/settings/ide", { enabled, allowByoKeys, localModels: clean });
      setModels(clean);
      toast.success("ProxMate IDE settings saved.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  const tierHint = TIER_OPTIONS.find((t) => t.value === enabled)?.hint;
  const sourceLabel = (id: string) => sources.find((s) => s.id === id)?.label ?? "(pick a source)";

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Code2 className="size-4 text-muted-foreground" />
          ProxMate IDE
        </CardTitle>
        <CardDescription>
          A browser IDE (VS Code-style, with the OpenCode AI assistant built in) that opens inside a
          VM. Control who can use it and which local models it may talk to.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Availability" hint={tierHint}>
            <Select value={enabled} onValueChange={(v) => setEnabled(v as IdeTier)}>
              <SelectTrigger className="w-full" disabled={loading}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIER_OPTIONS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <div className="flex items-end pb-1">
            <label className="flex items-start gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={allowByoKeys}
                disabled={loading}
                onChange={(e) => setAllowByoKeys(e.target.checked)}
                className="mt-0.5 size-4 rounded border-input accent-primary"
              />
              <span>
                Let tenants bring their own AI keys — each user can plug their personal LLM API keys
                into their IDE.
              </span>
            </label>
          </div>
        </div>

        <div className="rounded-lg border p-3">
          <p className="text-sm font-medium">Local models</p>
          <p className="mb-3 text-xs text-muted-foreground">
            Served from your own saved endpoints. Add a local endpoint under{" "}
            <Link href="/security" className="text-primary underline-offset-2 hover:underline">
              Security → AI keys
            </Link>
            , then <strong>Test</strong> it here to list its models, pick one, and choose who sees it.
            Tenants never see your endpoint or key.
          </p>

          {sources.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              No saved endpoints yet. Add one under{" "}
              <Link href="/security" className="text-primary underline-offset-2 hover:underline">
                Security → AI keys
              </Link>{" "}
              (e.g. your Ollama at <code className="rounded bg-muted px-1">http://host:11434/v1</code>) — then it
              shows up here as a source.
            </p>
          ) : (
            <>
              {models.length > 0 && (
                <div className="mb-3 grid gap-3">
                  {models.map((m, i) => (
                    <div key={m.id ?? i} className="grid gap-3 rounded-md border p-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <FormField label="Source">
                          <div className="flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <Select value={m.sourceKeyId} onValueChange={(v) => updateModel(i, { sourceKeyId: v as string })}>
                                <SelectTrigger className="w-full" aria-label="Source endpoint">
                                  <SelectValue placeholder="Pick a source">{sourceLabel(m.sourceKeyId)}</SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                  {sources.map((s) => (
                                    <SelectItem key={s.id} value={s.id}>
                                      {s.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="shrink-0"
                              title="Test this source & load its models"
                              disabled={!m.sourceKeyId || testing === m.sourceKeyId}
                              onClick={() => testSource(m.sourceKeyId)}
                            >
                              {testing === m.sourceKeyId ? <Loader2 className="animate-spin" /> : <PlugZap />}
                              Test
                            </Button>
                          </div>
                        </FormField>
                        <FormField label="Model" hint={modelsByKey[m.sourceKeyId] ? undefined : "Test the source to load its models"}>
                          <>
                            <Input
                              value={m.model}
                              list={`models-${i}`}
                              placeholder="model name"
                              aria-label="Model"
                              onChange={(e) => updateModel(i, { model: e.target.value })}
                            />
                            <datalist id={`models-${i}`}>
                              {(modelsByKey[m.sourceKeyId] ?? []).map((name) => (
                                <option key={name} value={name} />
                              ))}
                            </datalist>
                          </>
                        </FormField>
                        <FormField label="Nickname (optional)">
                          <Input
                            value={m.nickname ?? ""}
                            placeholder={m.model || "display name"}
                            aria-label="Nickname"
                            onChange={(e) => updateModel(i, { nickname: e.target.value })}
                          />
                        </FormField>
                        <FormField label="Who can use it">
                          <Select value={m.visibility} onValueChange={(v) => updateModel(i, { visibility: v as ModelVisibility })}>
                            <SelectTrigger className="w-full" aria-label="Visibility">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {VISIBILITY_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormField>
                      </div>
                      <div className="flex justify-end border-t pt-2">
                        <Button size="sm" variant="ghost" title="Remove model" onClick={() => removeModel(i)}>
                          <Trash2 className="text-destructive" /> Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Button size="sm" variant="outline" disabled={loading} onClick={addModel}>
                <Plus />
                Add a model
              </Button>
            </>
          )}
        </div>

        <Button onClick={save} disabled={loading || saving} className="w-fit">
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Save IDE settings
        </Button>
      </CardContent>
    </Card>
  );
}
