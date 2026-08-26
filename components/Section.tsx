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
import type { TagColor, TagDto, TaskDto } from "@/contract";
import { cn } from "@/lib/utils";
import { ProgressRing } from "@/components/ProgressRing";
import { TaskRow } from "@/components/TaskRow";
import { AddTaskRow } from "@/components/AddTaskRow";

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
  tasks: TaskDto[];
  actions: BoardActions;
  addPlaceholder: string;
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
}: SectionProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `section-${bucket}`,
    data: { kind: "section", bucket },
  });

  const sortableIds = tasks.flatMap((t) => [t.id, ...t.subtasks.map((s) => s.id)]);

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
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {tasks.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">Nothing here yet.</div>
          )}
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} actions={actions} />
          ))}
        </SortableContext>
        <AddTaskRow
          placeholder={addPlaceholder}
          onSubmit={(title) => actions.onCreateTask({ bucket, parentId: null, title })}
        />
      </div>
    </section>
  );
}

export default Section;
