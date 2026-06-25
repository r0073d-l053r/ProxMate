"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Trash2, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { ManagedUser, PasswordResetRequest } from "@/lib/types";
import { formatRam, formatDate } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
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
  }, []);

  useEffect(load, [load]);

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
      <PageHeader title="Users" description="Manage accounts and their resource quotas." />

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
                      <div className="flex items-center gap-2 font-medium">
                        {u.displayName}
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
    </div>
  );
}

function ResetPasswordButton({ user, onDone }: { user: ManagedUser; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);

  function generate() {
    const r = () => Math.random().toString(36).slice(2);
    setPw((r() + r().toUpperCase()).slice(0, 14) + "!7");
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
