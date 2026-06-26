"use client";

import { Crown, User } from "lucide-react";
import type { UserGroup } from "@/lib/types";
import { formatRam } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

/**
 * Section header for an owner's VMs (admin/owner first, then each user).
 * Shows who the VMs belong to and how many of them are currently running.
 */
export function OwnerGroupHeader({ group }: { group: UserGroup }) {
  const total = group.vms.length;
  const running = group.vms.filter((v) => v.status === "running").length;

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-1.5">
      <div className="flex items-center gap-2">
        {group.role === "admin" ? (
          <Crown className="size-4 text-amber-500" />
        ) : (
          <User className="size-4 text-muted-foreground" />
        )}
        <h3 className="text-sm font-semibold">{group.displayName}</h3>
        {group.role === "admin" && <Badge variant="secondary">Owner</Badge>}
        <span className="text-xs text-muted-foreground">· {group.email}</span>
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        <span className="font-medium text-emerald-500">{running} running</span> / {total} VM
        {total === 1 ? "" : "s"}
        {group.role !== "admin" && (
          <>
            {" "}
            · quota {group.quota.cpu} vCPU / {formatRam(group.quota.ram)} / {group.quota.storage} GB
          </>
        )}
      </div>
    </div>
  );
}
