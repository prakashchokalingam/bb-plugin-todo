// The Todo board page: active-list resolution from `subPath`, the single
// DndContext for the whole page (tab reorder + both task sections), the one
// shared `useNow` interval, and the Backlog/Today sections + Archive
// overlay.
import { useEffect, useRef, useState } from "react";
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
import {
  applyMoveToBoard,
  computeProjectReorder,
  computeTaskMove,
  findTaskInBoard,
  type DragBoardTasks,
  type DragTaskRef,
  type DropTarget,
  type MoveTaskInput,
} from "@/lib/drag";
import { Icon } from "@/components/ui/icon";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabStrip } from "@/components/TabStrip";
import { Section, type BoardActions } from "@/components/Section";
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

/** Counts every row (top-level + subtasks) across both sections whose `day`
 * equals `day` — used to derive the *change* in `today.planned` a move
 * causes (see `applyOptimisticBoard` below). Only ever compares two of
 * these counts against each other, so it doesn't matter that it can't see
 * completed-and-archived today rows (the server's `planned` counts those
 * too); a move never touches completion status, so that portion of the
 * count is invariant and cancels out of the diff. */
function countTodayRows(tasks: DragBoardTasks, day: string): number {
  let n = 0;
  for (const bucket of [tasks.backlog, tasks.today]) {
    for (const t of bucket) {
      if (t.day === day) n += 1;
      for (const s of t.subtasks) {
        if (s.day === day) n += 1;
      }
    }
  }
  return n;
}

/**
 * Folds `applyMoveToBoard`'s pure task-tree projection into a full
 * `BoardData`, so the optimistic update also keeps the header counters
 * (`backlog.total`, `backlog.overdue`, `today.planned`) coherent instead of
 * showing an obviously stale number for the RPC round trip.
 *
 * - `backlog.total`/`backlog.overdue` are fully recomputable locally: every
 *   open backlog row (there are never any other kind — completed rows leave
 *   the board immediately per SPEC.md rule 3) is right here in `tasks`.
 * - `today.planned` counts `day = today` rows across BOTH open and
 *   already-completed-and-archived tasks (`lib/db.ts`'s `getBoard`), and
 *   this component never has the archived half locally. It's derived as a
 *   delta instead: how many `day = today` rows did this move add or remove
 *   from what we can see? That delta is exact even though the absolute
 *   count isn't derivable, because completion status — the only thing this
 *   view is blind to — never changes as part of a move.
 * - `today.completed` can't be derived locally at all (it counts
 *   already-archived rows this view never holds) and a move can't change
 *   it, so it's carried over unchanged and left for the refetch.
 */
function applyOptimisticBoard(board: BoardData, move: MoveTaskInput, now: number): BoardData {
  const prevTasks: DragBoardTasks = { backlog: board.backlog.tasks, today: board.today.tasks };
  const nextTasks = applyMoveToBoard(prevTasks, move, board.today.day);

  const plannedDelta =
    countTodayRows(nextTasks, board.today.day) - countTodayRows(prevTasks, board.today.day);

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
    today: {
      ...board.today,
      planned: Math.max(0, board.today.planned + plannedDelta),
      tasks: nextTasks.today,
    },
  };
}

/** Replaces the tag list on the task matching `taskId` (top-level or a
 * subtask, in either bucket) with `tags`, leaving everything else in the
 * board untouched. Used to apply a `setTaskTags` toggle optimistically —
 * before the RPC round trip — so the chip appears on the row immediately. */
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
    today: { ...board.today, tasks: mapTasks(board.today.tasks) },
  };
}

/** Every top-level task plus its subtasks, flattened, for tick-interval scanning. */
function flattenTasks(board: BoardData): TaskDto[] {
  const all: TaskDto[] = [];
  for (const t of board.backlog.tasks) {
    all.push(t, ...t.subtasks);
  }
  for (const t of board.today.tasks) {
    all.push(t, ...t.subtasks);
  }
  return all;
}

/** The dnd-kit wiring only turns component state into plain `lib/drag`
 * inputs; the actual before/after/nest/bucket decision lives there so it
 * can be unit-tested without a DOM or a real drag gesture (see
 * `lib/drag.test.ts`). */
type DragData =
  | { kind: "list"; listId: string }
  | { kind: "task"; taskId: string; parentId: string | null; bucket: "backlog" | "today" }
  | { kind: "project"; projectId: string };

