// List tabs. Click to switch, double-click to rename inline, "+" to
// create, a per-tab "..." menu with Delete behind an AlertDialog confirm,
// and drag to reorder (shares TodoPage's single DndContext — the actual
// `reorderLists` call happens in TodoPage's onDragEnd, this component just
// registers each tab as a sortable item).
import { useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ListDto, rpcContract } from "@/contract";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
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

export interface TabStripProps {
  lists: ListDto[];
  activeListId: string;
  onSelect: (listId: string) => void;
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
  onChanged: () => void;
}

function Tab({
  list,
  active,
  onSelect,
  onChanged,
}: {
  list: ListDto;
  active: boolean;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(list.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: list.id, data: { kind: "list", listId: list.id } });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  function startRename() {
    setDraft(list.name);
    setRenaming(true);
  }

  function commitRename() {
    const name = draft.trim();
    setRenaming(false);
    if (name.length > 0 && name !== list.name) {
      void rpc.call("renameList", { id: list.id, name }).then(onChanged);
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "group flex shrink-0 cursor-grab touch-none items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-sm active:cursor-grabbing",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
        isDragging && "opacity-50",
      )}
    >
      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setRenaming(false);
            }
          }}
          aria-label={`Rename list ${list.name}`}
          className="w-24 border-0 bg-transparent text-sm outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => onSelect(list.id)}
          onDoubleClick={startRename}
          className="max-w-32 truncate"
        >
          {list.name}
        </button>
      )}

      {list.overdueCount > 0 && (
        <span
          className="rounded-full bg-destructive px-1.5 text-[10px] font-medium text-destructive-foreground"
          aria-label={`${list.overdueCount} overdue`}
        >
          {list.overdueCount}
        </span>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More actions for list ${list.name}`}
            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
          >
            <Icon name="MoreHorizontal" className="size-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={startRename}>
            <Icon name="Edit" className="size-3.5" aria-hidden="true" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
            <Icon name="Trash2" className="size-3.5" aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{list.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              All tasks and archive entries in this list are deleted. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void rpc.call("deleteList", { id: list.id }).then(onChanged);
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

export function TabStrip({
  lists,
  activeListId,
  onSelect,
  creating,
  onCreatingChange,
  onChanged,
}: TabStripProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) {
      setDraft("");
      inputRef.current?.focus();
    }
  }, [creating]);

  async function submitCreate() {
    const name = draft.trim();
    onCreatingChange(false);
    if (name.length === 0) return;
    const { list } = await rpc.call("createList", { name });
    onSelect(list.id);
    onChanged();
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto px-1 py-1">
      {lists.map((list) => (
        <Tab
          key={list.id}
          list={list}
          active={list.id === activeListId}
          onSelect={onSelect}
          onChanged={onChanged}
        />
      ))}

      {creating ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submitCreate}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submitCreate();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCreatingChange(false);
            }
          }}
          placeholder="List name"
          aria-label="New list name"
          className="w-28 shrink-0 rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground/50 focus:placeholder:text-muted-foreground"
        />
      ) : (
        <button
          type="button"
          onClick={() => onCreatingChange(true)}
          aria-label="Create list"
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted/50"
        >
          <Icon name="Plus" className="size-3.5" aria-hidden="true" />
          Tab
        </button>
      )}
    </div>
  );
}

export default TabStrip;
