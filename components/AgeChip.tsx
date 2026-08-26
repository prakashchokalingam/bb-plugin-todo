import { cn } from "../lib/utils";
import { formatAge } from "../lib/humanize";

export interface AgeChipProps {
  createdAt: number;
  now: number;
  className?: string;
}

/**
 * Compact "added N ago" chip showing how long ago a task was created. Pure
 * context, never urgency — unlike `DueChip`, always muted, never tone-coded.
 */
export function AgeChip({ createdAt, now, className }: AgeChipProps) {
  const { text, title } = formatAge(createdAt, now);

  return (
    <span
      className={cn(
        "text-[10px] tabular-nums whitespace-nowrap text-muted-foreground",
        className,
      )}
      title={title}
    >
      {text}
    </span>
  );
}

export default AgeChip;
