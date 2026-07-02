"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Tag, X, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Editable tags for grouping/filtering a VM. Adds/removes persist immediately via
 * PATCH (tags are sent as an array; the backend normalizes + stores them).
 */
export function TagsCard({
  vmId,
  initial,
  onSaved,
  className,
}: {
  vmId: string;
  initial: string | null;
  onSaved: () => void;
  className?: string;
}) {
  const [tags, setTags] = useState<string[]>(() =>
    (initial ?? "").split(",").map((t) => t.trim()).filter(Boolean),
  );
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function persist(next: string[]) {
    setSaving(true);
    try {
      await api.patch(`/vms/${vmId}`, { tags: next });
      setTags(next);
      onSaved();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  function add() {
    const t = draft.trim().toLowerCase();
    if (!t) return;
    if (!/^[a-z0-9][a-z0-9 _-]{0,30}$/.test(t)) {
      toast.error("Letters, numbers, space, _ and - only.");
      return;
    }
    if (tags.includes(t)) { setDraft(""); return; }
    setDraft("");
    void persist([...tags, t]);
  }

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Tag className="size-4 text-muted-foreground" />
          Tags
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((t) => (
            <span key={t} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
              {t}
              <button
                type="button"
                aria-label={`Remove ${t}`}
                disabled={saving}
                onClick={() => persist(tags.filter((x) => x !== t))}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {tags.length === 0 && <span className="text-sm text-muted-foreground">No tags yet.</span>}
        </div>
        <div className="mt-3 flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); add(); }
            }}
            placeholder="Add a tag — e.g. prod, web, team-a"
            maxLength={31}
            className="max-w-xs"
          />
          <Button size="sm" variant="outline" onClick={add} disabled={saving || !draft.trim()}>
            {saving ? <Loader2 className="animate-spin" /> : <Tag />} Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
