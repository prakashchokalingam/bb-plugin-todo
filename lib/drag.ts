// Pure drag→moveTask mapping for the board's single DndContext (backlog↔today,
// reorder, nest-as-subtask, promote-a-subtask). No React, no dnd-kit runtime
// import — only plain data in, plain data out, so every one of the four drag
// behaviours (and their edges) can be asserted directly without a DOM or a
// real drag gesture.
import type { TaskDto } from "@/contract";

export type Bucket = "backlog" | "today";

/** The task actually being dragged. */
export interface DragTaskRef {
  taskId: string;
  parentId: string | null;
  bucket: Bucket;
}

/** What the pointer/keyboard-focus landed on. `null` = dropped on nothing. */
export type DropTarget =
  | { kind: "section"; bucket: Bucket }
  | { kind: "task"; taskId: string }
  | null;

/** Top-level tasks (each with nested `subtasks`) for both sections. */
export interface DragBoardTasks {
  backlog: TaskDto[];
  today: TaskDto[];
}

/** Just enough of a DOMRect for the before/after/nest zone heuristic. */
export interface DragRect {
  top: number;
  height: number;
}

export interface MoveTaskInput {
  id: string;
  bucket: Bucket;
  parentId: string | null;
  beforeId: string | null;
  afterId: string | null;
}

export type DropZone = "before" | "after" | "nest";

function flattenBoardTasks(tasks: DragBoardTasks): TaskDto[] {
  const all: TaskDto[] = [];
  for (const t of tasks.backlog) all.push(t, ...t.subtasks);
  for (const t of tasks.today) all.push(t, ...t.subtasks);
  return all;
}

export function findTaskInBoard(tasks: DragBoardTasks, id: string): TaskDto | null {
  for (const t of flattenBoardTasks(tasks)) {
    if (t.id === id) return t;
  }
  return null;
}

function topLevelList(tasks: DragBoardTasks, bucket: Bucket): TaskDto[] {
  return bucket === "backlog" ? tasks.backlog : tasks.today;
}

/**
 * Which of the three zones the drag currently sits in, relative to a
 * top-level or subtask target row. `canNest` is false for a subtask target
 * (subtasks are exactly one level deep — SPEC.md rule 2 — so they can never
 * be a nest target). Falls back to "before" when either rect is unavailable
 * (e.g. jsdom, which reports every rect as zeros).
 */
export function resolveDropZone(
  canNest: boolean,
  activeRect: DragRect | null | undefined,
  overRect: DragRect | null | undefined,
): DropZone {
  if (!activeRect || !overRect) return "before";
  const overCenter = overRect.top + overRect.height / 2;
  const activeCenter = activeRect.top + activeRect.height / 2;
  const band = overRect.height * 0.25;
  if (canNest && Math.abs(activeCenter - overCenter) < band) return "nest";
  return activeCenter <= overCenter ? "before" : "after";
}

/**
 * Maps one drag gesture to exactly one `moveTask` input, or `null` when the
 * drop is a no-op (dropped on nothing, on itself, or on an id no longer on
 * the board). The dragged id is always filtered out of whichever sibling
 * group is used to compute `beforeId`/`afterId`, so it can never appear as
 * its own neighbour.
 */
