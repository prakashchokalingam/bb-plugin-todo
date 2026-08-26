import { cn } from "../lib/utils";
import { formatDue, type DueTone } from "../lib/humanize";

export interface DueChipProps {
  dueAt: number | null;
  hasDueTime: boolean;
  now: number;
  className?: string;
}

const TONE_CLASSES: Record<DueTone, string> = {
  neutral: "text-muted-foreground",
  soon: "text-amber-600 dark:text-amber-500",
  late: "text-destructive",
};

function formatAbsolute(dueAt: number, hasDueTime: boolean): string {
  const d = new Date(dueAt);
  const datePart = d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  if (!hasDueTime) return datePart;
  const timePart = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${datePart} ${timePart}`;
}

/**
 * Compact, live-ticking, tone-coded due-date chip. Renders nothing when
 * there is no due date set.
 */
export function DueChip({ dueAt, hasDueTime, now, className }: DueChipProps) {
  if (dueAt === null) return null;

  const { text, tone } = formatDue(dueAt, now, hasDueTime);

  return (
    <span
      className={cn(
        "text-xs tabular-nums whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
      title={formatAbsolute(dueAt, hasDueTime)}
    >
      {text}
    </span>
  );
}

export default DueChip;
