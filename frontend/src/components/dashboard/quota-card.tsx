import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { usedPercent } from "@/lib/format";

export function QuotaCard({
  label,
  icon: Icon,
  used,
  max,
  display,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  used: number;
  max: number;
  display: (n: number) => string;
}) {
  const pct = usedPercent(used, max);
  const barColor = pct >= 90 ? "bg-destructive" : pct >= 75 ? "bg-amber-500" : "bg-primary";

  return (
    <Card>
      <CardContent className="grid gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon className="size-4" />
            {label}
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
        </div>
        <div className="text-lg font-semibold tabular-nums">
          {display(used)} <span className="text-sm font-normal text-muted-foreground">/ {display(max)}</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all", barColor)}
            style={{ width: `${pct}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
