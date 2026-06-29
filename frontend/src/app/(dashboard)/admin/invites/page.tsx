"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Ticket, Loader2, Copy, Trash2, Check, Mail, Send } from "lucide-react";
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

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/** Per-row dialog: (re)send an existing active invite link to an email address. */
function SendInviteDialog({ invite, onSent }: { invite: Invite; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(invite.email ?? "");
  const [sending, setSending] = useState(false);
  const valid = isEmail(email);

  async function send() {
    setSending(true);
    try {
      const res = await api.post<{ ok: boolean; email: string; error?: string }>(
        `/invites/${invite.id}/send`,
        { email: email.trim() },
      );
      if (res.data.ok) {
        toast.success(`Invite emailed to ${res.data.email}.`);
        setOpen(false);
        onSent();
      } else {
        toast.error(res.data.error ?? "Could not send the invite email.");
      }
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o: boolean) => {
        setOpen(o);
        if (!o) setEmail(invite.email ?? "");
      }}
    >
      <AlertDialogTrigger
        render={
          <Button size="sm" variant="ghost" title="Send invite by email">
            <Mail />
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Email this invite</AlertDialogTitle>
          <AlertDialogDescription>
            Send the invite link to an email address. They&apos;ll get a branded message with the link,
            their quota, and the expiry.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          autoFocus
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="person@example.com"
          aria-label="Recipient email address"
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid && !sending) send();
          }}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button disabled={!valid || sending} onClick={send}>
            {sending ? <Loader2 className="animate-spin" /> : <Send />}
            Send invite
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function InvitesPage() {
  const [invites, setInvites] = useState<Invite[] | null>(null);

  const [cpu, setCpu] = useState(4);
  const [ramGb, setRamGb] = useState(8);
  const [storage, setStorage] = useState(100);
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
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
    const to = email.trim();
    if (to && !isEmail(to)) {
      toast.error("Enter a valid email address, or leave it blank to just copy the link.");
      return;
    }
    setCreating(true);
    try {
      const res = await api.post<CreatedInvite>("/invites", {
        maxCpu: cpu,
        maxRam: ramGb * 1024,
        maxStorage: storage,
        label: label.trim() || undefined,
        email: to || undefined,
        expiresIn,
        require2fa,
      });
      setLastUrl(res.data.inviteUrl);
      setLabel("");
      setEmail("");
      if (res.data.emailed) {
        toast.success(`Invite created and emailed to ${res.data.email}.`);
      } else if (to) {
        toast.warning(
          `Invite created, but the email couldn't be sent${res.data.emailError ? `: ${res.data.emailError}` : "."} You can still copy the link below.`,
        );
      } else {
        toast.success("Invite created.");
      }
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
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Label (optional)" htmlFor="label" hint="A note to help you remember who this is for">
                <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Dev team member" />
              </FormField>
              <FormField
                label="Email invite to (optional)"
                htmlFor="email"
                hint="We'll email the invite link here. Leave blank to just copy the link."
              >
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="person@example.com"
                />
              </FormField>
            </div>
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
                      {inv.email && (
                        <span className="mt-0.5 flex items-center gap-1 text-xs font-normal text-muted-foreground">
                          <Mail className="size-3 shrink-0" />
                          <span className="truncate">{inv.email}</span>
                        </span>
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
                          <>
                            <SendInviteDialog invite={inv} onSent={load} />
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Copy invite link"
                              onClick={() => copy(`${window.location.origin}/register/${inv.token}`)}
                            >
                              <Copy />
                            </Button>
                          </>
                        )}
                        {!inv.used && (
                          <AlertDialog>
                            <AlertDialogTrigger
                              render={
                                <Button size="sm" variant="ghost" title="Revoke invite">
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
