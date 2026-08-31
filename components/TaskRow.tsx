// A single task row: drag handle, checkbox (routed through
// useCompleteWithUndo, never completeTask directly), inline-editable title,
// tag chips, ProgressRing when it has subtasks, a "carried Nx" badge, a
// Today marker (whenever `task.inToday`), an AgeChip (muted "added N ago"
// context, hidden below `sm` if the row is tight), a DueChip, and
// always-visible inline icon actions (calendar, tags, add-subtask, "..."
// menu), plus its own subtasks rendered indented beneath it.
//
// The row is ALWAYS a normal, undimmed, fully-interactive row — there is no
// more "ghost" visual treatment. A task that qualifies for Today
// (`task.inToday`) is distinguished only by its Today marker, and it can
// render this same way in BOTH the Backlog and the Today column at once
// (see `taskDragId` below).
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

/**
 * A task that qualifies for Today (`task.inToday`) renders TWICE at once:
 * once as a normal row in its Backlog home (project or loose list), and
 * again as a normal row in the Today column's own project group — same
 * `task.id`, two live DOM instances, both fully interactive. dnd-kit
 * requires unique sortable/draggable ids within one `DndContext`, and the
 * context spans both columns (they share one drag surface), so the second
 * instance needs a distinct id or dnd-kit's internal registry collides.
 *
 * This is NOT a leftover of the deleted "ghost row" — ghosts dimmed a
 * duplicate rendering, and this id-prefixing trick predates that and
 * outlives it: the double-render it exists for is now MORE common than
 * before (every `inToday` task appears in both columns side by side, not
 * just carried-forward ones), not less. Do not remove the prefix when
 * cleaning up ghost code; that would silently break drag the moment both
 * columns render at once. `data.taskId` (not dnd-kit's own `id`) is what
 * the business logic (`lib/drag.ts`) actually reads — this is purely a
 * DOM/registry-uniqueness concern, invisible to the move math. Every
 * `SortableContext`'s `items` list must use this same function so dnd-kit's
 * internal id set matches what each row actually registers.
 */
export function taskDragId(task: TaskDto, inTodayColumn: boolean): string {
  return inTodayColumn ? `today:${task.id}` : task.id;
}

export interface TaskRowProps {
  task: TaskDto;
  actions: BoardActions;
  indent?: boolean;
  /** True when this particular row instance is rendered in the Today
   * column, as opposed to the Backlog column. Both columns can render the
   * SAME task at once (whenever `task.inToday`) — this flag exists solely
   * to give the two concurrent instances distinct dnd-kit ids (see
   * `taskDragId`); it selects no visual treatment of its own, since rows no
   * longer dim. */
  inTodayColumn?: boolean;
  /** Fired when the Today marker is clicked, to remove the task from
   * Today. The caller routes this to either `moveTask` (bucket === 'today')
   * or the `dismissFromToday` RPC (bucket === 'backlog', auto-included) —
   * TaskRow itself stays agnostic of which. */
  onRemoveFromToday?: (id: string) => void;
  /** Renders the muted trail line (`# Project > Parent`) as a second line.
   * `TrailLine` itself renders null with no context. */
  showTrail?: boolean;
  /** Forwarded to `TrailLine`: suppress its project segment because the
   * caller (a Today project group) already names the project via its own
   * header. */
  hideProject?: boolean;
  onNavigateToProject?: (projectId: string) => void;
  onNavigateToParent?: (parentId: string) => void;
}

export function TaskRow({
  task,
  actions,
  indent = false,
  inTodayColumn = false,
  onRemoveFromToday,
  showTrail = false,
  hideProject = false,
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
      id: taskDragId(task, inTodayColumn),
      data: { kind: "task", taskId: task.id, parentId: task.parentId, bucket: task.bucket },
    });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isOver = actions.overId === task.id;
  const isTopLevel = task.parentId === null;
  // Two distinct reasons a row can be in Today: manually scheduled, or
  // auto-included by being due today/overdue. Both are surfaced by the
  // same `inToday` bit, but the marker distinguishes them (design doc
  // decision 5 — "auto-inclusion is derived", so the two are worth telling
  // apart at a glance).
  const isManuallyScheduled = task.bucket === "today";

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
        className={cn(
          "flex min-h-8 items-center gap-2 px-2 py-1",
          indent && "pl-8",
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

        <Checkbox
          checked={false}
          onCheckedChange={() => actions.onToggleComplete(task)}
          aria-label={`Mark "${task.title}" done`}
        />

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

        {/* Marker and carried badge are no longer either/or — a row can
         * show both at once now that rows don't dim. Same reading-order
         * slot the carried badge always occupied. */}
        {task.inToday && (
          <button
            type="button"
            onClick={() => onRemoveFromToday?.(task.id)}
            aria-label={`Remove "${task.title}" from Today`}
            className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground hover:text-foreground focus-visible:text-foreground"
          >
            {/* Two sibling elements, one visible per breakpoint — never JS
             * measurement, matching the AgeChip/TagChips idiom this file
             * already relies on. Both are aria-hidden since the button's
             * own aria-label already carries the accessible name. */}
            <span aria-hidden="true" className="hidden sm:inline">
              {isManuallyScheduled ? "· today" : "⌁ today"}
            </span>
            <span aria-hidden="true" className="sm:hidden">
              {isManuallyScheduled ? "·" : "⌁"}
            </span>
          </button>
        )}

        {task.carriedCount > 0 && (
          <Badge variant="secondary" className="whitespace-nowrap text-[10px]">
            carried {task.carriedCount}×
          </Badge>
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
          hideProject={hideProject}
          onNavigateToProject={onNavigateToProject}
          onNavigateToParent={onNavigateToParent}
        />
      )}

      {/* Only ever reached in the Backlog tree (Today's project groups nest
       * their own inToday-filtered subtasks the same way — `lib/todayView`
       * already narrowed `task.subtasks` to inToday-only there, so this
       * loop renders correctly in both columns without knowing which one
       * it's in). */}
      {isTopLevel &&
        task.subtasks.map((sub) => (
          <TaskRow
            key={sub.id}
            task={sub}
            actions={actions}
            indent
            inTodayColumn={inTodayColumn}
            onRemoveFromToday={onRemoveFromToday}
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
