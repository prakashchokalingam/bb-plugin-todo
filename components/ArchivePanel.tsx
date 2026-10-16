// bb-plugin-todo — Archive dialog (day groups newest-first, restore-forever,
// paginated "Load more", "Clear all" behind an AlertDialog confirm). Renders
// as a bottom drawer on compact viewports for free via the vendored Dialog.
//
// `listId` is untrusted input from the caller — every open (and every id
// change) re-fetches from the server rather than trusting any cached payload.
import { useEffect, useState } from "react";
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import type { rpcContract, TaskDto } from "@/contract";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Separator } from "@/components/ui/separator";
import { TaskText } from "@/components/TaskText";
import { ImageThumbs } from "@/components/ImageThumbs";
import { singleLineLabel } from "@/lib/taskText";

const PAGE_SIZE = 100;

interface ArchiveGroup {
  day: string;
  tasks: TaskDto[];
}

export interface ArchivePanelProps {
  listId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  /** Host link opener for URLs in archived titles; see `BoardActions.onOpenUrl`. */
  onOpenUrl?: (url: string) => boolean;
}

function formatDayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function mergeGroups(
  existing: ArchiveGroup[],
  incoming: ArchiveGroup[],
): ArchiveGroup[] {
  const merged = existing.map((g) => ({ ...g, tasks: [...g.tasks] }));
  for (const g of incoming) {
    const last = merged[merged.length - 1];
    if (last && last.day === g.day) {
      last.tasks.push(...g.tasks);
    } else {
      merged.push({ day: g.day, tasks: [...g.tasks] });
    }
  }
  return merged;
}

export default function ArchivePanel({
  listId,
  open,
  onOpenChange,
  onChanged,
  onOpenUrl,
}: ArchivePanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [listName, setListName] = useState<string | null>(null);
  const [groups, setGroups] = useState<ArchiveGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = (nextOffset: number, replace: boolean) => {
    setLoading(true);
    setError(null);
    rpc
      .call("getArchive", { listId, limit: PAGE_SIZE, offset: nextOffset })
      .then((result) => {
        setGroups((prev) =>
          replace
            ? result.groups.map((g) => ({ day: g.day, tasks: [...g.tasks] }))
            : mergeGroups(prev, result.groups),
        );
        setTotal(result.total);
        setHasMore(result.hasMore);
        setOffset(nextOffset + PAGE_SIZE);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Couldn't load archive.");
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const loadListName = () => {
    rpc
      .call("getBoard", { listId })
      .then((result) => {
        const list = result.lists.find((l) => l.id === listId);
        setListName(list ? list.name : null);
      })
      .catch(() => {
        setListName(null);
      });
  };

  // Reset pagination and refetch whenever the dialog opens or the target
  // list changes — `listId` is untrusted, never trust a stale cache for it.
  useEffect(() => {
    if (!open) return;
    setGroups([]);
    setOffset(0);
    setHasMore(false);
    setTotal(0);
    loadListName();
    loadPage(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listId]);

  useRealtime("board", () => {
    if (!open) return;
    loadPage(0, true);
  });

  const restore = (ids: string[]) => {
    rpc
      .call("restoreTasks", { ids })
      .then(() => {
        onChanged();
        loadPage(0, true);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Couldn't restore.");
      });
  };

  const remove = (id: string) => {
    rpc
      .call("deleteTask", { id })
      .then(() => {
        onChanged();
        loadPage(0, true);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Couldn't delete.");
      });
  };

  const clearAll = () => {
    rpc
      .call("clearArchive", { listId })
      .then(() => {
        onChanged();
        setGroups([]);
        setOffset(0);
        setHasMore(false);
        setTotal(0);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Couldn't clear archive.");
      });
  };

  const title = listName ? `Archive · ${listName}` : "Archive";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="flex-row items-center justify-between space-y-0">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {total > 0 ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-end"
              >
                Clear all
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear the archive?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete {total}{" "}
                  {total === 1 ? "item" : "items"} archived in{" "}
                  {listName ?? "this list"}, with their images. This can't be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={clearAll}>
                  Delete {total} {total === 1 ? "item" : "items"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}

        {total === 0 && !loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing archived yet{listName ? ` in ${listName}` : ""}.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <div key={group.day} className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2 text-sm font-medium text-foreground">
                  <span>{formatDayLabel(group.day)}</span>
                  <span className="text-xs text-muted-foreground">
                    · {group.tasks.length}
                  </span>
                </div>
                <Separator />
                <ul className="flex flex-col gap-1">
                  {group.tasks.map((task) => (
                    <li
                      key={task.id}
                      className="flex min-h-8 items-start justify-between gap-2 py-1 text-sm"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <TaskText
                          title={task.title}
                          onOpenUrl={onOpenUrl}
                          className="min-w-0 flex-1 text-foreground"
                        />
                        <ImageThumbs
                          label={singleLineLabel(task.title)}
                          items={task.images.map((img) => ({ key: img.id, src: img.url }))}
                        />
                      </div>
                      <span className="-my-1 flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Restore ${singleLineLabel(task.title)}`}
                          onClick={() =>
                            restore([
                              task.id,
                              ...task.subtasks.map((st) => st.id),
                            ])
                          }
                        >
                          <Icon name="ArchiveRestore" className="size-3.5" />
                          restore
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${singleLineLabel(task.title)} permanently`}
                          onClick={() => remove(task.id)}
                        >
                          <Icon name="Trash2" className="size-3.5" />
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {hasMore ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-center"
                disabled={loading}
                onClick={() => loadPage(offset, false)}
              >
                {loading ? "Loading…" : "Load more"}
              </Button>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
