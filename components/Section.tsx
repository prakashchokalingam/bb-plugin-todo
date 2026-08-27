// A Backlog/Today section: header (label, optional count, ProgressRing) +
// droppable body + AddTaskRow. Both sections share one DndContext (owned by
// TodoPage); this component only registers the section body as a drop
// target for "append to this bucket, top-level" moves and empty-section
// drops.
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { ProjectDto, TagColor, TagDto, TaskDto } from "@/contract";
import { cn } from "@/lib/utils";
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

export interface SectionProps {
  bucket: "backlog" | "today";
  heading: string;
  /** Shown as "· N" next to the heading; omitted (e.g. for Today) when undefined. */
  count?: number;
  ringValue: number;
  ringTotal: number;
  ringTone: "primary" | "destructive";
  ringLabel: string;
  /** Backlog: LOOSE top-level tasks (project_id = null), rendered below every
   * project — both plain rows and today-flagged ghosts. Today: the full
   * flat schedule. */
  tasks: TaskDto[];
  actions: BoardActions;
  addPlaceholder: string;

  // --- Backlog-only (projects) --------------------------------------------
  /** Every project in the active list, in sortOrder — omitted for Today. */
  projects?: ProjectDto[];
  /** Top-level tasks (+ ghosts) filed to a given project id. */
  projectTasks?: (projectId: string) => TaskDto[];
  onToggleProjectCollapsed?: (project: ProjectDto) => void;
  onRenameProject?: (id: string, name: string) => void;
  onChangeProjectColor?: (id: string, color: TagColor) => void;
  onDeleteProject?: (id: string) => void;
  onAddTaskToProject?: (projectId: string, title: string) => void;
  onHeaderAddClick?: (projectId: string) => void;
  /** `#Name` typed into the add-row creates a project inline instead of a task. */
  onCreateProject?: (name: string) => void;

  // --- Shared with ghost/Today rows ---------------------------------------
  /** Clicking a ghost's ". today" marker unschedules it. */
  onUnscheduleTask?: (id: string) => void;
  /** Clicking a trail segment scrolls the Backlog to the source row and flashes it. */
  onNavigateToProject?: (projectId: string) => void;
  onNavigateToParent?: (parentId: string) => void;

  // --- Today-only ----------------------------------------------------------
  /** Renders each row's muted `# Project > Parent` second line. */
  showTrail?: boolean;
}

export function Section({
  bucket,
  heading,
  count,
  ringValue,
  ringTotal,
  ringTone,
  ringLabel,
  tasks,
  actions,
  addPlaceholder,
  projects,
  projectTasks,
  onToggleProjectCollapsed,
  onRenameProject,
  onChangeProjectColor,
  onDeleteProject,
  onAddTaskToProject,
  onHeaderAddClick,
  onCreateProject,
  onUnscheduleTask,
  onNavigateToProject,
  onNavigateToParent,
  showTrail = false,
}: SectionProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `section-${bucket}`,
    data: { kind: "section", bucket },
  });

  const projectIds = projects?.map((p) => p.id) ?? [];
  // A loose top-level task ghosts (see `taskDragId`'s doc comment) exactly
  // like a project's top-level task does; its own real subtasks (never
  // present on a Today row — deviation #1) ghost independently of it.
  const looseSortableIds = tasks.flatMap((t) => {
    const topGhost = bucket === "backlog" && t.bucket === "today";
    return [
      taskDragId(t, topGhost),
      ...t.subtasks.map((s) => taskDragId(s, bucket === "backlog" && s.bucket === "today")),
    ];
  });
  const empty = tasks.length === 0 && projectIds.length === 0;

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
    actions.onCreateTask({ bucket, parentId: null, title });
  }

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 px-1 text-xs">
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
        {projects && projects.length > 0 && (
          <SortableContext items={projectIds} strategy={verticalListSortingStrategy}>
            {projects.map((project) => (
              <ProjectGroup
                key={project.id}
                project={project}
                tasks={projectTasks?.(project.id) ?? []}
                actions={actions}
                onToggleCollapsed={(p) => onToggleProjectCollapsed?.(p)}
                onRenameProject={(id, name) => onRenameProject?.(id, name)}
                onChangeProjectColor={(id, color) => onChangeProjectColor?.(id, color)}
                onDeleteProject={(id) => onDeleteProject?.(id)}
                onAddTaskToProject={(projectId, title) => onAddTaskToProject?.(projectId, title)}
                onHeaderAddClick={() => onHeaderAddClick?.(project.id)}
                onUnscheduleTask={onUnscheduleTask}
                onNavigateToProject={onNavigateToProject}
                onNavigateToParent={onNavigateToParent}
              />
            ))}
          </SortableContext>
        )}

        <SortableContext items={looseSortableIds} strategy={verticalListSortingStrategy}>
          {empty && (
            <div className="px-2 py-3 text-xs text-muted-foreground">Nothing here yet.</div>
          )}
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              actions={actions}
              ghost={bucket === "backlog" && task.bucket === "today"}
              onUnschedule={onUnscheduleTask}
              showTrail={showTrail}
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
