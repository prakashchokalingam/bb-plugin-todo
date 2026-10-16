// A single task row: drag handle, checkbox (routed through
// useCompleteWithUndo, never completeTask directly), inline-editable title,
// tag chips, ProgressRing when it has subtasks, a "carried Nd" badge, an
// AgeChip (muted "added N ago" context, hidden below `sm` if the row is
// tight), a DueChip, and always-visible inline icon actions (calendar, tags,
// add-subtask, "..." menu, ▶/◀ stage toggle), plus its own subtasks
// rendered indented beneath it.
//
// The row is ALWAYS a normal, undimmed, fully-interactive row — there is no
// more "ghost" visual treatment, and no more separate "In Progress marker"
// either: membership in In Progress (`task.stage === 'in_progress'`) is
// signalled purely by WHICH COLUMN a row renders in. A task that qualifies
// for In Progress (`task.inProgress`) renders this same way in BOTH the
// Backlog and the In Progress column at once (see `taskDragId` below).
//
// NO ArrowLeft/ArrowRight keyboard binding for the ▶/◀ stage toggle below,
// despite the feature request asking for one: dnd-kit's `KeyboardSensor`
// (wired at the page level in `TodoPage.tsx`) already owns the arrow-key
// vocabulary on this row's own drag-handle button — once a keyboard drag is
// picked up (Space/Enter on the handle), ArrowLeft/Right/Up/Down are its
// move gestures. Nothing else on the row is currently focusable as a
// "select this row" target (each icon button is its own independent tab
// stop), so binding the arrows to Start/Park would require inventing a new
// focusable row-level surface — a real change to the tab order untested
// here — and even then would sit on the exact same keys dnd-kit listens for
// on the adjacent handle. Skipped rather than risk that collision silently;
// mouse/touch (▶/◀ click) and screen readers (the buttons' own tab stop +
// `aria-label`) both already work.
import { useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TaskDto } from "@/contract";
import { cn } from "@/lib/utils";
import { hasLinks, isUrlOnly, normalizeTitle, singleLineLabel } from "@/lib/taskText";
import { GrowingTextarea } from "@/components/GrowingTextarea";
import { TaskText } from "@/components/TaskText";
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
import { ImageThumbs } from "@/components/ImageThumbs";
import { usePendingImages } from "@/hooks/usePendingImages";
import { errorText } from "@/lib/imageFiles";
import { TrailLine } from "@/components/TrailLine";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BoardActions } from "@/components/Section";

/**
 * A task that qualifies for In Progress (`task.inProgress`) renders TWICE at
 * once: once as a normal row in its Backlog home (project or loose list),
 * and again as a normal row in the In Progress column's own project group —
 * same `task.id`, two live DOM instances, both fully interactive. dnd-kit
 * requires unique sortable/draggable ids within one `DndContext`, and the
 * context spans both columns (they share one drag surface), so the second
 * instance needs a distinct id or dnd-kit's internal registry collides.
 *
 * This is NOT a leftover of the deleted "ghost row" — ghosts dimmed a
 * duplicate rendering, and this id-prefixing trick predates that and
 * outlives it: the double-render it exists for is now MORE common than
 * before (every `inProgress` task appears in both columns side by side, not
 * just carried-forward ones), not less. Do not remove the prefix when
 * cleaning up ghost code; that would silently break drag the moment both
 * columns render at once. `data.taskId` (not dnd-kit's own `id`) is what
 * the business logic (`lib/drag.ts`) actually reads — this is purely a
 * DOM/registry-uniqueness concern, invisible to the move math. Every
 * `SortableContext`'s `items` list must use this same function so dnd-kit's
 * internal id set matches what each row actually registers.
 */
export function taskDragId(task: TaskDto, inProgressColumn: boolean): string {
  return inProgressColumn ? `in_progress:${task.id}` : task.id;
}

