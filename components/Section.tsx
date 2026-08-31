// A Backlog/Today column: sticky header (label, optional count, ProgressRing)
// + droppable body + AddTaskRow. Both columns share one DndContext (owned by
// TodoPage); this component only registers the column body as a drop target
// for "append to this column, top-level" moves and empty-column drops.
//
// Since Phase 4, Backlog and Today render the exact same shape — a list of
// `ProjectGroup`s, then a "loose" (unfiled) group, then the add row — rather
// than Backlog specially rendering ProjectGroups while Today rendered one
// flat TaskRow list. The two differ only in a handful of `column`-gated
// details ProjectGroup/ProjectHeader already own (read-only project headers,
// hidden-when-empty groups, orphan-subtask trails) plus one difference this
// component itself owns: the Backlog's loose group has no header (a task
// predating projects renders exactly as it always has), while Today's loose
// group is labelled "Unfiled" — there is no real `ProjectDto` for "no
// project", so it can't reuse `ProjectGroup`, just a plain label line.
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { ProjectDto, TagColor, TagDto, TaskDto } from "@/contract";
import { cn } from "@/lib/utils";
import { dropZoneId, type Bucket } from "@/lib/drag";
import { ProgressRing } from "@/components/ProgressRing";
import { TaskRow, taskDragId } from "@/components/TaskRow";
import { AddTaskRow } from "@/components/AddTaskRow";
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
  onSetDue: (id: string, dueAt: number | null, hasDueTime: boolean) => void;
  onDeleteTask: (id: string) => void;
  onCreateTask: (input: {
    bucket: "backlog" | "today";
    parentId: string | null;
    title: string;
  }) => void;
  /** The global tag catalog (from `getBoard`'s `tags`), for the row picker's checklist + counts. */
  tagCatalog: TagDto[];
  /** Full-set replace, mirroring `setTaskTags`'s RPC shape exactly. */
  onSetTaskTags: (task: TaskDto, tagIds: string[]) => void;
  /** Creates a tag and resolves with its DTO so the caller can apply it immediately. */
  onCreateTag: (name: string, color: TagColor) => Promise<TagDto>;
}

/** One project's slice of a column: its own tasks, plus (Today only)
 * standalone orphan subtasks whose parent doesn't itself qualify. Mirrors
 * `lib/todayView.ts`'s `TodayProjectGroup` shape exactly for Today; the
 * Backlog builds the same shape with `orphanSubtasks` always empty, since a
 * comprehensive tree never orphans anything (a subtask's parent is always
 * right there). One shape, one render path, for both columns. */
export interface SectionProjectGroup {
  project: ProjectDto;
  tasks: TaskDto[];
  orphanSubtasks?: TaskDto[];
}

export interface SectionProps {
  /** Which column this is — also the drop-zone/drag-id "column" scope
   * threaded through `dropZoneId`/`taskDragId` (see `lib/drag.ts`). */
  column: Bucket;
  heading: string;
  /** Shown as "· N" next to the heading; omitted (e.g. for Today) when undefined. */
  count?: number;
  ringValue: number;
  ringTotal: number;
  ringTone: "primary" | "destructive";
  ringLabel: string;
  actions: BoardActions;
  addPlaceholder: string;

  /** Every project that has anything to show in this column, each with its
   * own tasks (+ orphans). Backlog: every project, always (a project is a
   * durable container — see `ProjectGroup`'s empty-group handling). Today:
   * `TodayProjectGroup[]` from `lib/todayView`, already filtered to
   * non-empty groups. */
  projectGroups: SectionProjectGroup[];
  /** Top-level tasks filed to no project ("loose"/unfiled). */
  looseTasks: TaskDto[];
  /** Today-only: inToday subtasks whose parent is loose (no project) and
   * doesn't itself qualify — standalone, trailed rows in the "Unfiled" group. */
  looseOrphanSubtasks?: TaskDto[];

  onToggleProjectCollapsed?: (project: ProjectDto) => void;
  /** Backlog-only. */
  onRenameProject?: (id: string, name: string) => void;
  onChangeProjectColor?: (id: string, color: TagColor) => void;
  onDeleteProject?: (id: string) => void;
  onAddTaskToProject?: (projectId: string, title: string) => void;
  onHeaderAddClick?: (projectId: string) => void;
  /** `#Name` typed into the add-row creates a project inline instead of a task. */
  onCreateProject?: (name: string) => void;

