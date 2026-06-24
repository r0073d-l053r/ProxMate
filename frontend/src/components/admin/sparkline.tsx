/**
 * Tiny SVG sparkline for a rolling time series.
 *
 * The horizontal "scrolling" feel comes from always sampling the same fixed
 * window (`SAMPLES`): as a new sample is pushed in on the right, the oldest
 * falls off the left, so the line visually slides leftward at 1 sample/tick.
 */

interface Props {
  values: number[];
  /** Max value the chart should normalize against (e.g. maxcpu cores, maxmem bytes). */
  max: number;
  /** Optional fixed peak label shown bottom-right (units already formatted). */
  peakLabel?: string;
  /** Optional current label shown top-right (units already formatted). */
  currentLabel?: string;
  color?: string;
  height?: number;
  width?: number;
  /** Hover tooltip — shown next to the title. */
  title: string;
}

export function Sparkline({
  values,
  max,
  peakLabel,
  currentLabel,
  color = "var(--primary)",
  height = 36,
  width = 180,
  title,
}: Props) {
  const safeMax = max > 0 ? max : 1;
  const n = values.length;

  // Render a baseline rectangle and a polyline. Empty/short series fall back
  // to a flat baseline so the layout doesn't jump as samples accumulate.
  const points =
    n < 2
      ? `0,${height} ${width},${height}`
      : values
          .map((v, i) => {
            const x = (i / (n - 1)) * width;
            // Clamp into the chart's height; bound y to [0, height] so spikes don't escape.
            const norm = Math.max(0, Math.min(1, v / safeMax));
            const y = height - norm * height;
            return `${x},${y.toFixed(1)}`;
          })
          .join(" ");

  const fillPath = `M 0,${height} L ${points} L ${width},${height} Z`;

  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{title}</span>
        {currentLabel && <span className="font-medium text-foreground tabular-nums">{currentLabel}</span>}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="overflow-visible"
        aria-hidden
      >
        <rect x={0} y={0} width={width} height={height} fill="var(--muted)" opacity={0.4} rx={3} />
        {n >= 2 && (
          <>
            <path d={fillPath} fill={color} opacity={0.18} />
            <polyline
              points={points}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
      {peakLabel && (
        <div className="text-[10px] text-muted-foreground tabular-nums">peak {peakLabel}</div>
      )}
    </div>
  );
}
