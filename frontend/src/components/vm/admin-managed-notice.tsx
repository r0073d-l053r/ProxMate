import { ShieldCheck } from "lucide-react";
import type { VirtualMachine } from "@/lib/types";

/**
 * Wording shared by the VM page and the disks panel: an admin-managed VM
 * (deploy-for-tenant) is operated by its tenant but sized and rebuilt only by
 * an admin — the backend refuses those actions for anyone else.
 */
export const ADMIN_MANAGED_EXPLAINER = "Set up by your admin — only an admin can resize or rebuild it.";

/** Whether a non-admin viewer should be told this VM is admin-managed. */
export function showsAdminManaged(vm: Pick<VirtualMachine, "adminManaged">, isAdmin: boolean): boolean {
  return !!vm.adminManaged && !isAdmin;
}

/** Small header badge for an admin-managed VM, seen by a non-admin. */
export function AdminManagedBadge({ vm, isAdmin }: { vm: Pick<VirtualMachine, "adminManaged">; isAdmin: boolean }) {
  if (!showsAdminManaged(vm, isAdmin)) return null;
  return (
    <span
      className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium"
      title={ADMIN_MANAGED_EXPLAINER}
    >
      <ShieldCheck className="size-2.5" /> Admin-managed
    </span>
  );
}

/**
 * One-line explainer under the header, so resize and rebuild being absent reads
 * as a decision rather than as missing controls.
 */
export function AdminManagedNote({ vm, isAdmin }: { vm: Pick<VirtualMachine, "adminManaged">; isAdmin: boolean }) {
  if (!showsAdminManaged(vm, isAdmin)) return null;
  return <p className="mt-2 text-xs text-muted-foreground">{ADMIN_MANAGED_EXPLAINER}</p>;
}
