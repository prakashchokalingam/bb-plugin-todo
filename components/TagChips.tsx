import { cn } from "../lib/utils";
import type { TagRefDto } from "../contract";
import { TagChip } from "./TagChip";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export interface TagChipsProps {
  tags: TagRefDto[];
  className?: string;
}

const FULL_CAP = 3;
const COMPACT_CAP = 5;

/** `+N` overflow marker; its tooltip lists the tag names it is hiding. */
function Overflow({ tags }: { tags: TagRefDto[] }) {
  if (tags.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
          aria-label={`${tags.length} more tags`}
        >
          +{tags.length}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tags.map((t) => t.name).join(", ")}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A row's full tag list, rendered as a breakpoint pair rather than measured
 * in JS — the same `hidden md:flex` / `flex md:hidden` trick `AgeChip`
 * already relies on. Each side caps independently (3 full chips at `md`+, 5
 * dots below it) because a bare dot takes far less width than a name.
 */
export function TagChips({ tags, className }: TagChipsProps) {
  if (tags.length === 0) return null;

  const fullShown = tags.slice(0, FULL_CAP);
  const fullHidden = tags.slice(FULL_CAP);
  const compactShown = tags.slice(0, COMPACT_CAP);
  const compactHidden = tags.slice(COMPACT_CAP);

  return (
    <>
      <span className={cn("hidden md:flex items-center gap-1", className)}>
        {fullShown.map((tag) => (
          <TagChip key={tag.id} tag={tag} />
        ))}
        <Overflow tags={fullHidden} />
      </span>
      <span className={cn("flex md:hidden items-center gap-1", className)}>
        {compactShown.map((tag) => (
          <TagChip key={tag.id} tag={tag} compact />
        ))}
        <Overflow tags={compactHidden} />
      </span>
    </>
  );
}

export default TagChips;