export function computeTaskMove(
  active: DragTaskRef,
  target: DropTarget,
  tasks: DragBoardTasks,
  activeRect?: DragRect | null,
  overRect?: DragRect | null,
): MoveTaskInput | null {
  if (target === null) return null;

  if (target.kind === "section") {
    const ids = topLevelList(tasks, target.bucket)
      .map((t) => t.id)
      .filter((id) => id !== active.taskId);
    return {
      id: active.taskId,
      bucket: target.bucket,
      parentId: null,
      beforeId: null,
      afterId: ids.length > 0 ? ids[ids.length - 1] : null,
    };
  }

  // target.kind === "task"
  if (target.taskId === active.taskId) return null;
  const overTask = findTaskInBoard(tasks, target.taskId);
  if (!overTask) return null;

  // A subtask cannot itself gain children, so it is never a nest target.
  const canNest = overTask.parentId === null;
  const zone = resolveDropZone(canNest, activeRect, overRect);

  if (zone === "nest") {
    const siblingIds = overTask.subtasks
      .map((s) => s.id)
      .filter((id) => id !== active.taskId);
    return {
      id: active.taskId,
      bucket: overTask.bucket,
      parentId: overTask.id,
      beforeId: null,
      afterId: siblingIds.length > 0 ? siblingIds[siblingIds.length - 1] : null,
    };
  }

  const groupIds =
    overTask.parentId === null
      ? topLevelList(tasks, overTask.bucket).map((t) => t.id)
      : (findTaskInBoard(tasks, overTask.parentId)?.subtasks.map((s) => s.id) ?? [overTask.id]);
  const filtered = groupIds.filter((id) => id !== active.taskId);
  const idx = filtered.indexOf(overTask.id);

  if (zone === "before") {
    return {
      id: active.taskId,
      bucket: overTask.bucket,
      parentId: overTask.parentId,
      beforeId: overTask.id,
      afterId: idx > 0 ? filtered[idx - 1] : null,
    };
  }
  return {
    id: active.taskId,
    bucket: overTask.bucket,
    parentId: overTask.parentId,
    beforeId: idx < filtered.length - 1 ? filtered[idx + 1] : null,
    afterId: overTask.id,
  };
}

// ---------------------------------------------------------------------------
// Optimistic local projection (`applyMoveToBoard`)
// ---------------------------------------------------------------------------
//
// `computeTaskMove` decides *what* to ask the server for; this section
// decides how to reflect that decision in the board immediately, before the
// `moveTask` RPC resolves, so the row is already sitting in its destination
// by the time dnd-kit's drop animation would otherwise play (see
// `components/TodoPage.tsx`'s `handleDragEnd` for why that ordering matters:
// the fly-back-then-refetch UX bug). It only needs to get SECTION and PARENT
// exactly right — `sortOrder` is not reproduced faithfully, since only the
// server (via `lib/db.ts`'s `moveTask`) knows the real gap-filling math; the
// follow-up `getBoard` refetch is authoritative and will settle the exact
// order.

function insertBySiblingIds(
  list: TaskDto[],
  item: TaskDto,
  beforeId: string | null,
  afterId: string | null,
): TaskDto[] {
  if (beforeId !== null) {
    const idx = list.findIndex((t) => t.id === beforeId);
    if (idx !== -1) return [...list.slice(0, idx), item, ...list.slice(idx)];
  }
  if (afterId !== null) {
    const idx = list.findIndex((t) => t.id === afterId);
    if (idx !== -1) return [...list.slice(0, idx + 1), item, ...list.slice(idx + 1)];
  }
  return [...list, item];
}

/** Best-effort guess at "today"'s local day string from whatever is
 * currently sitting in the Today section, for a task newly promoted into
 * Today with nothing else to copy it from. Only cosmetic — the refetch
 * corrects it — so a `null` fallback (an empty Today section) is fine. */
function inferTodayDay(tasks: DragBoardTasks): string | null {
  for (const t of tasks.today) {
    if (t.day !== null) return t.day;
    for (const s of t.subtasks) {
      if (s.day !== null) return s.day;
    }
  }
  return null;
}

/**
 * Applies one `moveTask` input to the board's task tree, entirely locally —
 * no RPC, no server round trip. Returns new arrays; `tasks` (and every
 * `TaskDto` untouched by the move) is left exactly as it was. `move: null`
 * is a no-op and returns `tasks` unchanged.
 *
 * Mirrors `lib/db.ts`'s `moveTask` for the part that's visible immediately:
 * bucket, parent, and — per SPEC.md product rule 2 — promoting a nested
 * task's own subtasks to top-level siblings (placed right after the task
 * that's being nested) when it is dropped onto another top-level task.
 */
