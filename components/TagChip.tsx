import { cn } from "../lib/utils";
import { TAG_DOT_CLASS, TAG_CHIP_CLASS } from "../lib/tag-colors";
import type { TagRefDto } from "../contract";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export interface TagChipProps {
  tag: TagRefDto;
  /** Dot only, name moves into a tooltip. Used below the `md` breakpoint. */
  compact?: boolean;
  className?: string;
}

/**
 * The atomic tag rendering: a colored dot, optionally paired with the tag's
 * name. Sizing must sit inside a row's `min-h-8` without growing it, so the
 * dot and text share the compact scale `AgeChip`/`DueChip` already use — this
 * is the one place chip visuals are defined; `TagChips` only arranges these.
 */
export function TagChip({ tag, compact = false, className }: TagChipProps) {
  const dot = (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", TAG_DOT_CLASS[tag.color])}
    />
  );

  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={cn(
              "inline-flex items-center rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              className,
            )}
            aria-label={tag.name}
          >
            {dot}
          </span>
        </TooltipTrigger>
        <TooltipContent>{tag.name}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap",
        TAG_CHIP_CLASS[tag.color],
        className,
      )}
    >
      {dot}
      {tag.name}
    </span>
  );
}

export default TagChip;