  /** Fired when a row's today marker is clicked, to remove it from Today —
   * routed by the caller to `moveTask` or `dismissFromToday` depending on
   * how the task got there (see `TodoPage.tsx`'s `removeFromToday`). */
  onRemoveFromToday?: (id: string) => void;
  /** Clicking a trail segment scrolls the Backlog to the source row and flashes it. */
  onNavigateToProject?: (projectId: string) => void;
  onNavigateToParent?: (parentId: string) => void;
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
  onToggleProjectCollapsed,
  onRenameProject,
  onChangeProjectColor,
  onDeleteProject,
  onAddTaskToProject,
  onHeaderAddClick,
  onCreateProject,
  onRemoveFromToday,
  onNavigateToProject,
  onNavigateToParent,
}: SectionProps) {
  const isToday = column === "today";

  const { setNodeRef, isOver } = useDroppable({
    id: dropZoneId("section", column),
    data: { kind: "section", column },
  });

  const projectIds = projectGroups.map((g) => g.project.id);
  const inTodayColumn = column === "today";
  const looseSortableIds = [
    ...looseTasks.flatMap((t) => [
      taskDragId(t, inTodayColumn),
      ...t.subtasks.map((s) => taskDragId(s, inTodayColumn)),
    ]),
    ...looseOrphanSubtasks.map((s) => taskDragId(s, inTodayColumn)),
  ];
  const empty =
    looseTasks.length === 0 && looseOrphanSubtasks.length === 0 && projectGroups.length === 0;

  function handleAddSubmit(title: string) {
    // Inline project creation (design doc "Creating a project", entry point
    // 1): `#Name` + Enter in the Backlog's own add-row creates a project
    // instead of a loose task. Only offered where the caller wired
    // `onCreateProject` (the Backlog section) — Today's add-row never
    // creates projects.
    if (onCreateProject && title.startsWith("#")) {
      const name = title.slice(1).trim();
      if (name.length > 0) onCreateProject(name);
      return;
    }
    actions.onCreateTask({ bucket: column, parentId: null, title });
  }

  return (
    <section className="flex flex-col gap-1.5">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-background px-1 py-1 text-xs">
        <span className="font-medium text-muted-foreground">
          {heading}
          {count !== undefined ? ` · ${count}` : ""}
        </span>
        <ProgressRing
          done={ringValue}
          total={ringTotal}
          tone={ringTone}
          label={ringLabel}
          ariaLabel={`${heading}: ${ringLabel}`}
          size={18}
        />
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
            {projectGroups.map(({ project, tasks, orphanSubtasks }) => (
              <ProjectGroup
                key={project.id}
                project={project}
                tasks={tasks}
                orphanSubtasks={orphanSubtasks}
                actions={actions}
                variant={column}
                onToggleCollapsed={(p) => onToggleProjectCollapsed?.(p)}
                onRenameProject={(id, name) => onRenameProject?.(id, name)}
                onChangeProjectColor={(id, color) => onChangeProjectColor?.(id, color)}
                onDeleteProject={(id) => onDeleteProject?.(id)}
                onAddTaskToProject={(projectId, title) => onAddTaskToProject?.(projectId, title)}
                onHeaderAddClick={() => onHeaderAddClick?.(project.id)}
                onRemoveFromToday={onRemoveFromToday}
                onNavigateToProject={onNavigateToProject}
                onNavigateToParent={onNavigateToParent}
              />
            ))}
          </SortableContext>
        )}

        {/* The loose/unfiled group: no header in the Backlog (a task
            predating projects renders exactly as it always has); a plain
            "Unfiled" label in Today, mirroring the mockup — there is no real
            `ProjectDto` for "no project", so this can't reuse `ProjectGroup`
            the way a real project's group does. */}
        {isToday && (looseTasks.length > 0 || looseOrphanSubtasks.length > 0) && (
          <div className="flex min-h-8 items-center gap-2 px-2 py-1 text-sm font-medium text-muted-foreground">
            Unfiled
          </div>
        )}

        <SortableContext items={looseSortableIds} strategy={verticalListSortingStrategy}>
          {empty && (
            <div className="px-2 py-3 text-xs text-muted-foreground">Nothing here yet.</div>
          )}
          {looseTasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              actions={actions}
              inTodayColumn={inTodayColumn}
              onRemoveFromToday={onRemoveFromToday}
              onNavigateToProject={onNavigateToProject}
              onNavigateToParent={onNavigateToParent}
            />
          ))}
          {looseOrphanSubtasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              actions={actions}
              inTodayColumn={inTodayColumn}
              showTrail
              onRemoveFromToday={onRemoveFromToday}
              onNavigateToProject={onNavigateToProject}
              onNavigateToParent={onNavigateToParent}
            />
          ))}
        </SortableContext>
        <AddTaskRow placeholder={addPlaceholder} onSubmit={handleAddSubmit} />
      </div>
    </section>
  );
}

export default Section;
