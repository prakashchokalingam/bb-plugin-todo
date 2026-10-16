// A Backlog/In Progress column: sticky header (label, optional count,
// ProgressRing) + droppable body + AddTaskRow. Both columns share one
// DndContext (owned by TodoPage); this component only registers the column
// body as a drop target for "append to this column, top-level" moves and
// empty-column drops.
//
// Since Phase 4, Backlog and In Progress render the exact same shape — a
// list of `ProjectGroup`s, then a "loose" (unfiled) group, then the add row
// — rather than Backlog specially rendering ProjectGroups while In Progress
// rendered one flat TaskRow list. The two differ only in a handful of
// `column`-gated details ProjectGroup/ProjectHeader already own (read-only
// project headers, hidden-when-empty groups, orphan-subtask trails) plus one
// difference this component itself owns: the Backlog's loose group has no
// header (a task predating projects renders exactly as it always has),
// while In Progress's loose group is labelled "Unfiled" — there is no real
// `ProjectDto` for "no project", so it can't reuse `ProjectGroup`, just a
// plain label line.
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { ProjectDto, TagColor, TagDto, TaskDto } from "@/contract";
import { cn } from "@/lib/utils";
import { dropZoneId, type Column } from "@/lib/drag";
import type { InProgressRow } from "@/lib/inProgressView";
import { Icon, type IconName } from "@/components/ui/icon";
import { ProgressRing } from "@/components/ProgressRing";
import { TaskRow, taskDragId } from "@/components/TaskRow";
import { ParentGroupHeader } from "@/components/ParentGroupHeader";
import { AddTaskRow, type ImageUpload } from "@/components/AddTaskRow";
import { ProjectGroup } from "@/components/ProjectGroup";

/**
 * Callbacks and shared live state threaded down through Section -> TaskRow.
 * Kept in one place so we're not prop-drilling a dozen individual
 * callbacks through every level.
 */
export interface BoardActions {
  /** Shared `now`, ticked once at the page level (never one interval per row). */
  now: number;
  /** Id of the task currently under the pointer while dragging, for highlight. */
  overId: string | null;
  onToggleComplete: (task: TaskDto) => void;
  onRenameTask: (id: string, title: string) => void;
  /** Saves a title and/or image changes together. Rejects on failure so the
   * editor can stay open with the user's text and images intact. */
  onUpdateTask: (
    id: string,
    patch: { title?: string; addImages?: ImageUpload[]; removeImageIds?: string[] },
  ) => Promise<void>;
  onSetDue: (id: string, dueAt: number | null, hasDueTime: boolean) => void;
  onDeleteTask: (id: string) => void;
  onCreateTask: (input: {
    stage: "pending" | "in_progress";
    parentId: string | null;
    title: string;
    /** When present the call must return a promise that rejects on failure. */
    images?: ImageUpload[];
  }) => void | Promise<void>;
  /** The global tag catalog (from `getBoard`'s `tags`), for the row picker's checklist + counts. */
  tagCatalog: TagDto[];
  /** Full-set replace, mirroring `setTaskTags`'s RPC shape exactly. */
  onSetTaskTags: (task: TaskDto, tagIds: string[]) => void;
  /** Creates a tag and resolves with its DTO so the caller can apply it immediately. */
  onCreateTag: (name: string, color: TagColor) => Promise<TagDto>;
  /** The one-click "▶ Start" affordance on a Backlog row: `setTaskStage(id,
   * "in_progress")`, optimistic, independent of the drag gesture — see
   * `TodoPage.tsx`'s `setTaskStageAction`. */
  onStartTask: (id: string) => void;
  /** The one-click "◀ Park" affordance on an In Progress row: always
   * `setTaskStage(id, "pending")`, regardless of whether the row got there
   * manually (`stage: "in_progress"`) or by auto-inclusion. This is the one
   * way left to leave In Progress without a drag gesture, now that the old
   * per-row "In Progress marker" is gone. */
  onParkTask: (id: string) => void;
  /** Opens an HTTP(S) link from a task title through the host. Returns true
   * when the host took the URL, so the anchor skips its own navigation.
   * Optional: without it, links fall back to the anchor's default. */
  onOpenUrl?: (url: string) => boolean;
}

