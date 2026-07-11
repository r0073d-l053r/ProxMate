"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Share2, Loader2, Trash2, UserPlus } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { VmShare } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

type ShareRole = VmShare["role"];

/**
 * Owner/admin panel to share a VM with another tenant at a preset level:
 * Viewer (see it) → Operator (+ power & console) → Manager (+ settings, backups,
 * IDE). No share can ever delete, rebuild, migrate, or re-share the VM — the API
 * enforces every level server-side.
 */
export function SharePanel({ vmId }: { vmId: string }) {
  const [shares, setShares] = useState<VmShare[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<VmShare[]>(`/vms/${vmId}/shares`)
      .then((r) => setShares(r.data))
      .catch((e) => toast.error(apiError(e)));
  }, [vmId]);

  useEffect(load, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!isEmail(email)) {
      toast.error("Enter a valid email address.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/vms/${vmId}/shares`, { email: email.trim(), role });
      toast.success(`Shared with ${email.trim()}.`);
      setEmail("");
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.delete(`/vms/${vmId}/shares/${id}`);
      toast.success("Access revoked.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Share2 className="size-4 text-muted-foreground" /> Shared access
        </CardTitle>
        <CardDescription>
          Give another ProxMate user access at a level you choose:{" "}
          <span className="font-medium text-foreground">Viewer</span> sees details, metrics and
          activity; <span className="font-medium text-foreground">Operator</span> adds power actions
          and the console; <span className="font-medium text-foreground">Manager</span> adds settings,
          disks, backups (including downloads) and the IDE. Nobody you share with can delete,
          rebuild, or re-share this VM.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <div className="grid min-w-[180px] flex-1 gap-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="share-email">
              User email
            </label>
            <Input
              id="share-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="share-role">
              Access
            </label>
            <Select value={role} onValueChange={(v) => setRole(v as ShareRole)}>
              <SelectTrigger id="share-role" className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">Viewer</SelectItem>
                <SelectItem value="operator">Operator</SelectItem>
                <SelectItem value="manager">Manager</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <UserPlus />}
            Share
          </Button>
        </form>

        {shares === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : shares.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not shared with anyone yet.</p>
        ) : (
          <ul className="grid gap-1.5">
            {shares.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{s.user.displayName}</div>
                  <div className="truncate text-xs text-muted-foreground">{s.user.email}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={s.role === "manager" ? "default" : s.role === "operator" ? "outline" : "secondary"}>
                    {s.role}
                  </Badge>
                  <Button size="sm" variant="ghost" title="Revoke access" onClick={() => remove(s.id)}>
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
