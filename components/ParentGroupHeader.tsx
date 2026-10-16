// The header for a parent-task-grouped slice of an In Progress project
// card: `Project -> parent task -> tasks`. This replaces the tag level's
// `TagSubgroup` header for that middle tier of the hierarchy, so it is
// built to read as the *same* grouping level visually — same height,
// padding, and muted weight — even though what it groups by (a parent
// task, not a tag) is different in two ways that show up below.
//
// No colour dot: unlike a tag or a project, a parent task has no
// `TagColor` to resolve a dot from, and pretending otherwise would imply a
// categorisation that doesn't exist for this level.
//
// No count chip: deliberately omitted. `TagSubgroup`'s count answers "how
// many tasks share this tag" — a useful filter-shaped question. "How many
// subtasks does this parent have" is not the equivalent question for a
// grouping the user is already looking directly at the members of, so a
// count here would just be noise.
//
// Not collapsible: matches `TagSubgroup`, which never implemented collapse
// either (the feature spec calls it optional) — no collapse state here.
import { cn } from "@/lib/utils";
import { firstLine, isMultiline, singleLineLabel } from "@/lib/taskText";

export interface ParentGroupHeaderProps {
  parentId: string;
  parentTitle: string;
  onNavigateToParent?: (parentId: string) => void;
}

export function ParentGroupHeader({
  parentId,
  parentTitle,
  onNavigateToParent,
}: ParentGroupHeaderProps) {
  // An unlabelled group header is pure noise — there is nothing useful to
  // click through to, and an empty muted bar would just look like a
  // rendering glitch.
  if (!parentTitle.trim()) return null;

  return (
    <div className="flex min-h-6 items-center gap-1.5 pl-6 pr-2 py-0.5 text-xs font-medium text-muted-foreground">
      <button
        type="button"
        title={isMultiline(parentTitle) ? singleLineLabel(parentTitle) : undefined}
        aria-label={isMultiline(parentTitle) ? singleLineLabel(parentTitle) : undefined}
        onClick={() => onNavigateToParent?.(parentId)}
        className={cn(
          // Same hover/focus click affordance as TrailLine's parent
          // segment, so the two navigate-to-parent affordances in this
          // column feel like the same control.
          "min-w-0 truncate text-left text-muted-foreground hover:text-foreground focus-visible:text-foreground",
          // Unlike TrailLine's parent segment, this title IS the primary
          // label of the header (not a secondary breadcrumb where the
          // nearest ancestor matters most), so it truncates normally from
          // the right — plain `truncate`, no `dir="rtl"` + `<bdi>` trick.
        )}
      >
        {firstLine(parentTitle)}
      </button>
    </div>
  );
}

export default ParentGroupHeader;
