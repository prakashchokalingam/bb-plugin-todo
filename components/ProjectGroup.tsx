// A project's card.
//
// variant="backlog" (default): today's existing behaviour, entirely
// unchanged — ProjectHeader + a droppable body (append-to-project / re-home
// drop target) + a per-project AddTaskRow. Collapsed renders the header
// alone; an empty expanded project renders the header plus its add-row
// only (a project is a durable container — an empty one just reads as a
// plan not yet written).
//
// variant="today": the header is a plain, non-draggable group label (no
// project reordering from Today — see ProjectHeader). No per-project
// add-row (scheduling/filing is a Backlog-only operation). Renders nothing
// at all when it has no qualifying tasks AND no orphan subtasks — Today is
// an ephemeral filtered view, so an empty box there is pure noise, unlike
// the Backlog's durable-container case above. `orphanSubtasks` (inToday
// subtasks whose parent isn't inToday, from `lib/todayView`) render as
// standalone rows with their trail shown, after the nested ones.
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
import { ProjectHeader } from "@/components/ProjectHeader";
import { TaskRow, taskDragId } from "@/components/TaskRow";
import { AddTaskRow } from "@/components/AddTaskRow";
import type { BoardActions } from "@/components/Section";

export interface ProjectGroupProps {
  project: ProjectDto;
  /** Top-level tasks filed to this project. In the Backlog, this is
   * unconditionally every open top-level task filed here (the Backlog is
   * comprehensive). In Today, this is `TodayProjectGroup.tasks` from
   * `lib/todayView` — top-level rows that are themselves `inToday`, with
   * `subtasks` already narrowed to inToday-only. */
  tasks: TaskDto[];
  actions: BoardActions;
  variant?: "backlog" | "today";
  /** Today-only: `inToday` subtasks whose parent does NOT qualify, from
   * `TodayProjectGroup.orphanSubtasks`. Rendered standalone, with a trail,
   * after the nested tasks above. */
  orphanSubtasks?: TaskDto[];
  onToggleCollapsed: (project: ProjectDto) => void;
  /** Backlog-only. */
  onRenameProject?: (id: string, name: string) => void;
  onChangeProjectColor?: (id: string, color: TagColor) => void;
  onDeleteProject?: (id: string) => void;
  onAddTaskToProject?: (projectId: string, title: string) => void;
  /** Forwarded from the header's "+" affordance. Focusing/revealing the
   * add-row input is Phase 6's job; this component stays dumb. */
  onHeaderAddClick?: () => void;
  /** Fired when a row's Today marker is clicked, to remove it from Today. */
  onRemoveFromToday?: (id: string) => void;
  onNavigateToProject?: (projectId: string) => void;
  onNavigateToParent?: (parentId: string) => void;
}

export function ProjectGroup({
  project,
  tasks,
  actions,
  variant = "backlog",
  orphanSubtasks = [],
  onToggleCollapsed,
  onRenameProject,
  onChangeProjectColor,
  onDeleteProject,
  onAddTaskToProject,
  onHeaderAddClick,
  onRemoveFromToday,
  onNavigateToProject,
  onNavigateToParent,
}: ProjectGroupProps) {
  const isBacklog = variant === "backlog";

  const { setNodeRef, isOver } = useDroppable({
    id: `project-${project.id}`,
    data: { kind: "project", projectId: project.id },
  });

  // The header row itself is the sortable/drop entity for BOTH "project
  // header -> project header: reorder projects" (source) and "task ->
  // project header: re-home" (target, via `over.data.current.kind ===
  // "project"`) — the same id serves both roles. Called unconditionally
  // (rules of hooks), but its ref/attributes/listeners are only ever wired
  // into the DOM for variant="backlog" below: Today's header is a plain,
  // non-draggable label, with no `projects.sort_order` write path.
  const {
    attributes,
    listeners,
    setNodeRef: setHeaderRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id, data: { kind: "project", projectId: project.id } });
  const headerStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // "+" reveals (expanding a collapsed project) and focuses the per-project
  // add-task input. Bumping `addFocusToken` remounts `AddTaskRow` with
  // `autoFocus` — the same key-remount-to-refocus pattern documented on
  // `AddTaskRow`'s `autoFocus` prop — which also handles the "reveal" case
  // for free: the row only exists in the DOM once `project.collapsed` flips
  // to false, so its very first mount already carries the fresh token.
  // Backlog-only: Today never shows this affordance.
  const [addFocusToken, setAddFocusToken] = useState(0);

  function handleHeaderAddClick() {
    if (project.collapsed) onToggleCollapsed(project);
    setAddFocusToken((t) => t + 1);
    onHeaderAddClick?.();
  }

  // Today is an ephemeral filtered view — an empty group here is pure
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

      {!project.collapsed && (
        <div
          ref={setNodeRef}
          className={cn(isOver && "bg-muted/60 ring-1 ring-inset ring-primary")}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                actions={actions}
                inTodayColumn={!isBacklog}
                onRemoveFromToday={onRemoveFromToday}
                onNavigateToProject={onNavigateToProject}
                onNavigateToParent={onNavigateToParent}
              />
            ))}
            {orphanSubtasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                actions={actions}
                inTodayColumn={!isBacklog}
                showTrail
                hideProject
                onRemoveFromToday={onRemoveFromToday}
                onNavigateToProject={onNavigateToProject}
                onNavigateToParent={onNavigateToParent}
              />
            ))}
          </SortableContext>
          {isBacklog && (
            <AddTaskRow
              key={addFocusToken}
              autoFocus={addFocusToken > 0}
              placeholder={`add to ${project.name}`}
              onSubmit={(title) => onAddTaskToProject?.(project.id, title)}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default ProjectGroup;
