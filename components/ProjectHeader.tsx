// A project's header row.
//
// variant="backlog" (default): collapse chevron, colour badge (opens the
// shared ColorSwatchPicker), inline-editable name (double-click to rename,
// same mechanics as TabStrip's tab rename), a "+" add-task affordance, and
// a "..." menu (Rename / Change colour / Delete, the last behind the
// existing AlertDialog confirm).
//
// variant="in_progress": a plain, read-only group label. Collapse still
// works, but the colour, rename, "+", and "..." menu are all withheld —
// those live in the Backlog only (one editing surface per concept; two
// draggable orderings of one `projects.sort_order` would fight each
// other).
import { useState } from "react";
import type { ProjectDto, TagColor } from "@/contract";
import { cn } from "@/lib/utils";
import { TAG_DOT_CLASS } from "@/lib/tag-colors";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ColorSwatchPicker } from "@/components/ColorSwatchPicker";
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

export interface ProjectHeaderProps {
  project: ProjectDto;
  /** "in_progress" withholds rename/colour/delete/"+" — see file header
   * comment. Default "backlog": today's existing, unchanged behaviour. */
  variant?: "backlog" | "in_progress";
  /** Whether this header acts as a drag handle for project reordering.
   * Default `true`. `ProjectGroup` passes `false` for
   * `variant="in_progress"`: there is no `projects.sort_order` write path
   * from In Progress, so the header renders with no grab affordance/cursor. */
  draggable?: boolean;
  onToggleCollapsed: () => void;
  /** Backlog-only; unused (and safely omittable) when `variant="in_progress"`. */
  onRename?: (name: string) => void;
  onChangeColor?: (color: TagColor) => void;
  onDelete?: () => void;
  /** "+" affordance: reveals the add-task input filed to this project.
   * ProjectHeader itself renders no input — the row lives in ProjectGroup. */
  onAddTask?: () => void;
}

export function ProjectHeader({
  project,
  variant = "backlog",
  draggable = true,
  onToggleCollapsed,
  onRename,
  onChangeColor,
  onDelete,
  onAddTask,
}: ProjectHeaderProps) {
  const isBacklog = variant === "backlog";
  // Collapse state is per-column — read the field that matches this
  // header's own variant, never the other column's bit.
  const isCollapsed = isBacklog ? project.collapsed : project.inProgressCollapsed;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [colorOpen, setColorOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function startRename() {
    setDraft(project.name);
    setRenaming(true);
  }

  function commitRename() {
    const name = draft.trim();
    setRenaming(false);
    if (name.length > 0 && name !== project.name) {
      onRename?.(name);
    }
  }

  const countsLabel =
    project.inProgressCount > 0
      ? `${project.openCount} open · ${project.inProgressCount} in progress`
      : `${project.openCount} open`;

  return (
    <div
      className={cn(
        "group flex min-h-8 items-center gap-2 px-2 py-1",
        !draggable && "cursor-default",
      )}
    >
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label={isCollapsed ? `Expand "${project.name}"` : `Collapse "${project.name}"`}
        className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
      >
        <Icon
          name={isCollapsed ? "ChevronRight" : "ChevronDown"}
          className="size-3.5"
          aria-hidden="true"
        />
      </button>

      {isBacklog ? (
        <Popover open={colorOpen} onOpenChange={setColorOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Change color for project "${project.name}"`}
              className="inline-flex shrink-0 items-center"
            >
              <span
                aria-hidden="true"
                className={cn("size-2.5 rounded-full", TAG_DOT_CLASS[project.color])}
              />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-56" align="start">
            <ColorSwatchPicker
              value={project.color}
              onChange={(color) => {
                onChangeColor?.(color);
                setColorOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      ) : (
        <span
          aria-hidden="true"
          className={cn("size-2.5 shrink-0 rounded-full", TAG_DOT_CLASS[project.color])}
        />
      )}

      {isBacklog && renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(project.name);
              setRenaming(false);
            }
          }}
          aria-label={`Rename project ${project.name}`}
          className="min-w-0 flex-1 border-0 bg-transparent text-sm font-medium outline-none"
        />
      ) : isBacklog ? (
        <button
          type="button"
          onDoubleClick={startRename}
          className="min-w-0 flex-1 truncate text-left text-sm font-medium"
        >
          {project.name}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">
          {project.name}
        </span>
      )}

      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
        {countsLabel}
      </span>

      {isBacklog && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onAddTask}
            aria-label={`Add task to "${project.name}"`}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:text-foreground"
          >
            <Icon name="Plus" className="size-4" aria-hidden="true" />
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`More actions for project "${project.name}"`}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:text-foreground"
              >
                <Icon name="MoreHorizontal" className="size-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={startRename}>
                <Icon name="Edit" className="size-3.5" aria-hidden="true" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setColorOpen(true)}>
                <span
                  aria-hidden="true"
                  className={cn("size-3 rounded-full", TAG_DOT_CLASS[project.color])}
                />
                Change colour
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Icon name="Trash2" className="size-3.5" aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {isBacklog && (
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete "{project.name}"?</AlertDialogTitle>
              <AlertDialogDescription>
                {project.openCount} task{project.openCount === 1 ? "" : "s"} will move to the
                Backlog, unfiled. Nothing is deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  onDelete?.();
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

export default ProjectHeader;
