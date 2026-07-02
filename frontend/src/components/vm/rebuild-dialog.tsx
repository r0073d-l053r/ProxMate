"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RotateCcw, AlertTriangle, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { VmDetail, ProxmoxIso, Template, SshKey } from "@/lib/types";
import { formatRam } from "@/lib/format";
import { FormField } from "@/components/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Re-image a VM in place from a fresh ISO or a template / cloud image. Destructive:
 * the current disk is wiped, but the VM keeps its id, VMID, name, and resources.
 * Cloud-init login details are re-supplied here (they're never stored). Source values
 * are encoded as `iso::<filename>` or `tpl::<id>` so one Select can list both.
 *
 * Controlled: the detail page's Actions menu opens it via `open`/`onOpenChange`.
 */
export function RebuildDialog({
  vm,
  open,
  onOpenChange,
  onRebuilt,
}: {
  vm: VmDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRebuilt: () => void;
}) {
  const [isos, setIsos] = useState<ProxmoxIso[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [savedKeys, setSavedKeys] = useState<SshKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string>("");
  const [sshKey, setSshKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSource("");
    setSshKey("");
    setUsername("");
    setPassword("");
    setConfirmed(false);
    setError(null);
    setLoading(true);
    Promise.all([
      api.get<ProxmoxIso[]>("/proxmox/isos").catch(() => ({ data: [] as ProxmoxIso[] })),
      api.get<Template[]>("/templates").catch(() => ({ data: [] as Template[] })),
      api.get<SshKey[]>("/ssh-keys").catch(() => ({ data: [] as SshKey[] })),
    ])
      .then(([isoRes, tplRes, keyRes]) => {
        setIsos(isoRes.data);
        setTemplates(tplRes.data);
        setSavedKeys(keyRes.data);
      })
      .finally(() => setLoading(false));
  }, [open]);

  const isTemplate = source.startsWith("tpl::");
  const template = isTemplate ? templates.find((t) => t.id === source.slice(5)) : undefined;
  const needsCloudInit = !!template?.cloudInit;

  function validate(): string | null {
    if (!source) return "Pick an image to rebuild from.";
    if (needsCloudInit && !sshKey.trim() && !password) return "Add an SSH public key or a password to log in.";
    if (sshKey.trim() && !/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)/.test(sshKey.trim()))
      return "That doesn't look like an OpenSSH public key.";
    if (!confirmed) return "Tick the box to confirm — this erases the current disk.";
    return null;
  }

  async function submit() {
    const v = validate();
    if (v) { setError(v); return; }
    setSaving(true);
    try {
      const body = isTemplate
        ? {
            templateId: source.slice(5),
            ...(sshKey.trim() ? { sshKey: sshKey.trim() } : {}),
            ...(username.trim() ? { username: username.trim() } : {}),
            ...(password ? { password } : {}),
          }
        : { os: source.slice(5) };
      await api.post(`/vms/${vm.id}/rebuild`, body);
      toast.success("VM rebuilt — it's been re-imaged and is starting up.");
      onRebuilt();
      onOpenChange(false);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rebuild {vm.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Re-image this VM from a fresh ISO or template. It keeps its name and{" "}
            {vm.cpu} vCPU / {formatRam(vm.ram)} / {vm.storage} GB, but{" "}
            <span className="font-medium text-foreground">its current disk and all data are erased.</span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <FormField label="Rebuild from" htmlFor="rb-source">
          <Select value={source} onValueChange={(v) => { setSource(v as string); setError(null); }}>
            <SelectTrigger id="rb-source" className="w-full">
              <SelectValue placeholder={loading ? "Loading images…" : "Choose an ISO or template"} />
            </SelectTrigger>
            <SelectContent>
              {isos.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Install ISOs</SelectLabel>
                  {isos.map((iso) => (
                    <SelectItem key={iso.volid} value={`iso::${iso.name}`}>
                      {iso.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {templates.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Templates</SelectLabel>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={`tpl::${t.id}`}>
                      {t.name}
                      {t.cloudInit ? " (cloud image)" : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        </FormField>

        {needsCloudInit && (
          <div className="grid gap-3">
            <FormField label="SSH public key" htmlFor="rb-ssh">
              <textarea
                id="rb-ssh"
                value={sshKey}
                onChange={(e) => { setSshKey(e.target.value); setError(null); }}
                placeholder="ssh-ed25519 AAAA… you@laptop"
                className="h-20 w-full resize-none rounded-md border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </FormField>
            {savedKeys.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {savedKeys.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => { setSshKey(k.publicKey); setError(null); }}
                    className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                  >
                    {k.name}
                  </button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Login user (optional)" htmlFor="rb-user">
                <Input id="rb-user" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="debian" />
              </FormField>
              <FormField label="Password (optional)" htmlFor="rb-pass">
                <Input id="rb-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="—" />
              </FormField>
            </div>
          </div>
        )}

        <label className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => { setConfirmed(e.target.checked); setError(null); }}
            className="mt-0.5"
          />
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="size-4 shrink-0 text-destructive" />
            I understand this permanently erases the current disk and its data.
          </span>
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={submit} disabled={saving || loading}>
            {saving ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Rebuild
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
