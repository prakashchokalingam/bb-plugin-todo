// A project's card in the Backlog: ProjectHeader + a droppable body +
// a per-project AddTaskRow. The body is registered as a drop target the
// same way Section.tsx registers a bucket's body — "append to this
// project, top-level" moves and empty-project drops land here. Collapsed
// renders the header alone; an empty (expanded) project renders the header
// plus its add-row, no placeholder text.
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
  /** Top-level tasks filed to this project — both plain Backlog rows and
   * today-flagged ghosts (the backlog query returns both, per the design). */
  tasks: TaskDto[];
  actions: BoardActions;
  onToggleCollapsed: (project: ProjectDto) => void;
  onRenameProject: (id: string, name: string) => void;
  onChangeProjectColor: (id: string, color: TagColor) => void;
  onDeleteProject: (id: string) => void;
  onAddTaskToProject: (projectId: string, title: string) => void;
  /** Forwarded from the header's "+" affordance. Focusing/revealing the
   * add-row input is Phase 6's job; this component stays dumb. */
  onHeaderAddClick?: () => void;
  onUnscheduleTask?: (id: string) => void;
  onNavigateToProject?: (projectId: string) => void;
  onNavigateToParent?: (parentId: string) => void;
}

export function ProjectGroup({
  project,
  tasks,
  actions,
  onToggleCollapsed,
  onRenameProject,
  onChangeProjectColor,
  onDeleteProject,
  onAddTaskToProject,
  onHeaderAddClick,
  onUnscheduleTask,
  onNavigateToProject,
  onNavigateToParent,
}: ProjectGroupProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `project-${project.id}`,
    data: { kind: "project", projectId: project.id },
  });

  // The header row itself is the sortable/drop entity for BOTH "project
  // header -> project header: reorder projects" (source) and "task ->
  // project header: re-home" (target, via `over.data.current.kind ===
  // "project"`) — the same id serves both roles, mirroring how a Today row
  // dropped directly on a different project's header re-homes it (design
  // doc's drag matrix).
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
  const [addFocusToken, setAddFocusToken] = useState(0);

  function handleHeaderAddClick() {
    if (project.collapsed) onToggleCollapsed(project);
    setAddFocusToken((t) => t + 1);
    onHeaderAddClick?.();
  }

  // Every top-level task in a project's home view ghosts independently
  // (see `taskDragId`'s doc comment) whenever it's flagged into Today; so
  // does each of its own real subtasks (never both — Today rows never
  // carry `.subtasks`, deviation #1).
  const sortableIds = tasks.flatMap((t) => [
    taskDragId(t, t.bucket === "today"),
    ...t.subtasks.map((s) => taskDragId(s, s.bucket === "today")),
  ]);

  return (
    <div data-project-id={project.id} className="border-b border-border last:border-b-0">
      <div
        ref={setHeaderRef}
        style={headerStyle}
        {...attributes}
        {...listeners}
        className={cn("cursor-grab touch-none active:cursor-grabbing", isDragging && "opacity-50")}
      >
        <ProjectHeader
          project={project}
          onToggleCollapsed={() => onToggleCollapsed(project)}
          onRename={(name) => onRenameProject(project.id, name)}
          onChangeColor={(color) => onChangeProjectColor(project.id, color)}
          onDelete={() => onDeleteProject(project.id)}
          onAddTask={handleHeaderAddClick}
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
                ghost={task.bucket === "today"}
                onUnschedule={onUnscheduleTask}
                onNavigateToProject={onNavigateToProject}
                onNavigateToParent={onNavigateToParent}
              />
            ))}
          </SortableContext>
          <AddTaskRow
            key={addFocusToken}
            autoFocus={addFocusToken > 0}
            placeholder={`add to ${project.name}`}
            onSubmit={(title) => onAddTaskToProject(project.id, title)}
          />
        </div>
      )}
    </div>
  );
}

export default ProjectGroup;
