"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Trash2, KeyRound, Loader2, RefreshCw, Save, Check, X, Cpu } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { cn } from "@/lib/utils";
import type {
  ManagedUser,
  PasswordResetRequest,
  PendingQuotaRequest,
  PendingPassthroughRequest,
  PciMapping,
} from "@/lib/types";
import { formatRam, formatDate } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { UsageReport } from "@/components/admin/usage-report";
import { FormField } from "@/components/form-field";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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

export default function UsersPage() {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [requests, setRequests] = useState<PasswordResetRequest[]>([]);
  const [quotaReqs, setQuotaReqs] = useState<PendingQuotaRequest[]>([]);
  const [passthroughReqs, setPassthroughReqs] = useState<PendingPassthroughRequest[]>([]);
  const [pciMappings, setPciMappings] = useState<PciMapping[]>([]);
  const [mappingChoice, setMappingChoice] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"accounts" | "usage">("accounts");
  const meId = useAuthStore((s) => s.user?.id);

  const load = useCallback(() => {
    api
      .get<ManagedUser[]>("/users")
      .then((res) => setUsers(res.data))
      .catch((err) => toast.error(apiError(err)));
    api
      .get<PasswordResetRequest[]>("/admin/password-requests")
      .then((res) => setRequests(res.data))
      .catch(() => setRequests([]));
    api
      .get<PendingQuotaRequest[]>("/admin/quota-requests")
      .then((res) => setQuotaReqs(res.data))
      .catch(() => setQuotaReqs([]));
    api
      .get<PendingPassthroughRequest[]>("/admin/passthrough-requests")
      .then((res) => setPassthroughReqs(res.data))
      .catch(() => setPassthroughReqs([]));
    api
      .get<PciMapping[]>("/admin/pci-mappings")
      .then((res) => setPciMappings(res.data))
      .catch(() => setPciMappings([]));
  }, []);

  useEffect(load, [load]);

  async function resolveQuota(id: string, action: "approve" | "deny") {
    try {
      await api.post(`/admin/quota-requests/${id}/${action}`);
      toast.success(action === "approve" ? "Quota request approved." : "Quota request denied.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    }
  }

  async function resolvePassthrough(id: string, action: "approve" | "deny") {
    const mapping = mappingChoice[id];
    if (action === "approve" && !mapping) {
      toast.error("Pick a PCI mapping to attach.");
      return;
    }
    try {
      await api.post(
        `/admin/passthrough-requests/${id}/${action}`,
        action === "approve" ? { mapping } : {},
      );
      toast.success(
        action === "approve"
          ? "Passthrough approved — device attached (VM stopped if it was running)."
          : "Passthrough request denied.",
      );
      load();
    } catch (err) {
      toast.error(apiError(err));
    }
  }

  async function onDelete(id: string) {
    try {
      await api.delete(`/users/${id}`);
      toast.success("User deleted.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    }
  }

  const pendingByUser = new Set(requests.map((r) => r.userId));

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Users" description="Manage accounts and quotas, and review per-tenant usage." />

      <div className="mb-4 inline-flex rounded-lg border bg-muted/40 p-0.5 text-sm">
        {(["accounts", "usage"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded-md px-3 py-1.5 font-medium capitalize transition-colors",
              tab === t
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "usage" ? (
        <UsageReport />
      ) : (
        <>
      {quotaReqs.length > 0 && (
        <Card className="mb-4 border-primary/40 bg-primary/5">
          <CardContent className="grid gap-2.5 py-3">
            <div className="text-sm font-medium">
              {quotaReqs.length} quota {quotaReqs.length === 1 ? "request" : "requests"} awaiting review
            </div>
            {quotaReqs.map((q) => (
              <div
                key={q.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-2.5"
              >
                <div className="min-w-0 text-sm">
                  <div className="font-medium">
                    {q.user.displayName}{" "}
                    <span className="text-xs font-normal text-muted-foreground">· {q.user.email}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {q.user.quota.cpu}→{q.cpu} vCPU · {formatRam(q.user.quota.ram)}→{formatRam(q.ram)} ·{" "}
                    {q.user.quota.storage}→{q.storage} GB
                  </div>
                  {q.reason && (
                    <div className="mt-0.5 text-xs italic text-muted-foreground">&ldquo;{q.reason}&rdquo;</div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => resolveQuota(q.id, "approve")}>
                    <Check /> Approve
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => resolveQuota(q.id, "deny")}>
                    <X /> Deny
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {passthroughReqs.length > 0 && (
        <Card className="mb-4 border-amber-500/40 bg-amber-500/5">
          <CardContent className="grid gap-2.5 py-3">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Cpu className="size-4" />
              {passthroughReqs.length} GPU / PCI passthrough {passthroughReqs.length === 1 ? "request" : "requests"} awaiting review
            </div>
            {pciMappings.length === 0 && (
              <p className="rounded-md border border-amber-500/40 bg-background p-2 text-xs text-muted-foreground">
                No PCI resource mappings are defined on the cluster. Create one in Proxmox
                (Datacenter → Resource Mappings → PCI) before you can approve — see the admin guide.
              </p>
            )}
            {passthroughReqs.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-2.5"
              >
                <div className="min-w-0 text-sm">
                  <div className="font-medium">
                    {p.vm.name}{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      · vmid {p.vm.vmid} on {p.vm.node}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {p.user.displayName} · {p.user.email}
                  </div>
                  {p.reason && (
                    <div className="mt-0.5 text-xs italic text-muted-foreground">&ldquo;{p.reason}&rdquo;</div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    aria-label="PCI mapping"
                    value={mappingChoice[p.id] ?? ""}
                    onChange={(e) => setMappingChoice((m) => ({ ...m, [p.id]: e.target.value }))}
                    disabled={pciMappings.length === 0}
                    className="rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <option value="">Select mapping…</option>
                    {pciMappings.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                        {m.nodes.length ? ` (${m.nodes.join(", ")})` : ""}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" variant="outline" onClick={() => resolvePassthrough(p.id, "approve")}>
                    <Check /> Approve
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => resolvePassthrough(p.id, "deny")}>
                    <X /> Deny
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {requests.length > 0 && (
        <Card className="mb-4 border-primary/40 bg-primary/5">
          <CardContent className="flex items-start justify-between gap-3 py-3">
            <div className="text-sm">
              <span className="font-medium text-foreground">
                {requests.length} password reset {requests.length === 1 ? "request" : "requests"}
              </span>
              <span className="text-muted-foreground">
                {" "}
                — {requests.map((r) => r.email).join(", ")}. Use the{" "}
                <KeyRound className="inline size-3.5" /> action to set a new password.
              </span>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={load} title="Refresh">
              <RefreshCw />
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          {users === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : users.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No users yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>VMs</TableHead>
                  <TableHead>Quota</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <EditQuotaDialog user={u} onDone={load} />
                        {pendingByUser.has(u.id) && (
                          <Badge variant="destructive" className="text-[10px]">
                            reset requested
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </TableCell>
                    <TableCell>
                      {u.role === "admin" ? (
                        <Badge variant="secondary">Admin</Badge>
                      ) : (
                        <Badge variant="outline">User</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{u.vmCount}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {u.quota.cpu.used}/{u.quota.cpu.max} vCPU · {formatRam(u.quota.ram.used)}/
                      {formatRam(u.quota.ram.max)} · {u.quota.storage.used}/{u.quota.storage.max} GB
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(u.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <ResetPasswordButton user={u} onDone={load} />
                        {u.id !== meId && (
                          <AlertDialog>
                            <AlertDialogTrigger
                              render={
                                <Button size="sm" variant="ghost" title="Delete user">
                                  <Trash2 />
                                </Button>
                              }
                            />
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete {u.displayName}?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This removes the account and destroys all {u.vmCount} of their VMs on
                                  Proxmox. This cannot be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction variant="destructive" onClick={() => onDelete(u.id)}>
                                  Delete user
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
        </>
      )}
    </div>
  );
}

/**
 * Click a user's name to open their profile and re-provision how much of the
 * cluster they can use. Existing VMs are left alone — quotas bind at create/resize
 * time, so the current usage is shown for context.
 */
function EditQuotaDialog({ user, onDone }: { user: ManagedUser; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [cpu, setCpu] = useState(user.quota.cpu.max);
  const [ramGb, setRamGb] = useState(Math.round(user.quota.ram.max / 1024));
  const [storage, setStorage] = useState(user.quota.storage.max);
  const [busy, setBusy] = useState(false);

  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

  // Seed the fields from the latest values each time the dialog opens.
  function onOpenChange(o: boolean) {
    setOpen(o);
    if (o) {
      setCpu(user.quota.cpu.max);
      setRamGb(Math.round(user.quota.ram.max / 1024));
      setStorage(user.quota.storage.max);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/users/${user.id}`, {
        maxCpu: cpu,
        maxRam: ramGb * 1024,
        maxStorage: storage,
      });
      toast.success(`Updated ${user.displayName}'s quota.`);
      setOpen(false);
      onDone();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger
        render={
          <button type="button" className="text-left font-medium hover:underline" title="Edit profile & quota">
            {user.displayName}
          </button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{user.displayName}</AlertDialogTitle>
          <AlertDialogDescription>
            {user.email} · {user.role} · {user.vmCount} VM{user.vmCount === 1 ? "" : "s"}. Set how much of
            the cluster this user may provision. Existing VMs aren&apos;t changed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid items-start gap-3 py-1 sm:grid-cols-3">
          <FormField label="vCPU" htmlFor="q-cpu" hint={`in use: ${user.quota.cpu.used}`}>
            <Input id="q-cpu" type="number" min={0} value={cpu} onChange={(e) => setCpu(num(e.target.value))} />
          </FormField>
          <FormField label="RAM (GB)" htmlFor="q-ram" hint={`in use: ${formatRam(user.quota.ram.used)}`}>
            <Input id="q-ram" type="number" min={0} value={ramGb} onChange={(e) => setRamGb(num(e.target.value))} />
          </FormField>
          <FormField label="Storage (GB)" htmlFor="q-storage" hint={`in use: ${user.quota.storage.used} GB`}>
            <Input
              id="q-storage"
              type="number"
              min={0}
              value={storage}
              onChange={(e) => setStorage(num(e.target.value))}
            />
          </FormField>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button onClick={save} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />}
            Save quota
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ResetPasswordButton({ user, onDone }: { user: ManagedUser; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);

  function generate() {
    // Use the Web Crypto CSPRNG (never Math.random) for credential material, and
    // guarantee one of each character class so the temp password isn't degenerate.
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const lower = "abcdefghijkmnopqrstuvwxyz";
    const digits = "23456789";
    const symbols = "!@#$%^&*";
    const pick = (set: string, n: number) => {
      const buf = new Uint32Array(n);
      crypto.getRandomValues(buf);
      return Array.from(buf, (v) => set[v % set.length]).join("");
    };
    const chars = (
      pick(upper, 1) +
      pick(lower, 1) +
      pick(digits, 1) +
      pick(symbols, 1) +
      pick(upper + lower + digits + symbols, 12)
    ).split("");
    // CSPRNG Fisher–Yates shuffle so the guaranteed chars aren't always first.
    const rnd = new Uint32Array(chars.length);
    crypto.getRandomValues(rnd);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = rnd[i]! % (i + 1);
      [chars[i], chars[j]] = [chars[j]!, chars[i]!];
    }
    setPw(chars.join(""));
  }

  async function submit() {
    if (pw.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/admin/users/${user.id}/reset-password`, { password: pw });
      toast.success(`Password reset for ${user.email}. Share it with them securely.`);
      setOpen(false);
      setPw("");
      onDone();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button size="sm" variant="ghost" title="Reset password">
            <KeyRound />
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset password for {user.displayName}</AlertDialogTitle>
          <AlertDialogDescription>
            Set a new password and share it with them securely. This signs them out everywhere.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2 py-1">
          <Input value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password (min 8 characters)" />
          <button type="button" onClick={generate} className="text-left text-xs text-primary hover:underline">
            Generate a random password
          </button>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
            Set password
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