export function applyMoveToBoard(
  tasks: DragBoardTasks,
  move: MoveTaskInput | null,
  today?: string | null,
): DragBoardTasks {
  if (!move) return tasks;

  // Locate the task being moved and where it currently lives.
  let moving: TaskDto | null = null;
  let sourceBucket: Bucket | null = null;
  let sourceParentId: string | null = null;
  outer: for (const bucket of ["backlog", "today"] as const) {
    for (const t of tasks[bucket]) {
      if (t.id === move.id) {
        moving = t;
        sourceBucket = bucket;
        sourceParentId = null;
        break outer;
      }
      const sub = t.subtasks.find((s) => s.id === move.id);
      if (sub) {
        moving = sub;
        sourceBucket = bucket;
        sourceParentId = t.id;
        break outer;
      }
    }
  }
  // The dragged task isn't on the board we were handed (already moved away
  // by a faster-resolving mutation, or a stale snapshot) — nothing to
  // project locally; the refetch will reconcile.
  if (!moving || sourceBucket === null) return tasks;

  // --- Phase 1: remove `moving` from its current spot. ---------------------
  let working: DragBoardTasks = tasks;
  if (sourceParentId === null) {
    working = {
      ...working,
      [sourceBucket]: working[sourceBucket].filter((t) => t.id !== move.id),
    };
  } else {
    working = {
      ...working,
      [sourceBucket]: working[sourceBucket].map((t) => {
        if (t.id !== sourceParentId) return t;
        return {
          ...t,
          subtasks: t.subtasks.filter((s) => s.id !== move.id),
          subtaskCounts: { ...t.subtaskCounts, total: Math.max(0, t.subtaskCounts.total - 1) },
        };
      }),
    };
  }

  const destBucket = move.bucket;
  const nestingNow = move.parentId !== null;

  // --- Phase 2: figure out the destination `day`. ---------------------------
  let destDay: string | null;
  if (nestingNow) {
    const parent = working[destBucket].find((t) => t.id === move.parentId);
    destDay = parent ? parent.day : moving.day;
  } else if (destBucket === "today") {
    destDay = today ?? inferTodayDay(working) ?? moving.day;
  } else {
    destDay = null;
  }

  // Nesting a task promotes its own subtasks to top-level, per SPEC.md rule
  // 2 / `lib/db.ts`'s `moveTask`; otherwise a parent carries its subtasks
  // with it, mirroring the parent's new bucket/day.
  const promoted: TaskDto[] = nestingNow
    ? moving.subtasks.map((s) => ({ ...s, parentId: null, bucket: destBucket, day: destDay }))
    : [];
  const carriedSubtasks: TaskDto[] = nestingNow
    ? []
    : moving.subtasks.map((s) => ({ ...s, bucket: destBucket, day: destDay }));

  const movedTask: TaskDto = {
    ...moving,
    bucket: destBucket,
    parentId: nestingNow ? move.parentId : null,
    day: destDay,
    subtasks: carriedSubtasks,
    subtaskCounts: nestingNow ? { total: 0, done: 0 } : moving.subtaskCounts,
  };

  // --- Phase 3: insert `movedTask` (and any promoted ex-children) at the
  // destination. -------------------------------------------------------------
  if (nestingNow) {
    const destParentId = move.parentId as string;
    let inserted = false;
    working = {
      ...working,
      [destBucket]: working[destBucket].map((t) => {
        if (t.id !== destParentId) return t;
        inserted = true;
        return {
          ...t,
          subtasks: insertBySiblingIds(t.subtasks, movedTask, move.beforeId, move.afterId),
          subtaskCounts: { ...t.subtaskCounts, total: t.subtaskCounts.total + 1 },
        };
      }),
    };
    if (!inserted) {
      // Destination parent isn't on this board snapshot — fall back to a
      // top-level append so the row isn't silently dropped; the refetch
      // will correct the nesting.
      working = { ...working, [destBucket]: [...working[destBucket], movedTask] };
    } else if (promoted.length > 0) {
      // Splice the promoted ex-children in as top-level siblings
      // immediately after the parent they were nested under (an
      // approximation of the server's "immediately after the moved task"
      // ordering — exact `sortOrder` is left to the refetch).
      const list = working[destBucket];
      const parentIdx = list.findIndex((t) => t.id === destParentId);
      working = {
        ...working,
        [destBucket]:
          parentIdx === -1
            ? [...list, ...promoted]
            : [...list.slice(0, parentIdx + 1), ...promoted, ...list.slice(parentIdx + 1)],
      };
    }
  } else {
    working = {
      ...working,
      [destBucket]: insertBySiblingIds(working[destBucket], movedTask, move.beforeId, move.afterId),
    };
  }

  return working;
}
