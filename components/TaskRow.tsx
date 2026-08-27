// A single task row: drag handle, checkbox (routed through
// useCompleteWithUndo, never completeTask directly), inline-editable title,
// tag chips, ProgressRing when it has subtasks, a "carried Nx" badge, an
// AgeChip (muted "added N ago" context, hidden below `sm` if the row is
// tight), a DueChip, and always-visible inline icon actions (calendar, tags,
// add-subtask, "..." menu), plus its own subtasks rendered indented beneath
// it.
import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TaskDto } from "@/contract";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AgeChip } from "@/components/AgeChip";
import { DueChip } from "@/components/DueChip";
import { ProgressRing } from "@/components/ProgressRing";
import { DueDatePicker } from "@/components/DueDatePicker";
import { TagChips } from "@/components/TagChips";
import { TagPicker } from "@/components/TagPicker";
import { AddTaskRow } from "@/components/AddTaskRow";
import { TrailLine } from "@/components/TrailLine";
import type { BoardActions } from "@/components/Section";

/** A ghost stays visible ~compact once it has been carried this many times,
 * per the design's "carried >= 3" ghost marker rule. */
const GHOST_CARRY_THRESHOLD = 3;

/**
 * A ghost's task id is deliberately identical to its scheduled Today
 * counterpart's — same row, two homes (design doc's "Today stops being a
 * place and becomes a flag"). That means the SAME `TaskDto.id` can be on
 * screen twice at once (the ghost in its project/Backlog, the flat entry in
 * Today), which would collide as a dnd-kit sortable/draggable id — dnd-kit
 * requires unique ids per `DndContext`. Ghost rows therefore drag under a
 * prefixed id instead of the bare task id; `data.taskId` (not dnd-kit's own
 * `id`) is what the business logic (`lib/drag.ts`) actually reads, so this
 * is purely a DOM/registry-uniqueness concern, invisible to the move math.
 * Every `SortableContext`'s `items` list must use this same function so
 * dnd-kit's internal id set matches what each row actually registers.
 */
export function taskDragId(task: TaskDto, ghost: boolean): string {
  return ghost ? `ghost:${task.id}` : task.id;
}

export interface TaskRowProps {
  task: TaskDto;
  actions: BoardActions;
  indent?: boolean;
  /** True when this row is a ghost: the task is scheduled (`bucket ===
   * 'today'`) but rendered here inside its project body. Dims the row,
   * swaps the checkbox for a ghost glyph, and shows a ". today" marker
   * (plus the carry count once `carriedCount >= 3`). */
  ghost?: boolean;
  /** Fired when the ghost's ". today" marker is clicked, to unschedule it. */
  onUnschedule?: (id: string) => void;
  /** Renders the muted trail line (`# Project > Parent`) as a second line,
   * for Today rows. `TrailLine` itself renders null with no context. */
  showTrail?: boolean;
  onNavigateToProject?: (projectId: string) => void;
  onNavigateToParent?: (parentId: string) => void;
}