/** One project's slice of a column: its own tasks, plus (In Progress only)
 * standalone orphan subtasks whose parent doesn't itself qualify. Mirrors
 * `lib/inProgressView.ts`'s `InProgressProjectGroup` shape exactly for In
 * Progress; the Backlog builds the same shape with `orphanSubtasks` always
 * empty, since a comprehensive tree never orphans anything (a subtask's
 * parent is always right there). One shape, one render path, for both
 * columns. */
export interface SectionProjectGroup {
  project: ProjectDto;
  tasks: TaskDto[];
  orphanSubtasks?: TaskDto[];
  /** In Progress-only: `tasks` + `orphanSubtasks` re-interleaved into
   * ordered rows (`InProgressProjectGroup.rows`). `undefined` for the
   * Backlog's groups, which never carry this — see `ProjectGroup`'s
   * `rows` prop for how its presence/absence switches the render path. */
  rows?: InProgressRow[];
}

export interface SectionProps {
  /** Which column this is — also the drop-zone/drag-id "column" scope
   * threaded through `dropZoneId`/`taskDragId` (see `lib/drag.ts`). */
  column: Column;
  heading: string;
  /** Shown as "· N pending" next to the heading; omitted (e.g. for In Progress) when undefined. */
  count?: number;
  ringValue: number;
  ringTotal: number;
  ringTone: "primary" | "destructive";
  ringLabel: string;
  actions: BoardActions;
  addPlaceholder: string;

  /** Every project that has anything to show in this column, each with its
   * own tasks (+ orphans). Backlog: every project, always (a project is a
   * durable container — see `ProjectGroup`'s empty-group handling). In
   * Progress: `InProgressProjectGroup[]` from `lib/inProgressView`, already
   * filtered to non-empty groups. */
  projectGroups: SectionProjectGroup[];
  /** Top-level tasks filed to no project ("loose"/unfiled). */
  looseTasks: TaskDto[];
  /** In Progress-only: inProgress subtasks whose parent is loose (no
   * project) and doesn't itself qualify — standalone, trailed rows in the
   * "Unfiled" group. */
  looseOrphanSubtasks?: TaskDto[];
  /** In Progress-only: `looseTasks` + `looseOrphanSubtasks` re-interleaved
   * into ordered rows (`InProgressView.looseRows`) — the Unfiled group
   * gets the same parent-grouping treatment as every project card. */
  looseRows?: InProgressRow[];

  /** `column` is this Section's own `column` prop — collapse state is
   * per-column (`ProjectDto.collapsed`/`inProgressCollapsed`), so the caller
   * needs to know which one this toggle is for. */
  onToggleProjectCollapsed?: (project: ProjectDto, column: Column) => void;
  /** Backlog-only. */
  onRenameProject?: (id: string, name: string) => void;
  onChangeProjectColor?: (id: string, color: TagColor) => void;
  onDeleteProject?: (id: string) => void;
  onAddTaskToProject?: (projectId: string, title: string, images?: ImageUpload[]) => void | Promise<void>;
  onHeaderAddClick?: (projectId: string) => void;
  /** `#Name` typed into the add-row creates a project inline instead of a task. */
  onCreateProject?: (name: string) => void;

  /** Clicking a trail segment scrolls the Backlog to the source row and flashes it. */
  onNavigateToProject?: (projectId: string) => void;
  onNavigateToParent?: (parentId: string) => void;