export interface TaskRowProps {
  task: TaskDto;
  actions: BoardActions;
  indent?: boolean;
  /** True when this particular row instance is rendered in the In Progress
   * column, as opposed to the Backlog column. Both columns can render the
   * SAME task at once (whenever `task.inProgress`) — this flag exists
   * solely to give the two concurrent instances distinct dnd-kit ids (see
   * `taskDragId`); it selects no visual treatment of its own, since rows no
   * longer dim. */
  inProgressColumn?: boolean;
  /** Renders the muted trail line (`# Project > Parent`) as a second line.
   * `TrailLine` itself renders null with no context. */
  showTrail?: boolean;
  /** Forwarded to `TrailLine`: suppress its project segment because the
   * caller (an In Progress project group) already names the project via its
   * own header. */
  hideProject?: boolean;
  onNavigateToProject?: (projectId: string) => void;
  onNavigateToParent?: (parentId: string) => void;
}

export function TaskRow({
  task,
  actions,
  indent = false,
  inProgressColumn = false,
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
  // Image edits are staged here and sent with the text in ONE updateTask call
  // when the edit is saved; Escape throws them away.
  const [removedImageIds, setRemovedImageIds] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const keptImages = task.images.filter((img) => !removedImageIds.has(img.id));
  const pendingImages = usePendingImages(keptImages.length);
  const editorRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  const previewOpenRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: taskDragId(task, inProgressColumn),
      data: { kind: "task", taskId: task.id, parentId: task.parentId, stage: task.stage },
    });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isOver = actions.overId === task.id;
  const isTopLevel = task.parentId === null;

  // The edit session ends exactly once: Enter, Escape, or blur, whichever
  // comes first. Without the guard, Enter (save) followed by the blur that
  // the unmounting textarea can fire would rename twice, and Escape followed
  // by that blur would save the edit it just cancelled.
  const editDoneRef = useRef(true);

  // One-line name for aria-labels: a multiline title would otherwise put
  // newlines inside every label on the row.
  const label = singleLineLabel(task.title);
  const titleHasLinks = hasLinks(task.title);

  function startEdit() {
    setDraft(task.title);
    setRemovedImageIds(new Set());
    setSaveError(null);
    pendingImages.reset();
    editDoneRef.current = false;
    setEditing(true);
  }

  function endEdit() {
    editDoneRef.current = true;
    previewOpenRef.current = false;
    setEditing(false);
    setRemovedImageIds(new Set());
    setSaveError(null);
    pendingImages.reset();
  }

  async function commitEdit() {
    if (editDoneRef.current || savingRef.current) return;
    // An image is still being read. Stay open (its thumbnail is on the way):
    // Enter or blur again once it lands. This must come first, or the
    // text-only path below would close the editor and drop the image.
    if (pendingImages.reading > 0) return;

    const title = normalizeTitle(draft);
    const imagesChanged = pendingImages.images.length > 0 || removedImageIds.size > 0;

    if (!imagesChanged) {
      // Text-only edit: as before, close at once and let the board refetch.
      endEdit();
      if (title.length > 0 && title !== task.title) {
        actions.onRenameTask(task.id, title);
      }
      return;
    }

    // Text and image changes save together. The editor stays open, with the
    // draft intact, until the server accepts them.
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await actions.onUpdateTask(task.id, {
        ...(title.length > 0 && title !== task.title ? { title } : {}),
        ...(pendingImages.images.length > 0
          ? { addImages: pendingImages.images.map((i) => ({ data: i.data })) }
          : {}),
        ...(removedImageIds.size > 0 ? { removeImageIds: [...removedImageIds] } : {}),
      });
      if (mountedRef.current) endEdit();
    } catch (err) {
      if (mountedRef.current) {
        setSaveError(errorText(err, "Cannot save this task. Your text and images remain here."));
        editorRef.current?.querySelector("textarea")?.focus();
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  function cancelEdit() {
    if (editDoneRef.current || savingRef.current) return;
    endEdit();
    setDraft(task.title);
  }

  /** Focus moving between the textarea and its thumbnails is not a "leave". */
  function handleEditorBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (previewOpenRef.current) return;
    const next = e.relatedTarget as Node | null;
    if (next && editorRef.current?.contains(next)) return;
    void commitEdit();
  }

  const thumbItems = (editingNow: boolean) => [
    ...keptImages.map((img) => ({
      key: img.id,
      src: img.url,
      onRemove: editingNow && !saving ? () => setRemovedImageIds((prev) => new Set(prev).add(img.id)) : undefined,
    })),
    ...(editingNow
      ? pendingImages.images.map((img) => ({
          key: img.key,
          src: img.src,
          onRemove: saving ? undefined : () => pendingImages.remove(img.key),
        }))
      : []),
  ];

  const editButtonClass =
    "inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <div>
      <div
        ref={setNodeRef}
        style={style}
        data-task-id={task.id}
        className={cn(
          // `items-start`: the handle, checkbox, chips, and actions line up
          // with the FIRST line of a multiline title (20px line height).
          "flex min-h-8 items-start gap-2 px-2 py-1",
          indent && "pl-8",
          isDragging && "opacity-50",
          isOver && "bg-muted/60 ring-1 ring-inset ring-primary",
        )}
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder "${label}"`}
          className="mt-[3px] shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <Icon name="DragDropVertical" className="size-3.5" aria-hidden="true" />
        </button>

        <Checkbox
          className="mt-0.5"
          checked={false}
          onCheckedChange={() => actions.onToggleComplete(task)}
          aria-label={`Mark "${label}" done`}
        />

        {editing ? (
          <div ref={editorRef} onBlur={handleEditorBlur} className="flex min-w-0 flex-1 flex-col gap-1" aria-busy={saving}>
            <GrowingTextarea
              autoFocus
              value={draft}
              onValueChange={setDraft}
              onSubmit={() => void commitEdit()}
              onCancel={cancelEdit}
              onPaste={saving ? undefined : pendingImages.onPaste}
              readOnly={saving}
              aria-label="Task title"
            />
            <ImageThumbs
              label={singleLineLabel(draft) || label}
              reading={pendingImages.reading}
              items={thumbItems(true)}
              onPreviewChange={(open) => {
                previewOpenRef.current = open;
              }}
              className={saving ? "opacity-60" : undefined}
            />
            {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
            {(saveError ?? pendingImages.error) && (
              <p role="alert" className="text-xs text-destructive">
                {saveError ?? pendingImages.error}
              </p>
            )}
          </div>
        ) : titleHasLinks ? (
          // A link inside a <button> would nest interactive elements, so a
          // title with links gets a plain block instead: clicking its text
          // (not a link) edits, a link click only opens the link, and a
          // separate button gives keyboard users the edit action. For a
          // URL-only title there is no text to click, so that button stays
          // visible; otherwise it appears on hover or focus.
          <div className="group/title flex min-w-0 flex-1 items-start gap-1">
            <div
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest("a")) startEdit();
              }}
              className="min-w-0 flex-1 cursor-text text-left text-sm leading-5"
            >
              <TaskText title={task.title} onOpenUrl={actions.onOpenUrl} />
            </div>
            <button
              type="button"
              onClick={startEdit}
              aria-label={`Edit "${label}"`}
              className={cn(
                editButtonClass,
                "mt-px",
                !isUrlOnly(task.title) &&
                  "opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100",
              )}
            >
              <Icon name="Edit" className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={startEdit}
            className="min-w-0 flex-1 whitespace-pre-wrap text-left text-sm leading-5 [overflow-wrap:anywhere]"
          >
            {task.title}
          </button>
        )}

        <div className="flex h-5 shrink-0 items-center gap-2">
          <TagChips tags={task.tags} />

          {task.subtaskCounts.total > 0 && (
            <ProgressRing done={task.subtaskCounts.done} total={task.subtaskCounts.total} />
          )}

        {/* The old "· in progress" / "⌁ due today" marker is gone: with
         * "Today" deleted, In Progress membership is solely
         * `task.stage === 'in_progress'`, so which column a row renders in
         * already says everything the marker used to say. The ▶/◀ stage
         * toggle below (`actions.onParkTask`) is the one way to leave In
         * Progress now. The carried badge is the only thing left in this
         * slot. */}
        {task.carriedDays >= 1 && (
          <Badge variant="secondary" className="whitespace-nowrap text-[10px]">
            carried {task.carriedDays}d
          </Badge>
        )}

        <AgeChip
          createdAt={task.createdAt}
          now={actions.now}
          className="hidden sm:inline-flex"
        />

          <DueChip dueAt={task.dueAt} hasDueTime={task.hasDueTime} now={actions.now} />
        </div>

        <div className="-mt-0.5 flex shrink-0 items-center gap-0.5">
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
                aria-label={`Set due date for "${label}"`}
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
                aria-label={`Edit tags for "${label}"`}
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
              aria-label={`Add a subtask to "${label}"`}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:text-foreground"
            >
              <Icon name="Plus" className="size-4" aria-hidden="true" />
            </button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`More actions for "${label}"`}
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

          {/* One-click stage toggle: ▶ Start on a Backlog-column row flips
           * this task straight to `in_progress`; ◀ Park on an In
           * Progress-column row flips it back to `pending`. Gated purely on
           * `inProgressColumn` — which column THIS rendered instance is
           * in — never on `task.inProgress`/`task.stage`, so it shows up
           * consistently in both of a dual-rendered row's instances rather
           * than trying to guess "what state is this task really in".
           *
           * ALWAYS visible (not hover-revealed): this is now the primary way
           * to move work between the two blocks, so it can't be
           * discoverable-only-on-hover. Kept visually quiet — same muted
           * `text-muted-foreground` treatment as the ▦ calendar/⬮ tag icons
           * beside it, gaining emphasis only on hover/focus — so it reads as
           * one of this row's ordinary icon actions rather than shouting.
           * `aria-label` (+ the `Tooltip`) carries the accessible name since
           * the glyph alone (▶/◀) isn't one. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() =>
                  inProgressColumn ? actions.onParkTask(task.id) : actions.onStartTask(task.id)
                }
                aria-label={inProgressColumn ? "Move to Backlog" : "Move to In Progress"}
                title={inProgressColumn ? "Move to Backlog" : "Move to In Progress"}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:text-foreground"
              >
                <Icon
                  name={inProgressColumn ? "ChevronLeft" : "ChevronRight"}
                  className="size-4"
                  aria-hidden="true"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {inProgressColumn ? "Move to Backlog" : "Move to In Progress"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {!editing && task.images.length > 0 && (
        <ImageThumbs
          label={label}
          items={thumbItems(false)}
          className={cn("pb-1 pr-2", indent ? "pl-[5rem]" : "pl-[3.5rem]")}
        />
      )}

      {showTrail && (
        <TrailLine
          trail={task.trail ?? null}
          hideProject={hideProject}
          onNavigateToProject={onNavigateToProject}
          onNavigateToParent={onNavigateToParent}
        />
      )}

      {/* Only ever reached in the Backlog tree (In Progress's project groups
       * nest their own inProgress-filtered subtasks the same way —
       * `lib/inProgressView` already narrowed `task.subtasks` to
       * inProgress-only there, so this loop renders correctly in both
       * columns without knowing which one it's in). */}
      {isTopLevel &&
        task.subtasks.map((sub) => (
          <TaskRow
            key={sub.id}
            task={sub}
            actions={actions}
            indent
            inProgressColumn={inProgressColumn}
            onNavigateToProject={onNavigateToProject}
            onNavigateToParent={onNavigateToParent}
          />
        ))}

      {addingSubtask && (
        <div className="pl-8">
          <AddTaskRow
            placeholder="add subtask"
            onSubmit={(title, images) => {
              const input = { stage: task.stage, parentId: task.id, title };
              if (!images) {
                actions.onCreateTask(input);
                setAddingSubtask(false);
                return;
              }
              // With images, stay open until the server accepts them.
              return Promise.resolve(actions.onCreateTask({ ...input, images })).then(() =>
                setAddingSubtask(false),
              );
            }}
          />
        </div>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{label}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {task.subtaskCounts.total > 0
                ? "This also deletes its subtasks. This cannot be undone."
                : "This cannot be undone."}
              {task.images.length > 0 ? " Its images are deleted too." : ""}
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
