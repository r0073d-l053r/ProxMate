"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Code2, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { AdminSettings, IdeSharedModel, IdeTier } from "@/lib/types";
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

const PROVIDER_OPTIONS = [
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "ollama", label: "Ollama" },
];

/**
 * Admin policy for ProxMate IDE — the in-guest code-server (with OpenCode baked
 * in) that ProxMate reverse-proxies. Controls who may open it, whether tenants
 * can bring their own LLM API keys, and which locally-hosted models are shared
 * through the ProxMate gateway (tenants never see the upstream endpoint or key).
 */
export function IdeSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState<IdeTier>("off");
  const [allowByoKeys, setAllowByoKeys] = useState(false);
  const [sharedModels, setSharedModels] = useState<IdeSharedModel[]>([]);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayKey, setGatewayKey] = useState("");
  const [hasGatewayKey, setHasGatewayKey] = useState(false);

  useEffect(() => {
    api
      .get<AdminSettings>("/admin/settings")
      .then((r) => {
        const ide = r.data.ide;
        if (!ide) return;
        setEnabled(ide.enabled);
        setAllowByoKeys(ide.allowByoKeys);
        setSharedModels(ide.sharedModels);
        setGatewayUrl(ide.gatewayUrl);
        setHasGatewayKey(ide.hasGatewayKey);
      })
      .catch((err) => toast.error(apiError(err)))
      .finally(() => setLoading(false));
  }, []);

  function updateModel(i: number, patch: Partial<IdeSharedModel>) {
    setSharedModels((rows) => rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  function addModel() {
    setSharedModels((rows) => [...rows, { id: "", label: "", provider: "openai-compatible", model: "" }]);
  }

  function removeModel(i: number) {
    setSharedModels((rows) => rows.filter((_, idx) => idx !== i));
  }

  async function save() {
    // Drop empty editor rows; derive missing ids/labels from the model name.
    const models = sharedModels
      .filter((m) => m.model.trim() || m.id.trim())
      .map((m) => {
        const model = m.model.trim() || m.id.trim();
        const id = (m.id.trim() || model).toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").slice(0, 64);
        return { id, label: m.label.trim() || model, provider: m.provider, model };
      });
    const ids = new Set<string>();
    for (const m of models) {
      if (ids.has(m.id)) {
        toast.error(`Duplicate model id "${m.id}" — give each shared model a unique id.`);
        return;
      }
      ids.add(m.id);
    }
    if (models.length > 0 && !gatewayUrl.trim()) {
      toast.error("Shared models need the local model endpoint URL below.");
      return;
    }

    setSaving(true);
    try {
      await api.put("/admin/settings/ide", {
        enabled,
        allowByoKeys,
        sharedModels: models,
        gatewayUrl: gatewayUrl.trim(),
        gatewayKey: gatewayKey.trim() || undefined,
      });
      setSharedModels(models);
      if (gatewayKey.trim()) {
        setHasGatewayKey(true);
        setGatewayKey("");
      }
      toast.success("ProxMate IDE settings saved.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  const tierHint = TIER_OPTIONS.find((t) => t.value === enabled)?.hint;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Code2 className="size-4 text-muted-foreground" />
          ProxMate IDE
        </CardTitle>
        <CardDescription>
          A browser IDE (VS Code-style, with the OpenCode AI assistant built in) that opens inside a
          VM — so users can build their machine with an AI copilot. Control who can use it and which
          AI models it may talk to.
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
                Let users bring their own AI keys — each user can plug their personal LLM API keys
                into their IDE.
              </span>
            </label>
          </div>
        </div>

        <div className="rounded-lg border p-3">
          <p className="text-sm font-medium">Shared local models</p>
          <p className="mb-3 text-xs text-muted-foreground">
            Models from your own hardware (Ollama, vLLM, any OpenAI-compatible server) offered to IDE
            users through ProxMate&apos;s gateway. Users pick them by name — they never see your
            endpoint or key. Leave empty to share nothing.
          </p>
          {sharedModels.length > 0 && (
            <div className="mb-2 grid gap-2">
              {sharedModels.map((m, i) => (
                <div key={i} className="grid items-center gap-2 sm:grid-cols-[1fr_1fr_10rem_1fr_auto]">
                  <Input
                    value={m.label}
                    placeholder="Display name (Llama 3.1)"
                    aria-label="Model display name"
                    onChange={(e) => updateModel(i, { label: e.target.value })}
                  />
                  <Input
                    value={m.model}
                    placeholder="Model (llama3.1:8b)"
                    aria-label="Upstream model name"
                    onChange={(e) => updateModel(i, { model: e.target.value })}
                  />
                  <Select value={m.provider} onValueChange={(v) => updateModel(i, { provider: v as string })}>
                    <SelectTrigger className="w-full" aria-label="Provider type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDER_OPTIONS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={m.id}
                    placeholder="Id (auto)"
                    aria-label="Stable model id"
                    onChange={(e) => updateModel(i, { id: e.target.value })}
                  />
                  <Button size="sm" variant="ghost" title="Remove model" onClick={() => removeModel(i)}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <Button size="sm" variant="outline" disabled={loading} onClick={addModel}>
            <Plus />
            Add a model
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Local model endpoint"
            htmlFor="ide-gateway-url"
            hint="Your Ollama / vLLM / OpenAI-compatible base URL, e.g. http://192.168.50.20:11434/v1 — never shown to users"
          >
            <Input
              id="ide-gateway-url"
              value={gatewayUrl}
              disabled={loading}
              placeholder="http://192.168.50.20:11434/v1"
              onChange={(e) => setGatewayUrl(e.target.value)}
            />
          </FormField>
          <FormField
            label="Endpoint API key (optional)"
            htmlFor="ide-gateway-key"
            hint={hasGatewayKey ? "A key is stored — leave blank to keep it" : "Only if your endpoint requires one"}
          >
            <Input
              id="ide-gateway-key"
              type="password"
              value={gatewayKey}
              disabled={loading}
              placeholder={hasGatewayKey ? "••••••••" : ""}
              onChange={(e) => setGatewayKey(e.target.value)}
            />
          </FormField>
        </div>

        <Button onClick={save} disabled={loading || saving} className="w-fit">
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Save IDE settings
        </Button>
      </CardContent>
    </Card>
  );
}
