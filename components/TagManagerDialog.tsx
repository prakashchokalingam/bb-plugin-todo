// The "Manage tags" surface (design spec §4.4): rename, recolor, delete, and
// reorder the global tag catalog. Rendered through the existing responsive
// `Dialog`/`DialogContent` (centred on desktop, a bottom drawer on compact —
// exactly like `ArchivePanel`), never a hand-rolled overlay.
//
// This dialog owns its OWN `DndContext`, deliberately separate from
// `TodoPage`'s board-level one: the dialog's rows render through a portal, so
// sharing sensors with the board's drag context would have the two contexts
// fighting over the same pointer/keyboard events.
import { useEffect, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { TAG_COLORS, type TagColor, type TagDto, type rpcContract } from "@/contract";
import { cn } from "@/lib/utils";
import { TAG_DOT_CLASS } from "@/lib/tag-colors";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ColorSwatchPicker } from "@/components/ColorSwatchPicker";
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

export interface TagManagerDialogProps {
  /** The global tag catalog, ordered by `sortOrder` (`getBoard`'s `tags`). */
  tags: TagDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after any mutation lands, so the caller can refetch the board. */
  onChanged: () => void;
}

function taskCountLabel(n: number): string {
  return `${n} ${n === 1 ? "task" : "tasks"}`;
}

/** The first of "New tag", "New tag 2", "New tag 3", … not already present
 * in `existing` (case-insensitively — tag names are unique case-insensitive,
 * spec §1.3), so clicking `+ New tag` repeatedly before renaming never
 * collides on the uniqueness constraint. */
function nextDefaultTagName(existing: TagDto[]): string {
  const taken = new Set(existing.map((t) => t.name.toLowerCase()));
  if (!taken.has("new tag")) return "New tag";
  let n = 2;
  while (taken.has(`new tag ${n}`)) n += 1;
  return `New tag ${n}`;
}

interface RowProps {
  tag: TagDto;
  renaming: boolean;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onColorChange: (color: TagColor) => void;
  onDelete: () => void;
}

function TagManagerRow({
  tag,
  renaming,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onColorChange,
  onDelete,
}: RowProps) {
  const [draft, setDraft] = useState(tag.name);
  const [colorOpen, setColorOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tag.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  useEffect(() => {
    if (renaming) setDraft(tag.name);
  }, [renaming, tag.name]);

  function commit() {
    const name = draft.trim();
    if (name.length > 0 && name !== tag.name) {
      onCommitRename(name);
    } else {
      onCancelRename();
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex min-h-9 items-center gap-2 rounded-md px-1 py-1",
        isDragging && "opacity-50",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder tag "${tag.name}"`}
        className="shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <Icon name="DragDropVertical" className="size-3.5" aria-hidden="true" />
      </button>

      <Popover open={colorOpen} onOpenChange={setColorOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Change color for tag "${tag.name}"`}
            className="flex shrink-0 items-center gap-0.5"
          >
            <span
              aria-hidden="true"
              className={cn("size-3 rounded-full", TAG_DOT_CLASS[tag.color])}
            />
            <Icon name="ChevronDown" className="size-3 text-muted-foreground" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56" align="start">
          <ColorSwatchPicker
            value={tag.color}
            onChange={(color) => {
              onColorChange(color);
              setColorOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>

      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(tag.name);
              onCancelRename();
            }
          }}
          aria-label={`Rename tag "${tag.name}"`}
          className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onStartRename}
          className="min-w-0 flex-1 truncate text-left text-sm"
        >
          {tag.name}
        </button>
      )}

      <span className="shrink-0 text-xs text-muted-foreground">
        {taskCountLabel(tag.taskCount)}
      </span>

      <button
        type="button"
        onClick={() => setConfirmDelete(true)}
        aria-label={`Delete tag "${tag.name}"`}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive focus-visible:text-destructive"
      >
        <Icon name="Trash2" className="size-3.5" aria-hidden="true" />
      </button>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{tag.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {tag.taskCount > 0
                ? `It will be removed from ${tag.taskCount} ${tag.taskCount === 1 ? "task" : "tasks"}. This cannot be undone.`
                : "This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function TagManagerDialog({ tags, open, onOpenChange, onChanged }: TagManagerDialogProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [localTags, setLocalTags] = useState<TagDto[]>(tags);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // The catalog is owned by TodoPage (`board.tags`); this dialog mirrors it
  // locally so drag reordering and inline rename can render optimistically,
  // then resyncs whenever the parent's copy changes (post-`onChanged`).
  useEffect(() => {
    setLocalTags(tags);
  }, [tags]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = localTags.map((t) => t.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const reorderedIds = arrayMove(ids, oldIndex, newIndex);
    const byId = new Map(localTags.map((t) => [t.id, t]));
    setLocalTags(reorderedIds.map((id) => byId.get(id)).filter((t): t is TagDto => t !== undefined));
    rpc
      .call("reorderTags", { ids: reorderedIds })
      .then((result) => {
        setLocalTags(result.tags);
        onChanged();
      })
      .catch((err: unknown) => {
        setLocalTags(tags);
        toast.error(err instanceof Error ? err.message : "Couldn't reorder tags.");
      });
  }

  function renameTag(id: string, name: string) {
    setRenamingId(null);
    rpc
      .call("updateTag", { id, name })
      .then(({ tag }) => {
        setLocalTags((prev) => prev.map((t) => (t.id === id ? tag : t)));
        onChanged();
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Couldn't rename tag.");
      });
  }

  function recolorTag(id: string, color: TagColor) {
    rpc
      .call("updateTag", { id, color })
      .then(({ tag }) => {
        setLocalTags((prev) => prev.map((t) => (t.id === id ? tag : t)));
        onChanged();
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Couldn't recolor tag.");
      });
  }

  function deleteTag(id: string) {
    setLocalTags((prev) => prev.filter((t) => t.id !== id));
    rpc
      .call("deleteTag", { id })
      .then(() => onChanged())
      .catch((err: unknown) => {
        setLocalTags(tags);
        toast.error(err instanceof Error ? err.message : "Couldn't delete tag.");
      });
  }

  async function createTag() {
    try {
      const color = TAG_COLORS[localTags.length % TAG_COLORS.length];
      const name = nextDefaultTagName(localTags);
      const { tag } = await rpc.call("createTag", { name, color });
      setLocalTags((prev) => [...prev, tag]);
      setRenamingId(tag.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create tag.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="flex-row items-center justify-between space-y-0">
          <DialogTitle>Manage tags</DialogTitle>
          <Button type="button" variant="outline" size="sm" onClick={() => void createTag()}>
            <Icon name="Plus" className="size-3.5" aria-hidden="true" />
            New tag
          </Button>
        </DialogHeader>

        {localTags.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No tags yet. Create one to start labelling tasks.
          </p>
        ) : (
          <>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={localTags.map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col gap-0.5">
                  {localTags.map((tag) => (
                    <TagManagerRow
                      key={tag.id}
                      tag={tag}
                      renaming={renamingId === tag.id}
                      onStartRename={() => setRenamingId(tag.id)}
                      onCommitRename={(name) => renameTag(tag.id, name)}
                      onCancelRename={() => setRenamingId(null)}
                      onColorChange={(color) => recolorTag(tag.id, color)}
                      onDelete={() => deleteTag(tag.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            <p className="text-xs text-muted-foreground">
              drag ⠿ to reorder · order drives chip order on every row
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default TagManagerDialog;
