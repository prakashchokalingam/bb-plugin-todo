// Phase 4: what a Backlog/In Progress panel renders as instead of a
// `Section` while `usePanelCollapse` says it's collapsed. Two container-query
// driven shapes in one component, matching `TodoPage.tsx`'s existing
// `@container`/`@3xl:` breakpoint exactly (never a viewport media query —
// see that file's layout comment for why):
//   - Below `@3xl` (the already-stacked single-column layout): a full-width,
//     one-line BAR — label, count, expand chevron, left to right. A 40px
//     vertical rail would be nonsense once the columns are already stacked
//     full-width.
//   - At/above `@3xl` (the side-by-side layout): a ~40px vertical RAIL for
//     the full height of the row, with the label rotated to read top-to-
//     bottom.
// The whole thing is one button: click (or Enter/Space, being a real
// `<button>`) anywhere on it to restore the panel.
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Column } from "@/lib/drag";

export interface CollapsedRailProps {
  column: Column;
  /** "BACKLOG" / "IN PROGRESS" — matches the heading the expanded `Section` shows. */
  heading: string;
  /** The panel's open count (Backlog: pending tasks; In Progress: planned-not-yet-done). */
  count: number;
  onExpand: () => void;
}

export function CollapsedRail({ column, heading, count, onExpand }: CollapsedRailProps) {
  // Points "outward" toward the collapsed panel's own edge — a right-facing
  // chevron on the left (Backlog) rail, a left-facing one on the right (In
  // Progress) rail — the conventional "click here to bring the sidebar back"
  // affordance, mirroring the ⇤/⇥ icon on the panel's own collapse button
  // (`Section.tsx`) pointed the other way (toward the edge it collapses TO).
  const expandIcon: IconName = column === "backlog" ? "ChevronRight" : "ChevronLeft";

  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Expand ${heading}`}
      title={`Expand ${heading}`}
      className={cn(
        "flex h-9 w-full shrink-0 items-center justify-between gap-2 rounded-md border border-border bg-card px-2 text-xs font-medium text-muted-foreground hover:bg-muted",
        "@3xl:h-full @3xl:w-9 @3xl:flex-col @3xl:justify-between @3xl:py-2",
      )}
    >
      <span
        className={cn(
          "truncate",
          "@3xl:min-h-0 @3xl:flex-1 @3xl:[writing-mode:vertical-rl] @3xl:rotate-180 @3xl:overflow-hidden @3xl:whitespace-nowrap",
        )}
      >
        {heading}
      </span>
      <span className="shrink-0 tabular-nums @3xl:shrink-0">{count}</span>
      <Icon name={expandIcon} className="size-3.5 shrink-0" aria-hidden="true" />
    </button>
  );
}

export default CollapsedRail;