  /**
   * Phase 4 panel collapse (`hooks/usePanelCollapse.ts`, orthogonal to the
   * per-project `onToggleProjectCollapsed` above): fired by either the
   * chevron next to the heading or the icon button on the header's far
   * right. `Section` only ever renders while EXPANDED — the collapsed shape
   * is `CollapsedRail`, rendered instead of `Section` by `TodoPage.tsx` — so
   * this only ever means "collapse me", never "toggle".
   */
  onCollapse?: () => void;
}

export function Section({
  column,
  heading,
  count,
  ringValue,
  ringTotal,
  ringTone,
  ringLabel,
  actions,
  addPlaceholder,
  projectGroups,
  looseTasks,
  looseOrphanSubtasks = [],
  looseRows,
  onToggleProjectCollapsed,
  onRenameProject,
  onChangeProjectColor,
  onDeleteProject,
  onAddTaskToProject,
  onHeaderAddClick,
  onCreateProject,
  onNavigateToProject,
  onNavigateToParent,
  onCollapse,
}: SectionProps) {
  const isInProgress = column === "in_progress";
  // ⇤ for the left (Backlog) panel, ⇥ for the right (In Progress) one — the
  // closest existing glyphs to that pair are the sidebar-toggle icons
  // already in the icon set (`components/ui/icon.tsx`), each pointing
  // toward the edge this panel collapses to.
  const collapseIcon: IconName = column === "backlog" ? "PanelLeft" : "PanelRight";
  const headingChevron: IconName = column === "backlog" ? "ChevronLeft" : "ChevronRight";

  const { setNodeRef, isOver } = useDroppable({
    id: dropZoneId("section", column),
    data: { kind: "section", column },
  });

  const projectIds = projectGroups.map((g) => g.project.id);
  const inProgressColumn = column === "in_progress";
  const looseSortableIds = [
    ...looseTasks.flatMap((t) => [
      taskDragId(t, inProgressColumn),
      ...t.subtasks.map((s) => taskDragId(s, inProgressColumn)),
    ]),
    ...looseOrphanSubtasks.map((s) => taskDragId(s, inProgressColumn)),
  ];
  const empty =
    looseTasks.length === 0 && looseOrphanSubtasks.length === 0 && projectGroups.length === 0;

  function handleAddSubmit(title: string, images?: ImageUpload[]): void | Promise<void> {
    // Inline project creation (design doc "Creating a project", entry point
    // 1): `#Name` + Enter in the Backlog's own add-row creates a project
    // instead of a loose task. Only offered where the caller wired
    // `onCreateProject` (the Backlog section) — In Progress's add-row never
    // creates projects.
    if (onCreateProject && title.startsWith("#") && !images) {
      const name = title.slice(1).trim();
      if (name.length > 0) onCreateProject(name);
      return;
    }
    return actions.onCreateTask({
      stage: column === "in_progress" ? "in_progress" : "pending",
      parentId: null,
      title,
      ...(images ? { images } : {}),
    });
  }

  return (
    <section className="flex flex-col gap-1.5">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-background px-1 py-1 text-xs">
        {/* The whole heading row is the collapse control too (design doc
            "chevron next to the heading, whole row clickable"); a no-op
            (`undefined` onClick) when the caller doesn't wire panel collapse
            at all, so this degrades to a plain heading. */}
        <button
          type="button"
          onClick={onCollapse}
          disabled={!onCollapse}
          aria-label={`Collapse ${heading} (heading)`}
          className="flex min-w-0 flex-1 items-center gap-1 text-left disabled:cursor-default"
        >
          {onCollapse && (
            <Icon
              name={headingChevron}
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <span className="truncate font-medium text-muted-foreground">
            {heading}
            {count !== undefined ? ` · ${count} pending` : ""}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <ProgressRing
            done={ringValue}
            total={ringTotal}
            tone={ringTone}
            label={ringLabel}
            ariaLabel={`${heading}: ${ringLabel}`}
            size={18}
          />
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label={`Collapse ${heading}`}
              title={`Collapse ${heading}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <Icon name={collapseIcon} className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "divide-y divide-border rounded-md border border-border bg-card",
          isOver && "ring-1 ring-primary",
        )}
      >
        {projectGroups.length > 0 && (
          <SortableContext items={projectIds} strategy={verticalListSortingStrategy}>
            {projectGroups.map(({ project, tasks, orphanSubtasks, rows }) => (
              <ProjectGroup
                key={project.id}
                project={project}
                tasks={tasks}
                orphanSubtasks={orphanSubtasks}
                rows={rows}
                actions={actions}
                variant={column}
                onToggleCollapsed={(p) => onToggleProjectCollapsed?.(p, column)}
                onRenameProject={(id, name) => onRenameProject?.(id, name)}
                onChangeProjectColor={(id, color) => onChangeProjectColor?.(id, color)}
                onDeleteProject={(id) => onDeleteProject?.(id)}
                onAddTaskToProject={(projectId, title, images) =>
                  images ? onAddTaskToProject?.(projectId, title, images) : onAddTaskToProject?.(projectId, title)
                }
                onHeaderAddClick={() => onHeaderAddClick?.(project.id)}
                onNavigateToProject={onNavigateToProject}
                onNavigateToParent={onNavigateToParent}
              />
            ))}
          </SortableContext>
        )}

        {/* The loose/unfiled group: no header in the Backlog (a task
            predating projects renders exactly as it always has); a plain
            "Unfiled" label in In Progress, mirroring the mockup — there is
            no real `ProjectDto` for "no project", so this can't reuse
            `ProjectGroup` the way a real project's group does. */}
        {isInProgress && (looseTasks.length > 0 || looseOrphanSubtasks.length > 0) && (
          <div className="flex min-h-8 items-center gap-2 px-2 py-1 text-sm font-medium text-muted-foreground">
            Unfiled
          </div>
        )}

        <SortableContext items={looseSortableIds} strategy={verticalListSortingStrategy}>
          {empty && (
            <div className="px-2 py-3 text-xs text-muted-foreground">Nothing here yet.</div>
          )}
          {/* Unfiled gets the same row treatment too, In Progress only —
           * mirrors `ProjectGroup`'s own `rows`-present branch exactly.
           * `looseRows` is only ever passed for the In Progress Section
           * (see `TodoPage.tsx`), so the Backlog always falls through to
           * the original flat rendering below, unchanged. No trail on
           * either row kind: a `"task"` row nests its own subtasks, and a
           * `"parentGroup"` row's header already names the parent — the
           * loose group has no project to name either way. */}
          {looseRows
            ? looseRows.map((row) =>
                row.kind === "task" ? (
                  <TaskRow
                    key={row.task.id}
                    task={row.task}
                    actions={actions}
                    inProgressColumn
                    onNavigateToProject={onNavigateToProject}
                    onNavigateToParent={onNavigateToParent}
                  />
                ) : (
                  <div key={`parent:${row.parentId}`}>
                    <ParentGroupHeader
                      parentId={row.parentId}
                      parentTitle={row.parentTitle}
                      onNavigateToParent={onNavigateToParent}
                    />
                    {row.tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        actions={actions}
                        inProgressColumn
                        indent
                        onNavigateToProject={onNavigateToProject}
                        onNavigateToParent={onNavigateToParent}
                      />
                    ))}
                  </div>
                ),
              )
            : (
                <>
                  {looseTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      actions={actions}
                      inProgressColumn={inProgressColumn}
                      onNavigateToProject={onNavigateToProject}
                      onNavigateToParent={onNavigateToParent}
                    />
                  ))}
                  {looseOrphanSubtasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      actions={actions}
                      inProgressColumn={inProgressColumn}
                      showTrail
                      onNavigateToProject={onNavigateToProject}
                      onNavigateToParent={onNavigateToParent}
                    />
                  ))}
                </>
              )}
        </SortableContext>
        <AddTaskRow placeholder={addPlaceholder} onSubmit={handleAddSubmit} />
      </div>
    </section>
  );
}

export default Section;
