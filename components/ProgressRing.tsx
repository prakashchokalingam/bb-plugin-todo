import { cn } from "../lib/utils";

export interface ProgressRingProps {
  done: number;
  total: number;
  size?: number;
  className?: string;
  /** Arc color: `primary` (default) or `destructive`. The track stays muted. */
  tone?: "primary" | "destructive";
  /** Overrides the default `done/total` numeric label (e.g. "3/12 overdue"). */
  label?: string;
  /** Overrides the default "N of M subtasks done" accessible name. */
  ariaLabel?: string;
}

const DEFAULT_SIZE = 14;
const STROKE_WIDTH = 2.5;

const ARC_CLASSES: Record<NonNullable<ProgressRingProps["tone"]>, string> = {
  primary: "text-primary",
  destructive: "text-destructive",
};

/**
 * Inline SVG donut showing `done/total`, plus a compact numeric label.
 * Renders nothing when `total` is 0. Sized to sit inline in a compact
 * (`min-h-8`) row.
 */
export function ProgressRing({
  done,
  total,
  size = DEFAULT_SIZE,
  className,
  tone = "primary",
  label,
  ariaLabel,
}: ProgressRingProps) {
  if (total <= 0) return null;

  const clampedDone = Math.max(0, Math.min(done, total));
  const radius = (size - STROKE_WIDTH) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = clampedDone / total;
  const dashOffset = circumference * (1 - fraction);
  const center = size / 2;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground",
        className,
      )}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={ariaLabel ?? `${clampedDone} of ${total} subtasks done`}
        className="shrink-0"
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          className="stroke-current text-muted-foreground opacity-40"
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
          className={cn("stroke-current", ARC_CLASSES[tone])}
        />
      </svg>
      <span aria-hidden="true">{label ?? `${clampedDone}/${total}`}</span>
    </span>
  );
}

export default ProgressRing;