export function TaskRow({
  task,
  actions,
  indent = false,
  ghost = false,
  onUnschedule,
  showTrail = false,
  onNavigateToProject,
  onNavigateToParent,
}: TaskRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [dueOpen, setDueOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: taskDragId(task, ghost),
      data: { kind: "task", taskId: task.id, parentId: task.parentId, bucket: task.bucket },
    });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isOver = actions.overId === task.id;
  const isTopLevel = task.parentId === null;

  function startEdit() {
    setDraft(task.title);
    setEditing(true);
  }

  function commitEdit() {
    const title = draft.trim();
    setEditing(false);
    if (title.length > 0 && title !== task.title) {
      actions.onRenameTask(task.id, title);
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
      setDraft(task.title);
    }
  }

  return (
    <div>
      <div
        ref={setNodeRef}
        style={style}
        data-task-id={task.id}
        data-ghost={ghost || undefined}
        className={cn(
          "flex min-h-8 items-center gap-2 px-2 py-1",
          indent && "pl-8",
          ghost && "opacity-60",
          isDragging && "opacity-50",
          isOver && "bg-muted/60 ring-1 ring-inset ring-primary",
        )}
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder "${task.title}"`}
          className="shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <Icon name="DragDropVertical" className="size-3.5" aria-hidden="true" />
        </button>

        {ghost ? (
          <span
            aria-hidden="true"
            className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
          >
            <Icon name="CircleDashed" className="size-3.5" aria-hidden="true" />
          </span>
        ) : (
          <Checkbox
            checked={false}
            onCheckedChange={() => actions.onToggleComplete(task)}
            aria-label={`Mark "${task.title}" done`}
          />
        )}

        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleTitleKeyDown}
            onBlur={commitEdit}
            aria-label="Task title"
            className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={startEdit}
            className="min-w-0 flex-1 truncate text-left text-sm"
          >
            {task.title}
          </button>
        )}

        <TagChips tags={task.tags} />

        {task.subtaskCounts.total > 0 && (
          <ProgressRing done={task.subtaskCounts.done} total={task.subtaskCounts.total} />
        )}

        {ghost ? (
          <button
            type="button"
            onClick={() => onUnschedule?.(task.id)}
            aria-label={`Unschedule "${task.title}"`}
            className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground hover:text-foreground focus-visible:text-foreground"
          >
            · today
            {task.carriedCount >= GHOST_CARRY_THRESHOLD ? ` ~${task.carriedCount}` : ""}
          </button>
        ) : (
          task.carriedCount > 0 && (
            <Badge variant="secondary" className="whitespace-nowrap text-[10px]">
              carried {task.carriedCount}×
            </Badge>
          )
        )}

        <AgeChip
          createdAt={task.createdAt}
          now={actions.now}
          className="hidden sm:inline-flex"
        />

        <DueChip dueAt={task.dueAt} hasDueTime={task.hasDueTime} now={actions.now} />

        <div className="flex shrink-0 items-center gap-0.5">
          <DueDatePicker
            open={dueOpen}
            onOpenChange={setDueOpen}
            dueAt={task.dueAt}
            hasDueTime={task.hasDueTime}
            onChange={(dueAt, hasDueTime) => actions.onSetDue(task.id, dueAt, hasDueTime)}
            anchor={
              <button
                type="button"
                onClick={() => setDueOpen(true)}
                aria-label={`Set due date for "${task.title}"`}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:text-foreground"
              >
                <Icon name="Calendar" className="size-4" aria-hidden="true" />
              </button>
            }
          />

          <TagPicker
            open={tagsOpen}
            onOpenChange={setTagsOpen}
            task={task}
            tags={actions.tagCatalog}
            onSetTaskTags={actions.onSetTaskTags}
            onCreateTag={actions.onCreateTag}
            anchor={
              <button
                type="button"
                onClick={() => setTagsOpen(true)}
                aria-label={`Edit tags for "${task.title}"`}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:text-foreground"
              >
                <Icon name="Tag" className="size-4" aria-hidden="true" />
              </button>
            }
          />

          {isTopLevel && (
            <button
              type="button"
              onClick={() => setAddingSubtask(true)}
              aria-label={`Add a subtask to "${task.title}"`}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:text-foreground"
            >
              <Icon name="Plus" className="size-4" aria-hidden="true" />
            </button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`More actions for "${task.title}"`}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:text-foreground"
              >
                <Icon name="MoreHorizontal" className="size-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
              >
                <Icon name="Trash2" className="size-3.5" aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {showTrail && (
        <TrailLine
          trail={task.trail ?? null}
          onNavigateToProject={onNavigateToProject}
          onNavigateToParent={onNavigateToParent}
        />
      )}

      {/* Only ever reached in the Backlog: Today rows are genuinely flat
       * (deviation #1, design doc) — `task.subtasks` is always `[]` there.
       * A subtask independently scheduled into Today (its parent stays
       * put, per invariant 4) renders here as a ghost, exactly like a
       * scheduled top-level task ghosts inside its ProjectGroup — see the
       * design mockup's `-> (.) Get legal sign-off  . today` row. */}
      {isTopLevel &&
        task.subtasks.map((sub) => (
          <TaskRow
            key={sub.id}
            task={sub}
            actions={actions}
            indent
            ghost={sub.bucket === "today"}
            onUnschedule={onUnschedule}
            onNavigateToProject={onNavigateToProject}
            onNavigateToParent={onNavigateToParent}
          />
        ))}

      {addingSubtask && (
        <div className="pl-8">
          <AddTaskRow
            placeholder="add subtask"
            onSubmit={(title) => {
              actions.onCreateTask({ bucket: task.bucket, parentId: task.id, title });
              setAddingSubtask(false);
            }}
          />
        </div>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{task.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {task.subtaskCounts.total > 0
                ? "This also deletes its subtasks. This cannot be undone."
                : "This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                actions.onDeleteTask(task.id);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default TaskRow;
