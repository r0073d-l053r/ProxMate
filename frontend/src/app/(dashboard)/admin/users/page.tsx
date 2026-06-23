"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { ManagedUser } from "@/lib/types";
import { formatRam, formatDate } from "@/lib/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  const meId = useAuthStore((s) => s.user?.id);

  function load() {
    api
      .get<ManagedUser[]>("/users")
      .then((res) => setUsers(res.data))
      .catch((err) => toast.error(apiError(err)));
  }

  useEffect(load, []);

  async function onDelete(id: string) {
    try {
      await api.delete(`/users/${id}`);
      toast.success("User deleted.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Users" description="Manage accounts and their resource quotas." />

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
                      <div className="font-medium">{u.displayName}</div>
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
                      {u.id !== meId && (
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
