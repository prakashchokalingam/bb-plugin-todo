// The Todo board page: active-list resolution from `subPath`, the single
// DndContext for the whole page (tab reorder + both task columns), the one
// shared `useNow` interval, and the Backlog/Today columns + Archive
// overlay.
//
// Phase 4 (the-todo-plugin-feels-stateful-valley.md): Backlog and Today are
// now two columns side by side over the SAME comprehensive task tree
// (`board.backlog.tasks`) rather than two stacked sections fed by two
// separate server-provided lists. Today's grouped view is derived locally,
// once per render, by `lib/todayView.ts`'s `selectTodayView` — there is no
// `board.today.tasks` anymore (see `hooks/useBoard.ts`'s `BoardData`).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ProjectDto, rpcContract, TagColor, TagDto, TagRefDto, TaskDto } from "@/contract";
import { TAG_COLORS } from "@/contract";
import type { BoardData } from "@/hooks/useBoard";
import { useBoard } from "@/hooks/useBoard";
import { useNow } from "@/hooks/useNow";
import { formatDue } from "@/lib/humanize";
import { useBoardCommand } from "@/lib/board-bus";
import { useCompleteWithUndo } from "@/hooks/useCompleteWithUndo";
import { selectTodayView } from "@/lib/todayView";
import {
  applyMoveToBoard,
  computeProjectReorder,
  computeTaskMove,
  findTaskInBoard,
  type Bucket,
  type ComputeMoveResult,
  type DragBoardTasks,
  type DragTaskRef,
  type DropTarget,
  type MoveTaskInput,
} from "@/lib/drag";
import { Icon } from "@/components/ui/icon";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabStrip } from "@/components/TabStrip";
import { Section, type BoardActions, type SectionProjectGroup } from "@/components/Section";
import ArchivePanel from "@/components/ArchivePanel";
import TagManagerDialog from "@/components/TagManagerDialog";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatDayHeading(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return `${WEEKDAYS[dt.getDay()]} ${d} ${MONTHS[(m ?? 1) - 1]}`;
}

const DEFAULT_TICK_MS = 60_000;

/**
 * Folds `applyMoveToBoard`'s pure task-tree projection into a full
 * `BoardData`, so the optimistic update also keeps the header counters
 * (`backlog.total`, `backlog.overdue`) coherent instead of showing an
 * obviously stale number for the RPC round trip.
 *
 * `backlog.total`/`backlog.overdue` are fully recomputable locally: every
 * open backlog row (there are never any other kind — completed rows leave
 * the board immediately per SPEC.md rule 3) is right here in `tasks`.
 *
 * `today.planned`/`today.completed` are deliberately left untouched. Before
 * Phase 4 there was a `today.tasks` array this component could diff against
 * to derive a `planned` delta; since Phase 2 dropped that array from the
 * wire, there is nothing local to diff anymore, and `today.completed` was
 * already never derivable locally (it counts already-archived rows this
 * view never holds). Both scalars settle on the next refetch — the Today
 * *view* itself (grouping, membership, which rows render) still updates
 * immediately, because `selectTodayView` re-derives it from `inToday`, which
 * this function DOES patch via `applyMoveToBoard`.
 */
function applyOptimisticBoard(board: BoardData, outcome: ComputeMoveResult, now: number): BoardData {
  const prevTasks: DragBoardTasks = { backlog: board.backlog.tasks };
  const nextTasks = applyMoveToBoard(prevTasks, outcome, board.today.day);

  const backlogOverdue = [
    ...nextTasks.backlog,
    ...nextTasks.backlog.flatMap((t) => t.subtasks),
  ].filter((t) => t.dueAt !== null && t.dueAt < now).length;

  return {
    ...board,
    backlog: {
      ...board.backlog,
      total: nextTasks.backlog.length,
      overdue: backlogOverdue,
      tasks: nextTasks.backlog,
    },
  };
}

/** Replaces the tag list on the task matching `taskId` (top-level or a
 * subtask) with `tags`, leaving everything else in the board untouched.
 * Used to apply a `setTaskTags` toggle optimistically — before the RPC round
 * trip — so the chip appears on the row immediately. */