type OverData = DragData | { kind: "section"; bucket: "backlog" | "today" };

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

  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as DragData | undefined;
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

    const activeData = active.data.current as DragData | undefined;
    if (!activeData) return;

    if (activeData.kind === "list") {
      const overData = over.data.current as DragData | undefined;
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

    const overData = over.data.current as OverData | undefined;
    if (!overData) return;

    const activeRef: DragTaskRef = {
      taskId: activeData.taskId,
      parentId: activeData.parentId,
      bucket: activeData.bucket,
    };
    const target: DropTarget =
      overData.kind === "section"
        ? { kind: "section", bucket: overData.bucket }
        : { kind: "task", taskId: String(over.id) };

    const move = computeTaskMove(
      activeRef,
      target,
      { backlog: board.backlog.tasks, today: board.today.tasks },
      active.rect.current.translated ?? active.rect.current.initial,
      over.rect,
    );
    if (!move) return;

    // Apply the move to local state immediately, before the RPC resolves,
    // so the row is already in its destination by the time dnd-kit's drop
    // animation would otherwise play the `DragOverlay` back to its old spot
    // (the "goes to the right bucket but the animation flies back" bug).
    // `dropAnimation={null}` below removes that animation outright; this is
    // the other half — making sure there's nothing wrong-looking underneath
    // it regardless.
    const preDropBoard = board;
    setOptimisticBoard(applyOptimisticBoard(board, move, now));

    void rpc
      .call("moveTask", move)
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

  /** Fired by a ghost row's "· today" marker: unschedule it back to its
   * project/loose home. Drag matrix "Today row -> Backlog (anywhere)":
   * parent/project unchanged, beforeId/afterId both omitted so `moveTask`
   * snaps it home to its untouched slot rather than repositioning it. */
  const unscheduleTask = (id: string) => {
    const task = findTaskInBoard({ backlog: board.backlog.tasks, today: board.today.tasks }, id);
    if (!task) return;
    const move: MoveTaskInput = {
      id,
      bucket: "backlog",
      parentId: task.parentId,
      beforeId: null,
      afterId: null,
    };
    const preDropBoard = board;
    setOptimisticBoard(applyOptimisticBoard(board, move, now));
    void rpc
      .call("moveTask", move)
      .then(() => refetch())
      .catch((err) => {
        setOptimisticBoard(preDropBoard);
        toast.error(err instanceof Error ? err.message : "Couldn't unschedule task.");
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
  const projectTasks = (projectId: string) =>
    board.backlog.tasks.filter((t) => t.projectId === projectId);

  const activeTask =
    activeDrag?.kind === "task"
      ? findTaskInBoard({ backlog: board.backlog.tasks, today: board.today.tasks }, activeDrag.taskId)
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
    <div className="flex h-full min-w-0 flex-col gap-3 overflow-y-auto p-2">
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

        {/* Backlog and Today are two distinct zones (items get dragged
            between them), so this gap is deliberately much larger than the
            tab strip's — whitespace only, no divider. */}
        <div className="flex flex-col gap-8">
          <Section
            bucket="backlog"
            heading="BACKLOG"
            count={board.backlog.total}
            ringValue={board.backlog.overdue}
            ringTotal={board.backlog.total}
            ringTone="destructive"
            ringLabel={`${board.backlog.overdue} overdue`}
            tasks={looseBacklogTasks}
            actions={actions}
            addPlaceholder="add to backlog · #Name for a new project"
            projects={board.projects}
            projectTasks={projectTasks}
            onToggleProjectCollapsed={toggleProjectCollapsed}
            onRenameProject={renameProject}
            onChangeProjectColor={changeProjectColor}
            onDeleteProject={deleteProject}
            onAddTaskToProject={addTaskToProject}
            onCreateProject={createProjectInline}
            onUnscheduleTask={unscheduleTask}
            onNavigateToProject={navigateToProject}
            onNavigateToParent={navigateToParent}
          />

          <Section
            bucket="today"
            heading={`TODAY · ${formatDayHeading(board.today.day)}`}
            ringValue={board.today.completed}
            ringTotal={board.today.planned}
            ringTone="primary"
            ringLabel={`${board.today.completed}/${board.today.planned} done`}
            tasks={board.today.tasks}
            actions={actions}
            addPlaceholder="add to today"
            showTrail
            onNavigateToProject={navigateToProject}
            onNavigateToParent={navigateToParent}
          />
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
