import { cn } from "@/lib/utils";

/**
 * A tiny live line chart from a rolling history array (oldest → newest). Color
 * comes from the `className` (text-*) via `currentColor`, so it themes itself.
 */
export function Sparkline({
  data,
  max,
  className,
}: {
  data: number[];
  max?: number; // fixed scale top; otherwise scales to the data's own peak
  className?: string;
}) {
  const W = 120;
  const H = 32;
  const hi = Math.max(max ?? 0, ...data, 1e-6);
  const n = data.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - (Math.min(Math.max(v, 0), hi) / hi) * H;
  const line = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("h-8 w-full text-primary", className)}
      aria-hidden="true"
    >
      {n > 1 && (
        <>
          <polygon points={`0,${H} ${line} ${W},${H}`} fill="currentColor" className="opacity-10" />
          <polyline
            points={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  );
}
