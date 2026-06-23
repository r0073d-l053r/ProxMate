import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { VmStatus } from "@/lib/types";

const STATUS: Record<string, { label: string; dot: string }> = {
  running: { label: "Running", dot: "bg-emerald-500" },
  stopped: { label: "Stopped", dot: "bg-muted-foreground" },
  creating: { label: "Creating", dot: "bg-amber-500 animate-pulse" },
  error: { label: "Error", dot: "bg-destructive" },
};

export function VmStatusBadge({ status }: { status: VmStatus | string }) {
  const meta = STATUS[status] ?? { label: status, dot: "bg-muted-foreground" };
  return (
    <Badge variant="outline" className="gap-1.5">
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  );
}
