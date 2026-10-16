// A project's card.
//
// variant="backlog" (default): today's existing behaviour, entirely
// unchanged — ProjectHeader + a droppable body (append-to-project / re-home
// drop target) + a per-project AddTaskRow. Collapsed renders the header
// alone; an empty expanded project renders the header plus its add-row
// only (a project is a durable container — an empty one just reads as a
// plan not yet written).
//
// variant="in_progress": the header is a plain, non-draggable group label
// (no project reordering from In Progress — see ProjectHeader). No
// per-project add-row (scheduling/filing is a Backlog-only operation).
// Renders nothing at all when it has no qualifying tasks AND no orphan
// subtasks — In Progress is an ephemeral filtered view, so an empty box
// there is pure noise, unlike the Backlog's durable-container case above.
// `orphanSubtasks` (inProgress subtasks whose parent isn't inProgress, from
// `lib/inProgressView`) render as standalone rows with their trail shown,
// after the nested ones.
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import type { ProjectDto, TagColor, TaskDto } from "@/contract";
import { cn } from "@/lib/utils";
import { dropZoneId, type Column } from "@/lib/drag";
import type { InProgressRow } from "@/lib/inProgressView";
import { ProjectHeader } from "@/components/ProjectHeader";
import { TaskRow, taskDragId } from "@/components/TaskRow";
import { ParentGroupHeader } from "@/components/ParentGroupHeader";
import { AddTaskRow, type ImageUpload } from "@/components/AddTaskRow";
import type { BoardActions } from "@/components/Section";

export interface ProjectGroupProps {
  project: ProjectDto;
  /** Top-level tasks filed to this project. In the Backlog, this is
   * unconditionally every open top-level task filed here (the Backlog is
   * comprehensive). In In Progress, this is `InProgressProjectGroup.tasks`
   * from `lib/inProgressView` — top-level rows that are themselves
   * `inProgress`, with `subtasks` already narrowed to inProgress-only. */
  tasks: TaskDto[];
  actions: BoardActions;
  variant?: "backlog" | "in_progress";
  /** In Progress-only: `inProgress` subtasks whose parent does NOT qualify,
   * from `InProgressProjectGroup.orphanSubtasks`. Rendered standalone, with
   * a trail, after the nested tasks above. */
  orphanSubtasks?: TaskDto[];
  /** In Progress-only: `tasks` + `orphanSubtasks` above, re-interleaved into
   * ordered rows (`InProgressProjectGroup.rows`, from `lib/inProgressView`).
   * When present (i.e. whenever `variant="in_progress"`), this REPLACES the
   * flat tasks-then-orphans rendering below with one row per entry —
   * `tasks`/`orphanSubtasks` are still used for sortable-id registration
   * and the empty-group check, just not for direct rendering. `undefined`
   * for the Backlog, which never groups by parent task at all. */
  rows?: InProgressRow[];
  onToggleCollapsed: (project: ProjectDto) => void;
  /** Backlog-only. */
  onRenameProject?: (id: string, name: string) => void;
  onChangeProjectColor?: (id: string, color: TagColor) => void;
  onDeleteProject?: (id: string) => void;
  onAddTaskToProject?: (projectId: string, title: string, images?: ImageUpload[]) => void | Promise<void>;
  /** Forwarded from the header's "+" affordance. Focusing/revealing the
   * add-row input is Phase 6's job; this component stays dumb. */
  onHeaderAddClick?: () => void;
  onNavigateToProject?: (projectId: string) => void;
  onNavigateToParent?: (parentId: string) => void;
}

