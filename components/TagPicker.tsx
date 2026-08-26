// The row's 🏷 Popover (design spec §4.3): a search-and-create list of the
// global tag catalog, checkboxes that replace a task's full tag set (never
// add/remove pairs — mirrors `setTaskTags`'s RPC shape), and a footer that
// hands off to the tag manager via the board-bus. Follows `DueDatePicker`'s
// `anchor`/`open`/`onOpenChange` shape so `TaskRow` wires it identically to
// the due-date calendar.
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { TAG_COLORS, type TagColor, type TagDto, type TaskDto } from "@/contract";
import { cn } from "@/lib/utils";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { ColorSwatchPicker } from "@/components/ColorSwatchPicker";
import { TAG_DOT_CLASS } from "@/lib/tag-colors";
import { emitBoardCommand } from "@/lib/board-bus";

export interface TagPickerProps {
  task: TaskDto;
  /** The full catalog (`getBoard`'s `tags`), for the checklist and counts. */
  tags: TagDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Anchor element the popover positions against — the row's 🏷 button. */
  anchor: React.ReactNode;
  /** Full-set replace; the caller owns optimism/rollback (see TodoPage). */
  onSetTaskTags: (task: TaskDto, tagIds: string[]) => void;
  /** Creates a tag and resolves with its DTO so it can be applied immediately. */
  onCreateTag: (name: string, color: TagColor) => Promise<TagDto>;
}

export function TagPicker({
  task,
  tags,
  open,
  onOpenChange,
  anchor,
  onSetTaskTags,
  onCreateTag,
}: TagPickerProps) {
  const [query, setQuery] = useState("");
  const [createColor, setCreateColor] = useState<TagColor>(TAG_COLORS[0]);
  const [creating, setCreating] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setColorOpen(false);
    // The next unused palette color, so the first eight tags a user creates
    // are all visually distinct without picking anything themselves.
    setCreateColor(TAG_COLORS[tags.length % TAG_COLORS.length]);
  }, [open, tags.length]);

  const selectedIds = useMemo(() => new Set(task.tags.map((t) => t.id)), [task.tags]);

  // `commitCreate` awaits `onCreateTag` before applying the new tag; `task`
  // (and therefore `selectedIds`) can have moved on by the time that await
  // resolves (e.g. a realtime board refresh, or another toggle). Read the
  // latest task through this ref rather than the closure captured when
  // `commitCreate` was called, so the tag set it applies is never stale.
  const taskRef = useRef(task);
  useEffect(() => {
    taskRef.current = task;
  }, [task]);

  const trimmedQuery = query.trim();
  const filtered = useMemo(() => {
    if (trimmedQuery.length === 0) return tags;
    const needle = trimmedQuery.toLowerCase();
    return tags.filter((t) => t.name.toLowerCase().includes(needle));
  }, [tags, trimmedQuery]);

  const exactMatch = useMemo(
    () => tags.some((t) => t.name.toLowerCase() === trimmedQuery.toLowerCase()),
    [tags, trimmedQuery],
  );
  const showCreateRow = trimmedQuery.length > 0 && !exactMatch;

  function toggle(tagId: string) {
    const next = new Set(selectedIds);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    onSetTaskTags(task, Array.from(next));
  }

  async function commitCreate() {
    if (trimmedQuery.length === 0 || creating) return;
    setCreating(true);
    try {
      const tag = await onCreateTag(trimmedQuery, createColor);
      const currentIds = new Set(taskRef.current.tags.map((t) => t.id));
      currentIds.add(tag.id);
      onSetTaskTags(taskRef.current, Array.from(currentIds));
      setQuery("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create tag.");
    } finally {
      setCreating(false);
    }
  }

  function handleQueryKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showCreateRow) {
        void commitCreate();
      } else if (filtered.length > 0) {
        toggle(filtered[0].id);
      }
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      <PopoverContent className="w-64 space-y-2 p-2" align="start">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleQueryKeyDown}
          placeholder="filter or create…"
          aria-label="Filter or create a tag"
          className="h-8 text-xs"
        />

        {showCreateRow && (
          <div className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5">
            <button
              type="button"
              onClick={() => void commitCreate()}
              disabled={creating}
              aria-label={`Create tag "${trimmedQuery}"`}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium"
            >
              <Icon name="Plus" className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">Create "{trimmedQuery}"</span>
            </button>
            <Popover open={colorOpen} onOpenChange={setColorOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Choose a color for the new tag"
                  className="flex shrink-0 items-center gap-0.5"
                >
                  <span
                    aria-hidden="true"
                    className={cn("size-2.5 rounded-full", TAG_DOT_CLASS[createColor])}
                  />
                  <Icon name="ChevronDown" className="size-3" aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-56" align="end">
                <ColorSwatchPicker
                  value={createColor}
                  onChange={(color) => {
                    setCreateColor(color);
                    setColorOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
        )}

        <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
          {tags.length === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-muted-foreground">
              No tags yet. Type a name to create your first one.
            </p>
          ) : (
            filtered.map((tag) => {
              const checked = selectedIds.has(tag.id);
              return (
                <label
                  key={tag.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted/50"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(tag.id)}
                    aria-label={`${checked ? "Remove" : "Apply"} tag "${tag.name}"`}
                  />
                  <span
                    aria-hidden="true"
                    className={cn("size-2 shrink-0 rounded-full", TAG_DOT_CLASS[tag.color])}
                  />
                  <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                  <span className="shrink-0 text-muted-foreground">{tag.taskCount}</span>
                </label>
              );
            })
          )}
        </div>

        <button
          type="button"
          onClick={() => emitBoardCommand("open-tag-manager")}
          aria-label="Manage tags"
          className="flex w-full items-center gap-1.5 border-t border-border pt-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Icon name="Settings" className="size-3.5" aria-hidden="true" />
          Manage tags…
        </button>
      </PopoverContent>
    </Popover>
  );
}

export default TagPicker;