function applyTaskTagsToBoard(board: BoardData, taskId: string, tags: TagRefDto[]): BoardData {
  function mapTasks(tasks: TaskDto[]): TaskDto[] {
    return tasks.map((t) => {
      if (t.id === taskId) return { ...t, tags };
      if (t.subtasks.length > 0) {
        const subtasks = mapTasks(t.subtasks);
        if (subtasks !== t.subtasks) return { ...t, subtasks };
      }
      return t;
    });
  }
  return {
    ...board,
    backlog: { ...board.backlog, tasks: mapTasks(board.backlog.tasks) },
  };
}

/** Every top-level task plus its subtasks, flattened, for tick-interval
 * scanning. `board.backlog.tasks` is the one comprehensive tree since Phase
 * 2 — Today renders a filtered view over these same rows, not a second set. */
function flattenTasks(board: BoardData): TaskDto[] {
  const all: TaskDto[] = [];
  for (const t of board.backlog.tasks) {
    all.push(t, ...t.subtasks);
  }
  return all;
}

/** The dnd-kit wiring only turns component state into plain `lib/drag`
 * inputs; the actual before/after/nest/bucket/dismiss decision lives there
 * so it can be unit-tested without a DOM or a real drag gesture (see
 * `lib/drag.test.ts`). */
type ActiveDragData =
  | { kind: "list"; listId: string }
  | { kind: "task"; taskId: string; parentId: string | null; bucket: "backlog" | "today" }
  | { kind: "project"; projectId: string };

/** What a droppable/sortable's `data.current` looks like when it's the
 * target of a drop. A task row's own data doubles as both its drag-source
 * data (`ActiveDragData`'s "task" variant) and its drop-target data, since
 * it registers exactly one `useSortable` id (`taskDragId`) for both roles —
 * see `TaskRow.tsx`. `column` on the "project"/"section" variants is which
 * column's rendered copy of that drop zone was actually hit (see
 * `dropZoneId`'s doc comment in `lib/drag.ts`); the project header's OWN
 * reorder-target registration (`ProjectGroup`'s `useSortable`, Backlog-only)
 * carries no `column`, since project reordering never needs one.
 */
type OverData =
  | { kind: "task"; taskId: string; parentId: string | null; bucket: "backlog" | "today" }
  | { kind: "project"; projectId: string; column?: Bucket }
  | { kind: "section"; column: Bucket };

/** Which column's rendered DOM instance a task drag id belongs to — mirrors
 * `TaskRow.tsx`'s `taskDragId` encoding (`"today:<id>"` vs the bare id)
 * exactly, since that's the only place a task's per-column identity is
 * recorded once the drag is underway; the dnd-kit `data` payload itself
 * (`ActiveDragData`/`OverData`'s "task" variant) intentionally carries only
 * the task's real, server-stored `bucket`, not which column's copy was
 * grabbed. */
function columnFromDragId(id: string | number): Bucket {
  return String(id).startsWith("today:") ? "today" : "backlog";
}

/** Flashes and scrolls a Backlog row (a project header or a task) into view —
 * the click-through target of a Today row's trail line. Best-effort: jsdom
 * (unit tests) has no `scrollIntoView` implementation, and a source row that
 * has scrolled out of the DOM (virtualization) simply isn't found — neither
 * case is worth surfacing an error for. */
function flashRow(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;
  el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  el.classList.add("ring-2", "ring-primary");
  window.setTimeout(() => {
    el.classList.remove("ring-2", "ring-primary");
  }, 1200);
}

export interface TodoPageProps {
  subPath: string;
}

