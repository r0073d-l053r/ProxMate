"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Ticket, Loader2, Copy, Trash2, Check } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { Invite, CreatedInvite } from "@/lib/types";
import { formatRam, formatDate } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const EXPIRY_OPTIONS = [
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

export default function InvitesPage() {
  const [invites, setInvites] = useState<Invite[] | null>(null);

  const [cpu, setCpu] = useState(4);
  const [ramGb, setRamGb] = useState(8);
  const [storage, setStorage] = useState(100);
  const [label, setLabel] = useState("");
  const [expiresIn, setExpiresIn] = useState("7d");
  const [require2fa, setRequire2fa] = useState(false);
  const [creating, setCreating] = useState(false);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function load() {
    api
      .get<Invite[]>("/invites")
      .then((res) => setInvites(res.data))
      .catch((err) => toast.error(apiError(err)));
  }

  useEffect(load, []);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await api.post<CreatedInvite>("/invites", {
        maxCpu: cpu,
        maxRam: ramGb * 1024,
        maxStorage: storage,
        label: label.trim() || undefined,
        expiresIn,
        require2fa,
      });
      setLastUrl(res.data.inviteUrl);
      setLabel("");
      toast.success("Invite created.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setCreating(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Invite link copied.");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy to clipboard.");
    }
  }

  async function onRevoke(id: string) {
    try {
      await api.delete(`/invites/${id}`);
      toast.success("Invite revoked.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    }
  }

  function statusBadge(inv: Invite) {
    if (inv.used)
      return <Badge variant="secondary">Used{inv.usedBy ? ` · ${inv.usedBy.email}` : ""}</Badge>;
    if (inv.expired) return <Badge variant="outline">Expired</Badge>;
    return <Badge>Active</Badge>;
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Invites" description="Generate invite links with embedded resource quotas." />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Create an invite</CardTitle>
          <CardDescription>The new user inherits the quota you set here.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-4">
              <FormField label="Max vCPU" htmlFor="cpu">
                <Input id="cpu" type="number" min={1} value={cpu} onChange={(e) => setCpu(Number(e.target.value))} />
              </FormField>
              <FormField label="Max RAM (GB)" htmlFor="ram">
                <Input id="ram" type="number" min={1} value={ramGb} onChange={(e) => setRamGb(Number(e.target.value))} />
              </FormField>
              <FormField label="Max storage (GB)" htmlFor="storage">
                <Input id="storage" type="number" min={1} value={storage} onChange={(e) => setStorage(Number(e.target.value))} />
              </FormField>
              <FormField label="Expires in">
                <Select value={expiresIn} onValueChange={(v) => setExpiresIn(v as string)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <FormField label="Label (optional)" htmlFor="label" hint="A note to help you remember who this is for">
              <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Dev team member" />
            </FormField>
            <label className="flex items-start gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={require2fa}
                onChange={(e) => setRequire2fa(e.target.checked)}
                className="mt-0.5 size-4 rounded border-input accent-primary"
              />
              <span>
                Require two-step authentication — the user must set up an authenticator app or a passkey
                before they can use ProxMate. (Not applied to users who sign in via SSO.)
              </span>
            </label>
            <Button type="submit" disabled={creating} className="w-fit">
              {creating ? <Loader2 className="animate-spin" /> : <Ticket />}
              Generate invite
            </Button>
          </form>

          {lastUrl && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border bg-muted/40 p-2">
              <code className="flex-1 truncate text-xs">{lastUrl}</code>
              <Button size="sm" variant="outline" onClick={() => copy(lastUrl)}>
                {copied ? <Check /> : <Copy />}
                Copy
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All invites</CardTitle>
        </CardHeader>
        <CardContent>
          {invites === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : invites.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No invites yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Quota</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">
                      {inv.label ?? "—"}
                      {inv.require2fa && (
                        <Badge variant="outline" className="ml-2 font-normal">
                          2FA
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {inv.maxCpu} vCPU · {formatRam(inv.maxRam)} · {inv.maxStorage} GB
                    </TableCell>
                    <TableCell>{statusBadge(inv)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(inv.expiresAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {!inv.used && !inv.expired && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              copy(`${window.location.origin}/register/${inv.token}`)
                            }
                          >
                            <Copy />
                          </Button>
                        )}
                        {!inv.used && (
                          <AlertDialog>
                            <AlertDialogTrigger
                              render={
                                <Button size="sm" variant="ghost">
                                  <Trash2 />
                                </Button>
                              }
                            />
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Revoke invite?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  The invite link will stop working immediately.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction variant="destructive" onClick={() => onRevoke(inv.id)}>
                                  Revoke
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
