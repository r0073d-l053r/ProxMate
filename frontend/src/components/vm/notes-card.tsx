"use client";

import { useState } from "react";
import { toast } from "sonner";
import { StickyNote, Check, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Editable free-text notes for a VM ("staging — don't touch", "Minecraft server").
 * Self-contained: keeps its own draft so the detail page's 2.5 s status poll never
 * clobbers an in-progress edit. The Save button only enables once the draft differs
 * from what's stored (max 500 chars, mirrored by the backend).
 */
export function NotesCard({
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
  const [value, setValue] = useState(initial ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = value !== (initial ?? "");

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/vms/${vmId}`, { description: value });
      toast.success("Notes saved.");
      onSaved();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <StickyNote className="size-4 text-muted-foreground" />
          Notes
        </CardTitle>
      </CardHeader>
      <CardContent>
        <textarea
          value={value}
          maxLength={500}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Add a note for this VM — e.g. what it runs, who it's for, or 'staging — don't touch'."
          className="h-24 w-full resize-none rounded-md border bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground tabular-nums">{value.length}/500</span>
          <div className="flex gap-2">
            {dirty && (
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setValue(initial ?? "")}>
                Reset
              </Button>
            )}
            <Button size="sm" disabled={saving || !dirty} onClick={save}>
              {saving ? <Loader2 className="animate-spin" /> : <Check />} Save
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