export function TodoPage({ subPath }: TodoPageProps) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const activeListParam = subPath.length > 0 ? subPath : null;
  const { board, loading, error, refetch, setOptimisticBoard, patchBoard } =
    useBoard(activeListParam);

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [creatingTab, setCreatingTab] = useState(false);
  const [tickMs, setTickMs] = useState(DEFAULT_TICK_MS);
  const now = useNow(tickMs);

  const [activeDrag, setActiveDrag] = useState<ActiveDragData | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const completeWithUndo = useCompleteWithUndo(refetch);

  // Per-task sequence numbers for `onSetTaskTags`'s optimistic apply/revert:
  // a failed `setTaskTags` call should only roll back the chip list if no
  // *later* toggle on the same task has already superseded it (see the
  // interleaving scenario documented on `onSetTaskTags` below).
  const tagSeqRef = useRef(new Map<string, number>());

  useBoardCommand((cmd) => {
    if (cmd === "open-archive") setArchiveOpen(true);
    else if (cmd === "create-list") setCreatingTab(true);
    else if (cmd === "open-tag-manager") setTagManagerOpen(true);
  });

  // Recompute the minimum re-render interval across every visible due chip
  // whenever `now` ticks or the board data changes. One shared interval for
  // the whole page — never one per row.
  useEffect(() => {
    if (!board) return;
    const withDue = flattenTasks(board).filter((t) => t.dueAt !== null);
    if (withDue.length === 0) {
      setTickMs(DEFAULT_TICK_MS);
      return;
    }
    const min = Math.min(
      ...withDue.map((t) => formatDue(t.dueAt as number, now, t.hasDueTime).tickMs),
    );
    setTickMs(min);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, board]);

  // The grouped Today view, derived once per render from the SAME
  // comprehensive Backlog tree the Backlog column renders (`lib/todayView`).
  // Called unconditionally, before the `!board` guard below, so this stays a
  // valid hook call on every render regardless of loading state.
  const todayView = useMemo(
    () => selectTodayView(board?.backlog.tasks ?? [], board?.projects ?? []),
    [board?.backlog.tasks, board?.projects],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as ActiveDragData | undefined;
    setActiveDrag(data ?? null);
  }

  function handleDragOver(event: DragOverEvent) {
    setOverId(event.over ? String(event.over.id) : null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveDrag(null);
    setOverId(null);
    if (!over || !board) return;

    const activeData = active.data.current as ActiveDragData | undefined;
    if (!activeData) return;

    if (activeData.kind === "list") {
      const overData = over.data.current as ActiveDragData | undefined;
      if (!overData || overData.kind !== "list" || over.id === active.id) return;
      const ids = board.lists.map((l) => l.id);
      const oldIndex = ids.indexOf(String(active.id));
      const newIndex = ids.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(ids, oldIndex, newIndex);
      void rpc.call("reorderLists", { ids: reordered }).then(() => refetch());
      return;
    }

    if (activeData.kind === "project") {
      // Drag matrix: "project header -> project header: reorder projects".
      const overData = over.data.current as OverData | undefined;
      if (!overData || overData.kind !== "project" || over.id === active.id) return;
      const projectIds = board.projects.map((p) => p.id);
      const reordered = computeProjectReorder(activeData.projectId, overData.projectId, projectIds);
      if (!reordered) return;
      const preDropBoard = board;
      patchBoard((current) => {
        const byId = new Map(current.projects.map((p) => [p.id, p]));
        return {
          ...current,
          projects: reordered
            .map((id) => byId.get(id))
            .filter((p): p is ProjectDto => p !== undefined),
        };
      });
      void rpc
        .call("reorderProjects", { listId: activeListId, ids: reordered })
        .then(() => refetch())
        .catch((err) => {
          setOptimisticBoard(preDropBoard);
          toast.error(err instanceof Error ? err.message : "Couldn't reorder projects.");
        });
      return;
    }

    // activeData.kind === "task" from here on.
    const overData = over.data.current as OverData | undefined;
    if (!overData) return;

    const activeTask = findTaskInBoard({ backlog: board.backlog.tasks }, activeData.taskId);
    const activeColumn = columnFromDragId(active.id);

    const activeRef: DragTaskRef = {
      taskId: activeData.taskId,
      parentId: activeData.parentId,
      bucket: activeData.bucket,
      inToday: activeTask?.inToday ?? false,
      column: activeColumn,
    };
    const target: DropTarget =
      overData.kind === "section"
        ? { kind: "section", column: overData.column }
        : overData.kind === "project"
          ? { kind: "project", projectId: overData.projectId, column: overData.column ?? activeColumn }
          : { kind: "task", taskId: overData.taskId, column: columnFromDragId(over.id) };

    const outcome = computeTaskMove(
      activeRef,
      target,
      { backlog: board.backlog.tasks },
      active.rect.current.translated ?? active.rect.current.initial,
      over.rect,
    );
    if (!outcome) return;

    // Apply the outcome to local state immediately, before the RPC resolves,
    // so the row is already in its destination by the time dnd-kit's drop
    // animation would otherwise play the `DragOverlay` back to its old spot
    // (the "goes to the right bucket but the animation flies back" bug).
    // `dropAnimation={null}` below removes that animation outright; this is
    // the other half — making sure there's nothing wrong-looking underneath
    // it regardless.
    const preDropBoard = board;
    setOptimisticBoard(applyOptimisticBoard(board, outcome, now));

    if (outcome.kind === "dismiss") {
      void rpc
        .call("dismissFromToday", { id: outcome.id })
        .then(() => refetch())
        .catch((err) => {
          setOptimisticBoard(preDropBoard);
          toast.error(err instanceof Error ? err.message : "Couldn't remove task from Today.");
        });
      return;
    }

    void rpc
      .call("moveTask", outcome.move)
      .then(() => refetch())
      .catch((err) => {
        // Never leave the UI showing a move the server rejected: snap back
        // to exactly the pre-drop arrangement rather than whatever the
        // optimistic guess produced.
        setOptimisticBoard(preDropBoard);
        toast.error(err instanceof Error ? err.message : "Couldn't move task.");
      });
  }

  if (loading && !board) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }
  if (error && !board) {
    return <div className="p-4 text-sm text-destructive">Failed to load: {error.message}</div>;
  }
  if (!board) return null;

  const activeListId = board.activeListId;

  const actions: BoardActions = {
    now,
    overId,
    onToggleComplete: (task) => completeWithUndo({ id: task.id, title: task.title }),
    onRenameTask: (id, title) => {
      void rpc.call("updateTask", { id, title }).then(() => refetch());
    },
    onSetDue: (id, dueAt, hasDueTime) => {
      void rpc.call("updateTask", { id, dueAt, hasDueTime }).then(() => refetch());
    },
    onDeleteTask: (id) => {
      void rpc.call("deleteTask", { id }).then(() => refetch());
    },
    onCreateTask: ({ bucket, parentId, title }) => {
      void rpc
        .call("createTask", {
          listId: activeListId,
          bucket,
          title,
          parentId,
          dueAt: null,
          hasDueTime: false,
          position: "bottom",
        })
        .then(() => refetch());
    },
    tagCatalog: board.tags,
    onSetTaskTags: (task, tagIds) => {
      // Per-task sequence guard: if a later toggle on this same task fires
      // (and is still pending or has already succeeded) before this one's
      // RPC settles, this call's own id is no longer the latest — its
      // eventual failure must not roll back state a newer call already
      // moved past. Concretely: toggle A on task X (seq 1), then toggle B
      // on X before A resolves (seq 2), then B succeeds and A rejects — A's
      // catch below sees seq 2 !== 1 and skips the revert, so X keeps B's
      // server-confirmed tags instead of losing them.
      const mySeq = (tagSeqRef.current.get(task.id) ?? 0) + 1;
      tagSeqRef.current.set(task.id, mySeq);
      const previousTags = task.tags;

      // Optimistic full-set replace: resolve the new chip list from the
      // CURRENT catalog (via `patchBoard`'s functional form, never the
      // `board` closed over by this render) immediately — getBoard's `tags`
      // is already ordered by sortOrder, so this preserves the "consistent
      // chip order everywhere" invariant — rather than waiting for the
      // round trip. Reading the catalog off the current board (not the
      // stale closure) is what lets a tag created moments ago in this same
      // gesture (see `onCreateTag` below) resolve to a real chip instead of
      // being silently filtered out.
      patchBoard((current) => {
        const newTags: TagRefDto[] = current.tags
          .filter((t) => tagIds.includes(t.id))
          .map((t) => ({ id: t.id, name: t.name, color: t.color }));
        return applyTaskTagsToBoard(current, task.id, newTags);
      });

      void rpc
        .call("setTaskTags", { taskId: task.id, tagIds })
        .then(() => refetch())
        .catch((err) => {
          if (tagSeqRef.current.get(task.id) === mySeq) {
            // Revert only this task's tags, against the CURRENT board, so
            // any unrelated (or superseding, already-excluded-above)
            // concurrent change elsewhere on the board survives.
            patchBoard((current) => applyTaskTagsToBoard(current, task.id, previousTags));
          }
          toast.error(err instanceof Error ? err.message : "Couldn't update tags.");
        });
    },
    onCreateTag: async (name: string, color: TagColor): Promise<TagDto> => {
      const { tag } = await rpc.call("createTag", { name, color });
      // Merge the new tag straight into the catalog the picker/rows read
      // from, instead of relying on `refetch()` to bring it back — the
      // caller (TagPicker.commitCreate) applies this tag to the task
      // immediately afterwards, and that apply resolves the chip from
      // `current.tags` (see `onSetTaskTags` above), so the catalog must
      // already contain it by then. `createTag` appends with the highest
      // `sortOrder` (spec §2.3), so appending here preserves catalog order.
      patchBoard((current) => ({ ...current, tags: [...current.tags, tag] }));
      void refetch();
      return tag;
    },
  };

  // `const` arrow functions (not hoisted `function` declarations) placed
  // after the `if (!board) return null` guard above, so TypeScript's
  // control-flow narrowing of `board` to non-null carries into their
  // closures — a hoisted declaration would be reachable (in principle)
  // before the guard runs, so TS treats `board` as still nullable inside it.

  /** Applies `patch` to one project in `current.projects`, leaving every
   * other project untouched — the project-mutation analogue of
   * `applyTaskTagsToBoard` above. */
  const patchProjectLocal = (
    current: BoardData,
    id: string,
    patch: Partial<ProjectDto>,
  ): BoardData => ({
    ...current,
    projects: current.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  });

  const toggleProjectCollapsed = (project: ProjectDto) => {
    const next = !project.collapsed;
    patchBoard((current) => patchProjectLocal(current, project.id, { collapsed: next }));
    void rpc.call("setProjectCollapsed", { id: project.id, collapsed: next }).catch((err) => {
      patchBoard((current) => patchProjectLocal(current, project.id, { collapsed: !next }));
      toast.error(err instanceof Error ? err.message : "Couldn't update project.");
    });
  };

  const renameProject = (id: string, name: string) => {
    const previousName = board.projects.find((p) => p.id === id)?.name ?? name;
    patchBoard((current) => patchProjectLocal(current, id, { name }));
    void rpc
      .call("updateProject", { id, name })
      .then(() => refetch())
      .catch((err) => {
        patchBoard((current) => patchProjectLocal(current, id, { name: previousName }));
        toast.error(err instanceof Error ? err.message : "Couldn't rename project.");
      });
  };

  const changeProjectColor = (id: string, color: TagColor) => {
    const previousColor = board.projects.find((p) => p.id === id)?.color ?? color;
    patchBoard((current) => patchProjectLocal(current, id, { color }));
    void rpc
      .call("updateProject", { id, color })
      .then(() => refetch())
      .catch((err) => {
        patchBoard((current) => patchProjectLocal(current, id, { color: previousColor }));
        toast.error(err instanceof Error ? err.message : "Couldn't change project colour.");
      });
  };

  const deleteProject = (id: string) => {
    const preDropBoard = board;
    // Optimistically mirror the server: the project disappears and its
    // tasks release to loose (`project_id = NULL`) rather than vanishing —
    // "Nothing is deleted" (design doc's delete-confirm copy).
    patchBoard((current) => ({
      ...current,
      projects: current.projects.filter((p) => p.id !== id),
      backlog: {
        ...current.backlog,
        tasks: current.backlog.tasks.map((t) =>
          (t.projectId ?? null) === id ? { ...t, projectId: null } : t,
        ),
      },
    }));
    void rpc
      .call("deleteProject", { id })
      .then(() => refetch())
      .catch((err) => {
        setOptimisticBoard(preDropBoard);
        toast.error(err instanceof Error ? err.message : "Couldn't delete project.");
      });
  };

  const addTaskToProject = (projectId: string, title: string) => {
    void rpc
      .call("createTask", {
        listId: activeListId,
        bucket: "backlog",
        title,
        parentId: null,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
        projectId,
      })
      .then(() => refetch());
  };

  /** The Backlog add-row's `#Name` entry point (design doc "Creating a
   * project", entry point 1). Colours cycle through the palette so
   * successive inline-created projects don't all land on the same swatch. */
  const createProjectInline = (name: string) => {
    const color: TagColor = TAG_COLORS[board.projects.length % TAG_COLORS.length];
    void rpc
      .call("createProject", { listId: activeListId, name, color })
      .then(({ project }) => {
        patchBoard((current) => ({ ...current, projects: [...current.projects, project] }));
        void refetch();
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Couldn't create project.");
      });
  };

  /**
   * Fired by a row's today marker: remove the task from Today. Routed off
   * `task.bucket`, exactly like the design doc's "two write paths" (Data
   * plan section): a manually-scheduled task (`bucket === 'today'`) flips
   * back via the existing `moveTask` snap-home transition (parent/project
   * unchanged, beforeId/afterId both omitted so it lands back in its
   * untouched slot rather than being repositioned); an auto-included task
   * (`bucket === 'backlog'`, `inToday` true purely from its due date) has no
   * `bucket` flag to clear, so it goes through `dismissFromToday` instead —
   * the same "dismiss" outcome `computeTaskMove` produces for the drag
   * gesture that does the same thing, so both paths funnel through the same
   * `applyOptimisticBoard` projection.
   */
  const removeFromToday = (id: string) => {
    const task = findTaskInBoard({ backlog: board.backlog.tasks }, id);
    if (!task) return;
    const preDropBoard = board;

    if (task.bucket === "today") {
      const move: MoveTaskInput = {
        id,
        bucket: "backlog",
        parentId: task.parentId,
        beforeId: null,
        afterId: null,
      };
      setOptimisticBoard(applyOptimisticBoard(board, { kind: "move", move }, now));
      void rpc
        .call("moveTask", move)
        .then(() => refetch())
        .catch((err) => {
          setOptimisticBoard(preDropBoard);
          toast.error(err instanceof Error ? err.message : "Couldn't remove task from Today.");
        });
      return;
    }

    setOptimisticBoard(applyOptimisticBoard(board, { kind: "dismiss", id }, now));
    void rpc
      .call("dismissFromToday", { id })
      .then(() => refetch())
      .catch((err) => {
        setOptimisticBoard(preDropBoard);
        toast.error(err instanceof Error ? err.message : "Couldn't remove task from Today.");
      });
  };

  /** The trail line's click-through: scroll the Backlog to the project's
   * header row, or to the parent task's own row, and flash it. */
  const navigateToProject = (projectId: string) => {
    flashRow(`[data-project-id="${projectId}"]`);
  };
  const navigateToParent = (parentId: string) => {
    flashRow(`[data-task-id="${parentId}"]`);
  };

  const looseBacklogTasks = board.backlog.tasks.filter((t) => (t.projectId ?? null) === null);
  const backlogProjectGroups: SectionProjectGroup[] = board.projects.map((project) => ({
    project,
    tasks: board.backlog.tasks.filter((t) => t.projectId === project.id),
  }));
  const todayProjectGroups: SectionProjectGroup[] = todayView.projects.map((g) => ({
    project: g.project,
    tasks: g.tasks,
    orphanSubtasks: g.orphanSubtasks,
  }));

  const activeTask =
    activeDrag?.kind === "task"
      ? findTaskInBoard({ backlog: board.backlog.tasks }, activeDrag.taskId)
      : null;
  const activeList =
    activeDrag?.kind === "list" ? board.lists.find((l) => l.id === activeDrag.listId) : null;
  const activeProject =
    activeDrag?.kind === "project" ? board.projects.find((p) => p.id === activeDrag.projectId) : null;

  return (
    // TagChip's compact (below-`md`) rendering wraps its dot in a Tooltip —
    // this is the one place in the tree that needs to supply the Radix
    // Tooltip context for that to work, since nothing above `TodoPage`
    // (the plugin's panel host) provides one.
    <TooltipProvider>
    <div className="flex h-full min-w-0 flex-col gap-3 overflow-hidden p-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <TabStrip
          lists={board.lists}
          activeListId={activeListId}
          onSelect={(id) => navigate.toPluginPanel("todo", { subPath: id })}
          creating={creatingTab}
          onCreatingChange={setCreatingTab}
          onChanged={refetch}
        />

        {/*
          Two-column layout, container-query driven (Tailwind v4.3 native
          `@container`/`@3xl:`, never a viewport media query —
          `useMediaQuery`/`useIsCompactViewport` key off the BROWSER
          viewport, and a bb nav panel's width is independent of it: a
          maximized window with a narrow panel must still stack). Breakpoint
          chosen against the two real constraints named in the plan/UX doc
          rather than guessed: the page must stay usable as a single column
          down to a 420px floor, and two columns need roughly 2×340–380px
          plus a gap to be worth the split (~700–780px). Tailwind's `3xl`
          container size is 768px — comfortably above that 700–780px need
          and nowhere near the 420px single-column floor, so there's no
          in-between width where the split would be attempted but too
          cramped to read.

          Narrow (below `@3xl`): the existing single-column stacked
          fallback, but with Today FIRST (`order-1`/`order-2`, flipped back
          to Backlog-left/Today-right at `@3xl`) — "when space is scarce,
          execution beats planning." The whole page's own `overflow-hidden`
          (above) hands scrolling to this inner region instead, so the two
          columns can each scroll independently once they're side by side.

          Wide (>= `@3xl`): Backlog left, Today right, each `min-w-0
          flex-1` and each its own `overflow-y-auto` region — scrolling one
          never moves the other.
        */}
        <div className="@container min-h-0 flex-1">
          <div className="flex h-full min-h-0 flex-col gap-y-8 overflow-y-auto @3xl:flex-row @3xl:gap-x-6 @3xl:gap-y-0 @3xl:overflow-visible">
            <div className="order-2 flex min-w-0 flex-1 flex-col @3xl:order-1 @3xl:min-h-0 @3xl:overflow-y-auto">
              <Section
                column="backlog"
                heading="BACKLOG"
                count={board.backlog.total}
                ringValue={board.backlog.overdue}
                ringTotal={board.backlog.total}
                ringTone="destructive"
                ringLabel={`${board.backlog.overdue} overdue`}
                actions={actions}
                addPlaceholder="add to backlog · #Name for a new project"
                projectGroups={backlogProjectGroups}
                looseTasks={looseBacklogTasks}
                onToggleProjectCollapsed={toggleProjectCollapsed}
                onRenameProject={renameProject}
                onChangeProjectColor={changeProjectColor}
                onDeleteProject={deleteProject}
                onAddTaskToProject={addTaskToProject}
                onCreateProject={createProjectInline}
                onRemoveFromToday={removeFromToday}
                onNavigateToProject={navigateToProject}
                onNavigateToParent={navigateToParent}
              />
            </div>

            <div className="order-1 flex min-w-0 flex-1 flex-col @3xl:order-2 @3xl:min-h-0 @3xl:overflow-y-auto">
              <Section
                column="today"
                heading={`TODAY · ${formatDayHeading(board.today.day)}`}
                ringValue={board.today.completed}
                ringTotal={board.today.planned}
                ringTone="primary"
                ringLabel={`${board.today.completed}/${board.today.planned} done`}
                actions={actions}
                addPlaceholder="add to today"
                projectGroups={todayProjectGroups}
                looseTasks={todayView.looseTasks}
                looseOrphanSubtasks={todayView.looseOrphanSubtasks}
                onToggleProjectCollapsed={toggleProjectCollapsed}
                onRemoveFromToday={removeFromToday}
                onNavigateToProject={navigateToProject}
                onNavigateToParent={navigateToParent}
              />
            </div>
          </div>
        </div>

        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <div className="flex min-h-8 items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-sm shadow-md">
              <Icon name="DragDropVertical" className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{activeTask.title}</span>
            </div>
          ) : activeList ? (
            <div className="rounded-md border border-border bg-card px-3 py-1 text-sm shadow-md">
              {activeList.name}
            </div>
          ) : activeProject ? (
            <div className="rounded-md border border-border bg-card px-3 py-1 text-sm shadow-md">
              {activeProject.name}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <ArchivePanel
        listId={activeListId}
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        onChanged={refetch}
      />

      {/* Mounted exactly once here (never inside TagPicker/TaskRow) — a
          twenty-row board would otherwise mount twenty dialogs. */}
      <TagManagerDialog
        tags={board.tags}
        open={tagManagerOpen}
        onOpenChange={setTagManagerOpen}
        onChanged={refetch}
      />
    </div>
    </TooltipProvider>
  );
}

export default TodoPage;
