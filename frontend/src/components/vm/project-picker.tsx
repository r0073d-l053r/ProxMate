"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { FolderInput, FolderMinus, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { normalizeProjectName } from "@/lib/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface AssignResponse {
  project: string | null;
  results: { id: string; ok: boolean; error?: string }[];
}

/**
 * Move one or more VMs into a project (or out of one). Used by the VM detail
 * page's Project card and the VMs list's "Move to project…" bulk action. The
 * server applies it to the VMs the caller owns and reports the rest per item.
 */
export function ProjectPicker({
  ids,
  current = null,
  suggestions = [],
  onDone,
  onCancel,
}: {
  ids: string[];
  current?: string | null;
  suggestions?: string[];
  onDone: (project: string | null) => void;
  onCancel?: () => void;
}) {
  const listId = useId();
  const [draft, setDraft] = useState(current ?? "");
  const [busy, setBusy] = useState(false);

  async function assign(project: string | null) {
    const name = project === null ? null : normalizeProjectName(project);
    if (project !== null && !name) {
      toast.error("Use letters, numbers, _ and - (up to 32), starting with a letter or number.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<AssignResponse>("/projects/assign", { ids, project: name });
      const ok = res.data.results.filter((r) => r.ok).length;
      const failed = res.data.results.length - ok;
      const what = res.data.project ? `Moved to ${res.data.project}` : "Removed from project";
      if (ok > 0) toast.success(`${what}: ${ok} VM${ok === 1 ? "" : "s"}${failed ? `, ${failed} not yours to move` : ""}.`);
      else toast.error("None of these VMs could be moved — only a VM's owner can set its project.");
      onDone(res.data.project);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) void assign(draft.trim());
      }}
    >
      <Input
        autoFocus
        aria-label="Project name"
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Project — e.g. shop, team-a"
        maxLength={32}
        className="h-8 max-w-48"
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <Button type="submit" size="sm" variant="outline" disabled={busy || !draft.trim()}>
        {busy ? <Loader2 className="animate-spin" /> : <FolderInput />} Move
      </Button>
      {(current || ids.length > 1) && (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => assign(null)}>
          <FolderMinus /> Remove from project
        </Button>
      )}
      {onCancel && (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      )}
    </form>
  );
}
