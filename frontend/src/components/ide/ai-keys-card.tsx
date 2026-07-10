"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Sparkles, Loader2, Plus, Trash2, PlugZap } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { IdeCapability, IdeLlmKey } from "@/lib/types";
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

// Presets map to the backend's provider + base URL. 'openai' uses its fixed
// endpoint; the rest are openai-compatible and just differ by base URL. "Custom"
// lets the user point at any OpenAI-compatible server.
type Preset = {
  id: string;
  label: string;
  provider: "openai" | "openai-compatible";
  baseUrl: string;
  custom: boolean;
  modelHint: string;
};
const PRESETS: Preset[] = [
  { id: "openai", label: "OpenAI", provider: "openai", baseUrl: "", custom: false, modelHint: "gpt-4o" },
  { id: "openrouter", label: "OpenRouter", provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", custom: false, modelHint: "anthropic/claude-3.5-sonnet" },
  { id: "groq", label: "Groq", provider: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", custom: false, modelHint: "llama-3.1-70b-versatile" },
  { id: "custom", label: "OpenAI-compatible (custom)", provider: "openai-compatible", baseUrl: "", custom: true, modelHint: "model-name" },
];

/**
 * Tenant "bring-your-own AI keys" — only rendered when the admin has enabled BYO
 * for the IDE. Keys are used ONLY through the ProxMate gateway; the secret is
 * stored encrypted and never shown again. Lives on the Security page beside the
 * user's other credentials (SSH keys / API tokens).
 */
export function AiKeysCard() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<IdeLlmKey[] | null>(null);
  const [presetId, setPresetId] = useState<string>("openai");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];

  function loadKeys() {
    api
      .get<IdeLlmKey[]>("/ide/keys")
      .then((r) => setKeys(r.data))
      .catch((e) => toast.error(apiError(e)));
  }

  useEffect(() => {
    api
      .get<IdeCapability>("/ide/config")
      .then((r) => {
        // Tenants: only when the admin allows BYO. Admins: always, since they use
        // saved endpoints as local-model sources for the IDE settings panel.
        const on = r.data.available && (r.data.allowByoKeys || isAdmin);
        setAllowed(on);
        if (on) loadKeys();
      })
      .catch(() => setAllowed(false));
  }, [isAdmin]);

  async function addKey() {
    setSaving(true);
    try {
      await api.post("/ide/keys", {
        label: label.trim(),
        provider: preset.provider,
        model: model.trim(),
        baseUrl: preset.custom ? baseUrl.trim() : preset.baseUrl,
        key: secret.trim(),
      });
      setLabel("");
      setModel("");
      setBaseUrl("");
      setSecret("");
      toast.success("AI key saved.");
      loadKeys();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  async function testKey(id: string, label: string) {
    setTesting(id);
    try {
      const r = await api.post<{ ok: boolean; modelCount: number; error?: string }>(`/ide/keys/${id}/test`, {});
      if (r.data.ok) {
        toast.success(`"${label}" connected — ${r.data.modelCount} model${r.data.modelCount === 1 ? "" : "s"} available.`);
      } else {
        toast.error(`"${label}" failed: ${r.data.error ?? "unreachable"}`);
      }
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setTesting(null);
    }
  }

  async function removeKey(id: string) {
    try {
      await api.delete(`/ide/keys/${id}`);
      setKeys((k) => k?.filter((x) => x.id !== id) ?? null);
      toast.success("AI key removed.");
    } catch (err) {
      toast.error(apiError(err));
    }
  }

  // Only shown when the admin allows BYO keys — otherwise render nothing.
  if (!allowed) return null;

  const canSave = !!label.trim() && !!model.trim() && !!secret.trim() && (!preset.custom || !!baseUrl.trim());

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" /> AI keys
        </CardTitle>
        <CardDescription>
          Plug your own LLM provider keys into the ProxMate IDE&apos;s AI assistant. Keys are used only
          through ProxMate&apos;s gateway, stored encrypted, and never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {keys === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AI keys yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{k.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {k.provider} · {k.model}
                    {k.baseUrl ? ` · ${k.baseUrl}` : ""}
                    {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => testKey(k.id, k.label)}
                    disabled={testing === k.id}
                    aria-label={`Test ${k.label}`}
                    title="Test connection"
                  >
                    {testing === k.id ? <Loader2 className="animate-spin" /> : <PlugZap />}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => removeKey(k.id)} aria-label={`Remove ${k.label}`}>
                    <Trash2 className="text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
          <FormField label="Provider" hint="Where the model runs">
            <Select value={presetId} onValueChange={(v) => setPresetId(v as string)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Label" htmlFor="ai-key-label" hint="A name for you">
            <Input
              id="ai-key-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. my OpenAI"
              maxLength={60}
            />
          </FormField>
          {preset.custom && (
            <FormField label="Base URL" htmlFor="ai-key-base" hint="Your OpenAI-compatible endpoint">
              <Input
                id="ai-key-base"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://host:8000/v1"
              />
            </FormField>
          )}
          <FormField label="Model" htmlFor="ai-key-model" hint={`e.g. ${preset.modelHint}`}>
            <Input
              id="ai-key-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={preset.modelHint}
              maxLength={120}
            />
          </FormField>
          <FormField label="API key" htmlFor="ai-key-secret" hint="Stored encrypted; never shown again">
            <Input
              id="ai-key-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="sk-…"
            />
          </FormField>
        </div>
        <div>
          <Button variant="outline" onClick={addKey} disabled={saving || !canSave}>
            {saving ? <Loader2 className="animate-spin" /> : <Plus />}
            Save AI key
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
