import { TriangleAlert } from "lucide-react";
import type { VirtualMachine } from "@/lib/types";

/**
 * A machine is held while its row carries a hold reason (a create, rebuild or
 * restore that didn't finish, or a restore that left it over quota) or sits in
 * `error`. The backend refuses to start it or open its console/IDE until it is
 * repaired; the UI mirrors that so the controls aren't a dead end.
 */
export function isVmHeld(vm: Pick<VirtualMachine, "status" | "holdReason">): boolean {
  return !!vm.holdReason || vm.status === "error";
}

/** Explains why a held machine can't run and what is still possible. */
export function HoldBanner({ vm }: { vm: Pick<VirtualMachine, "status" | "holdReason"> }) {
  if (!isVmHeld(vm)) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
    >
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
      <div>
        <p className="font-medium">This machine can&rsquo;t be started right now</p>
        <p className="text-muted-foreground">
          {vm.holdReason ??
            "Something went wrong with this machine. Restore a backup, rebuild it, or ask an admin to check it."}
        </p>
        <p className="mt-1 text-muted-foreground">Start, the console and the IDE stay unavailable until it is repaired.</p>
      </div>
    </div>
  );
}