export function ProjectGroup({
  project,
  tasks,
  actions,
  variant = "backlog",
  orphanSubtasks = [],
  rows,
  onToggleCollapsed,
  onRenameProject,
  onChangeProjectColor,
  onDeleteProject,
  onAddTaskToProject,
  onHeaderAddClick,
  onNavigateToProject,
  onNavigateToParent,
}: ProjectGroupProps) {
  const isBacklog = variant === "backlog";
  // Which column this particular rendered instance belongs to — the same
  // project can be on screen twice at once (its Backlog card and, whenever
  // it has qualifying tasks, its In Progress card), so every id this
  // component registers with dnd-kit must be scoped by this, exactly like
  // `TaskRow`'s `taskDragId` already is for task rows.
  const column: Column = isBacklog ? "backlog" : "in_progress";
  // Collapse state is per-column — this instance must read (and, via the
  // "+" reveal below, only ever expand) the bit that matches its own
  // column, never the other column's rendered instance of the same project.
  const isCollapsed = isBacklog ? project.collapsed : project.inProgressCollapsed;

  const { setNodeRef, isOver } = useDroppable({
    id: dropZoneId("project", column, project.id),
    data: { kind: "project", projectId: project.id, column },
  });

  // The header row itself is the sortable/drop entity for "project header ->
  // project header: reorder projects" (source) and, in the Backlog, also a
  // valid re-home drop target. Called unconditionally (rules of hooks), but
  // its ref/attributes/listeners are only ever wired into the DOM for
  // variant="backlog" below: In Progress's header is a plain, non-draggable
  // label, with no `projects.sort_order` write path. In Progress's header id
  // is still given a column-scoped, non-`project.id` value so it can never
  // collide with the same project's Backlog header registration when both
  // are mounted at once — reordering itself only ever reads
  // `data.projectId`, never this raw dnd-kit id, so the id's exact shape is
  // free to differ.
  const {
    attributes,
    listeners,
    setNodeRef: setHeaderRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: isBacklog ? project.id : `in_progress-header:${project.id}`,
    data: { kind: "project", projectId: project.id },
  });
  const headerStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // "+" reveals (expanding a collapsed project) and focuses the per-project
  // add-task input. Bumping `addFocusToken` remounts `AddTaskRow` with
  // `autoFocus` — the same key-remount-to-refocus pattern documented on
  // `AddTaskRow`'s `autoFocus` prop — which also handles the "reveal" case
  // for free: the row only exists in the DOM once `isCollapsed` flips to
  // false, so its very first mount already carries the fresh token.
  // Backlog-only: In Progress never shows this affordance, so `isCollapsed`
  // here always reads the Backlog bit (`project.collapsed`), never In
  // Progress's.
  const [addFocusToken, setAddFocusToken] = useState(0);

  function handleHeaderAddClick() {
    if (isCollapsed) onToggleCollapsed(project);
    setAddFocusToken((t) => t + 1);
    onHeaderAddClick?.();
  }

  // In Progress is an ephemeral filtered view — an empty group here is pure
  // noise. The Backlog never hides an empty project (a project is a
  // durable container there).
  if (!isBacklog && tasks.length === 0 && orphanSubtasks.length === 0) {
    return null;
  }

  const sortableIds = [
    ...tasks.flatMap((t) => [
      taskDragId(t, !isBacklog),
      ...t.subtasks.map((s) => taskDragId(s, !isBacklog)),
    ]),
    ...orphanSubtasks.map((s) => taskDragId(s, !isBacklog)),
  ];

  return (
    <div data-project-id={project.id} className="border-b border-border last:border-b-0">
      <div
        ref={isBacklog ? setHeaderRef : undefined}
        style={isBacklog ? headerStyle : undefined}
        {...(isBacklog ? attributes : {})}
        {...(isBacklog ? listeners : {})}
        className={cn(
          isBacklog && "cursor-grab touch-none active:cursor-grabbing",
          isBacklog && isDragging && "opacity-50",
        )}
      >
        <ProjectHeader
          project={project}
          variant={variant}
          draggable={isBacklog}
          onToggleCollapsed={() => onToggleCollapsed(project)}
          onRename={isBacklog ? (name) => onRenameProject?.(project.id, name) : undefined}
          onChangeColor={
            isBacklog ? (color) => onChangeProjectColor?.(project.id, color) : undefined
          }
          onDelete={isBacklog ? () => onDeleteProject?.(project.id) : undefined}
          onAddTask={isBacklog ? handleHeaderAddClick : undefined}
        />
      </div>

      {!isCollapsed && (
        <div
          ref={setNodeRef}
          className={cn(isOver && "bg-muted/60 ring-1 ring-inset ring-primary")}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {/* In Progress cards (`rows` present) render one row per entry —
             * a bare `TaskRow` for a `"task"` row, or a `ParentGroupHeader`
             * plus its indented children for a `"parentGroup"` row — see
             * `ProjectGroupProps.rows`'s doc comment. The Backlog (`rows`
             * undefined) keeps its original flat tasks-then-orphans
             * rendering below, byte-for-byte. */}
            {rows
              ? rows.map((row) =>
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
                    {tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        actions={actions}
                        inProgressColumn={!isBacklog}
                        onNavigateToProject={onNavigateToProject}
                        onNavigateToParent={onNavigateToParent}
                      />
                    ))}
                    {orphanSubtasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        actions={actions}
                        inProgressColumn={!isBacklog}
                        showTrail
                        hideProject
                        onNavigateToProject={onNavigateToProject}
                        onNavigateToParent={onNavigateToParent}
                      />
                    ))}
                  </>
                )}
          </SortableContext>
          {isBacklog && (
            <AddTaskRow
              key={addFocusToken}
              autoFocus={addFocusToken > 0}
              placeholder={`add to ${project.name}`}
              onSubmit={(title, images) =>
                images
                  ? onAddTaskToProject?.(project.id, title, images)
                  : onAddTaskToProject?.(project.id, title)
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

export default ProjectGroup;
