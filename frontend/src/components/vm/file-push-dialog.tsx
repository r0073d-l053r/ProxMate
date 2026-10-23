"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, FileUp, Loader2, Upload } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { GuestFilePushResult } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { guestPathError, isValidFileMode, suggestedPath } from "@/lib/guest-files";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/form-field";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Push a small file into a running QEMU guest through the guest agent:
 * drop or pick a file, choose where it lands, its mode and owner. The server
 * validates everything again and audits the push (path, size, checksum).
 */
export function FilePushDialog({
  vmId,
  vmName,
  maxBytes = DEFAULT_MAX_BYTES,
  open,
  onOpenChange,
}: {
  vmId: string;
  vmName: string;
  maxBytes?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [dest, setDest] = useState("");
  const [mode, setMode] = useState("0644");
  const [owner, setOwner] = useState("");
  const [createParents, setCreateParents] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<GuestFilePushResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setDest("");
    setMode("0644");
    setOwner("");
    setCreateParents(false);
    setResult(null);
  }

  function choose(f: File | undefined | null) {
    if (!f) return;
    setFile(f);
    setResult(null);
    if (!dest) setDest(suggestedPath(f.name));
  }

  const tooBig = !!file && file.size > maxBytes;
  const pathError = dest ? guestPathError(dest) : null;
  const modeOk = isValidFileMode(mode);
  const ownerOk = owner.trim() === "" || /^[a-zA-Z0-9._][a-zA-Z0-9._-]{0,63}$/.test(owner.trim());
  const canPush = !!file && !tooBig && !!dest && !pathError && modeOk && ownerOk && !working;

  async function push() {
    if (!file || !canPush) return;
    setWorking(true);
    try {
      const form = new FormData();
      form.append("path", dest);
      form.append("mode", mode.trim() || "0644");
      if (owner.trim()) form.append("owner", owner.trim());
      if (createParents) form.append("createParents", "true");
      form.append("file", file, file.name);
      const r = await api.post<GuestFilePushResult>(`/vms/${vmId}/files`, form);
      setResult(r.data);
      toast.success(`Pushed ${file.name} to ${r.data.path}.`);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o: boolean) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <AlertDialogContent className="data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Push a file to {vmName}</AlertDialogTitle>
          <AlertDialogDescription>
            Copies a small file (up to {formatBytes(maxBytes)}) into the machine through the QEMU guest agent —
            handy for a config or a script. An existing file at that path is replaced.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {result ? (
          <div className="rounded-md border bg-muted/50 p-3 text-sm" data-testid="push-result">
            <p className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 className="size-4 text-emerald-600" />
              Written to <code className="break-all">{result.path}</code>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatBytes(result.size)} · SHA-256{" "}
              <code className="break-all">{result.sha256}</code>
              {result.verified ? " · checked in the guest" : ""}
            </p>
          </div>
        ) : (
          <>
            <div
              role="button"
              tabIndex={0}
              aria-label="Choose a file to push"
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                choose(e.dataTransfer.files?.[0]);
              }}
              className={
                "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed p-4 text-center text-sm transition-colors " +
                (dragging ? "border-primary bg-primary/5" : "hover:bg-muted/50")
              }
            >
              <FileUp className="size-5 text-muted-foreground" />
              {file ? (
                <span className="break-all">
                  <span className="font-medium">{file.name}</span>{" "}
                  <span className="text-muted-foreground">({file.size === 0 ? "0 B" : formatBytes(file.size)})</span>
                </span>
              ) : (
                <span className="text-muted-foreground">Drop a file here, or click to choose one</span>
              )}
              {tooBig && (
                <span className="text-xs text-destructive">That file is larger than the {formatBytes(maxBytes)} limit.</span>
              )}
              <input
                ref={inputRef}
                type="file"
                className="hidden"
                data-testid="push-file-input"
                onChange={(e) => choose(e.target.files?.[0])}
              />
            </div>

            <FormField label="Destination path" htmlFor="pushPath" error={pathError ?? undefined}>
              <Input
                id="pushPath"
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder="/etc/myapp/config.yaml"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Mode" htmlFor="pushMode" error={modeOk ? undefined : "Use a mode like 0644."}>
                <Input
                  id="pushMode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  placeholder="0644"
                  autoComplete="off"
                  className="font-mono text-xs"
                />
              </FormField>
              <FormField
                label="Owner (optional)"
                htmlFor="pushOwner"
                error={ownerOk ? undefined : "Invalid username."}
                hint="Guest user; root if empty. Written as this user in folders that are theirs."
              >
                <Input
                  id="pushOwner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="e.g. ubuntu"
                  autoComplete="off"
                />
              </FormField>
            </div>

            <label className="flex cursor-pointer items-center gap-2.5 text-sm">
              <input type="checkbox" checked={createParents} onChange={(e) => setCreateParents(e.target.checked)} />
              Create parent folders if they don&apos;t exist
            </label>
          </>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={working}>{result ? "Done" : "Cancel"}</AlertDialogCancel>
          {result ? (
            <Button variant="outline" onClick={reset}>
              <Upload />
              Push another
            </Button>
          ) : (
            <Button onClick={push} disabled={!canPush}>
              {working ? <Loader2 className="animate-spin" /> : <Upload />}
              Push file
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
