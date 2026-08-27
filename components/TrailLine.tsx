// The muted second line under a Today row: `# Project > Parent`. Renders
// null whenever there is no context to show (a loose top-level task never
// gains a second line). Each segment is a plain button — click-through to
// the source row is the caller's job (scrolling/flashing lands in Phase 6);
// this component only fires the callback.
import { cn } from "@/lib/utils";
import { TAG_DOT_CLASS } from "@/lib/tag-colors";
import type { TrailDto } from "@/contract";

export interface TrailLineProps {
  trail: TrailDto | null | undefined;
  onNavigateToProject?: (projectId: string) => void;
  onNavigateToParent?: (parentId: string) => void;
  className?: string;
}

/**
 * `# Project > Parent`, muted, truncating from the LEFT so the nearest
 * ancestor (the most useful segment) survives — `# Q3 Launch > ...boarding
 * email`. Achieved with the `dir="rtl"` + `truncate` trick rather than JS
 * measurement: reversing direction moves the ellipsis to the start of the
 * inline box while keeping the tail of the string visible.
 *
 * Below `md` it collapses to the project badge alone, using the same
 * two-sibling-elements `hidden md:flex` / `flex md:hidden` breakpoint pair
 * `TagChips` already relies on — never JS measurement.
 */
export function TrailLine({
  trail,
  onNavigateToProject,
  onNavigateToParent,
  className,
}: TrailLineProps) {
  if (!trail) return null;

  const hasProject = trail.projectId !== null && trail.projectName !== null;
  const hasParent = trail.parentId !== null && trail.parentTitle !== null;
  if (!hasProject && !hasParent) return null;

  const projectBadge = hasProject ? (
    <button
      type="button"
      onClick={() => onNavigateToProject?.(trail.projectId as string)}
      className="inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
    >
      {trail.projectColor && (
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", TAG_DOT_CLASS[trail.projectColor])}
        />
      )}
      <span className="truncate">{trail.projectName}</span>
    </button>
  ) : null;

  const parentSegment = hasParent ? (
    <button
      type="button"
      dir="rtl"
      onClick={() => onNavigateToParent?.(trail.parentId as string)}
      className="min-w-0 flex-1 truncate text-left text-muted-foreground hover:text-foreground focus-visible:text-foreground"
    >
      {/* `dir="rtl"` puts the ellipsis on the left, but it also drags neutral
       * characters with it — a title ending in punctuation renders as
       * "?Ship it", and paired brackets come out mirrored. `<bdi>` is an
       * inline isolate: its contents re-order by their own (LTR) direction
       * while the box stays RTL, so the ellipsis stays on the left and the
       * text still reads correctly. Do not remove without replacing the
       * isolate — jsdom cannot lay text out, so no test will catch it. */}
      <bdi>{trail.parentTitle}</bdi>
    </button>
  ) : null;

  return (
    <div className={cn("flex min-w-0 items-center gap-1 pl-8 text-[10px]", className)}>
      <span className="hidden md:flex min-w-0 items-center gap-1">
        {projectBadge}
        {hasProject && hasParent && (
          <span aria-hidden="true" className="shrink-0">
            &gt;
          </span>
        )}
        {parentSegment}
      </span>
      {/* Below md the trail collapses to the badge alone — but a subtask
       * whose parent is loose has no badge, and an empty padded line would
       * violate "renders only when there is context to show". Fall back to
       * the parent segment in that case. */}
      <span className="flex md:hidden min-w-0 items-center gap-1">
        {projectBadge ?? parentSegment}
      </span>
    </div>
  );
}

export default TrailLine;
