// Pure drag→moveTask mapping for the board's single DndContext (backlog↔today,
// reorder, nest-as-subtask, promote-a-subtask, project filing, project
// reordering). No React, no dnd-kit runtime import — only plain data in,
// plain data out, so every one of the drag matrix's behaviours (and their
// edges) can be asserted directly without a DOM or a real drag gesture.
//
// Phase 4 note (docs/design/2026-08-27-projects.md, "Drag matrix"): Today
// stopped being a place and became a flag. `computeTaskMove` never nulls
// `parentId` on a move into Today — that was the bug the whole feature was
// named after (design doc's Problem section, corrected 2026-08-27). See the
// "CENTRAL FIX" tests in drag.test.ts.
import type { TaskDto } from "@/contract";

export type Bucket = "backlog" | "today";

/** The task actually being dragged. */
export interface DragTaskRef {
  taskId: string;
  parentId: string | null;
  bucket: Bucket;
}

/**
 * What the pointer/keyboard-focus landed on. `null` = dropped on nothing.
 * `"project"` is a drop directly on a project's header or body — the one
 * gesture in the matrix that explicitly re-homes a task into a *different*
 * project (as opposed to landing "anywhere" in the Backlog, which snaps
 * home instead — see the "section"/"backlog" branch of `computeTaskMove`).
 */
export type DropTarget =
  | { kind: "section"; bucket: Bucket }
  | { kind: "task"; taskId: string }
  | { kind: "project"; projectId: string }
  | null;

/**
 * Top-level tasks (each with nested `subtasks`) for both sections.
 *
 * Since Phase 3, `backlog` is a *home* view: every open task, whether or not
 * it is currently flagged into Today, arranged by project/parent — a task
 * scheduled into Today still sits here, ghosted (same `bucket`/`day` as its
 * Today copy, so callers can style it), at its untouched home position.
 * `today` is a *schedule* view: the flat list of currently-scheduled tasks,
 * `subtasks` always `[]` (deviation #1 — Today is genuinely flat, a subtask
 * scheduled alone appears here as its own row, not nested under its
 * parent). A scheduled task's id therefore legitimately appears in both
 * arrays at once; that's the ghost.
 */
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
  /** Target home. Omitted = unchanged (snap-home / no re-file) — mirrors
   * `moveTask`'s input contract exactly. */
  projectId?: string | null;
}

export type DropZone = "before" | "after" | "nest";

function flattenBoardTasks(tasks: DragBoardTasks): TaskDto[] {
  const all: TaskDto[] = [];
  for (const t of tasks.backlog) all.push(t, ...t.subtasks);
  for (const t of tasks.today) all.push(t, ...t.subtasks);
  return all;
}

/**
 * Finds a task anywhere on the board. Ghosts mean the same id can appear in
 * both `backlog` (home, with real `.subtasks`) and `today` (flat,
 * `.subtasks: []`); `backlog` is searched first, which is exactly the copy
 * we want — it's the one carrying the real subtree.
 */
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

  if (target.kind === "project") {
    // Drag matrix: "project task -> another project", "loose task ->
    // project body", "Today row -> a different project's header" — all
    // three converge on the same shape: top-level, explicit projectId,
    // appended at the end of that project's home group. This is the ONE
    // gesture that re-homes a task out of Today instead of snapping it
    // home (see the plain "backlog" section branch below).
    const homeSiblings = topLevelList(tasks, "backlog")
      .filter((t) => (t.projectId ?? null) === target.projectId && t.id !== active.taskId)
      .map((t) => t.id);
    return {
      id: active.taskId,
      bucket: "backlog",
      parentId: null,
      projectId: target.projectId,
      beforeId: null,
      afterId: homeSiblings.length > 0 ? homeSiblings[homeSiblings.length - 1] : null,
    };
  }

  if (target.kind === "section") {
    if (target.bucket === "today") {
      // CENTRAL FIX (design doc's Problem section correction: the bug was
      // `parentId: null` here, not lib/db.ts). Scheduling into Today is a
      // flag, not a relocation: a subtask keeps its parent (drag matrix row
      // "subtask -> Today: flag scheduled; parent_id KEPT"), a project task
      // stays parentless (row "project task -> Today: flag scheduled;
      // ghost stays"). `projectId` is omitted entirely (moveTask's
      // "omit = unchanged"), which is what keeps the ghost in its project
      // with sort_order untouched.
      const ids = topLevelList(tasks, "today")
        .map((t) => t.id)
        .filter((id) => id !== active.taskId);
      return {
        id: active.taskId,
        bucket: "today",
        parentId: active.parentId,
        beforeId: null,
        afterId: ids.length > 0 ? ids[ids.length - 1] : null,
      };
    }

    // target.bucket === "backlog"
    if (active.bucket === "today") {
      // Drag matrix: "Today row -> Backlog (anywhere): unschedule; snaps
      // home to its own project slot". Position is deliberately not
      // computed: `moveTask`'s snapHome branch leaves sort_order untouched
      // regardless of beforeId/afterId, and `projectId` is omitted so this
      // can never accidentally re-home the task — only a drop directly on
      // a *different* project's header/body does that (target.kind ===
      // "project", above).
      return {
        id: active.taskId,
        bucket: "backlog",
        parentId: active.parentId,
        beforeId: null,
        afterId: null,
      };
    }

    // Drag matrix: "project task -> loose area: project_id = NULL".
    const ids = topLevelList(tasks, "backlog")
      .filter((t) => (t.projectId ?? null) === null)
      .map((t) => t.id)
      .filter((id) => id !== active.taskId);
    return {
      id: active.taskId,
      bucket: "backlog",
      parentId: null,
      projectId: null,
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

  if (overTask.bucket === "today") {
    // Landing before/after an existing Today row — whether the dragged
    // task is already scheduled (row "Today row -> Today: reorder") or is
    // entering Today from the Backlog by dropping near a row instead of on
    // the section body (same central fix as above: parentId kept, project
    // omitted). Today is genuinely flat (deviation #1), so the sibling
    // group is always the flat Today list, never `overTask`'s own
    // parent/subtasks.
    const ids = topLevelList(tasks, "today")
      .map((t) => t.id)
      .filter((id) => id !== active.taskId);
    const idx = ids.indexOf(overTask.id);
    if (zone === "before") {
      return {
        id: active.taskId,
        bucket: "today",
        parentId: active.parentId,
        beforeId: overTask.id,
        afterId: idx > 0 ? ids[idx - 1] : null,
      };
    }
    return {
      id: active.taskId,
      bucket: "today",
      parentId: active.parentId,
      beforeId: idx < ids.length - 1 ? ids[idx + 1] : null,
      afterId: overTask.id,
    };
  }

  // overTask.bucket === "backlog"
  if (active.bucket === "today") {
    // Same snap-home rule as the section/backlog branch: landing on a
    // specific backlog row is still "Backlog (anywhere)", not a positional
    // re-home. Only target.kind === "project" re-homes a Today row.
    return {
      id: active.taskId,
      bucket: "backlog",
      parentId: active.parentId,
      beforeId: null,
      afterId: null,
    };
  }

  const groupIds =
    overTask.parentId === null
      ? topLevelList(tasks, "backlog")
          .filter((t) => (t.projectId ?? null) === (overTask.projectId ?? null))
          .map((t) => t.id)
      : (findTaskInBoard(tasks, overTask.parentId)?.subtasks.map((s) => s.id) ?? [overTask.id]);
  const filtered = groupIds.filter((id) => id !== active.taskId);
  const idx = filtered.indexOf(overTask.id);
  // Only set on a top-level placement — drag matrix "project task ->
  // another project: re-home (writes sort_order only)". Omitted when
  // nesting under (or reordering among) a parent's subtasks, since the
  // server always mirrors a subtask's projectId from its parent.
  const destProjectId = overTask.parentId === null ? (overTask.projectId ?? null) : undefined;

  if (zone === "before") {
    return {
      id: active.taskId,
      bucket: "backlog",
      parentId: overTask.parentId,
      projectId: destProjectId,
      beforeId: overTask.id,
      afterId: idx > 0 ? filtered[idx - 1] : null,
    };
  }
  return {
    id: active.taskId,
    bucket: "backlog",
    parentId: overTask.parentId,
    projectId: destProjectId,
    beforeId: idx < filtered.length - 1 ? filtered[idx + 1] : null,
    afterId: overTask.id,
  };
}

/**
 * Drag matrix: "project header -> project header: reorder projects". A
 * project drag never touches tasks, so it's a plain id-array reorder for
 * the `reorderProjects` RPC — mirroring dnd-kit's `arrayMove` without a
 * dnd-kit import (this module's no-runtime-import rule).
 */
export function computeProjectReorder(
  activeProjectId: string,
  overProjectId: string,
  projectIds: string[],
): string[] | null {
  if (activeProjectId === overProjectId) return null;
  const oldIndex = projectIds.indexOf(activeProjectId);
  const newIndex = projectIds.indexOf(overProjectId);
  if (oldIndex === -1 || newIndex === -1) return null;
  const next = [...projectIds];
  next.splice(oldIndex, 1);
  next.splice(newIndex, 0, activeProjectId);
  return next;
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
// the fly-back-then-refetch UX bug). It only needs to get SECTION, PARENT,
// PROJECT and the ghost's presence right — `sortOrder` is not reproduced
// faithfully, since only the server (via `lib/db.ts`'s `moveTask`) knows the
// real gap-filling math; the follow-up `getBoard` refetch is authoritative
// and will settle the exact order.

function insertBySiblingIds(
  list: TaskDto[],
  item: TaskDto,
  beforeId: string | null,
  afterId: string | null,
): TaskDto[] {
  const without = list.filter((t) => t.id !== item.id);
  if (beforeId !== null) {
    const idx = without.findIndex((t) => t.id === beforeId);
    if (idx !== -1) return [...without.slice(0, idx), item, ...without.slice(idx)];
  }
  if (afterId !== null) {
    const idx = without.findIndex((t) => t.id === afterId);
    if (idx !== -1) return [...without.slice(0, idx + 1), item, ...without.slice(idx + 1)];
  }
  return [...without, item];
}

/** Best-effort guess at "today"'s local day string from whatever is
 * currently sitting in the Today section, for a task newly promoted into
 * Today with nothing else to copy it from. Only cosmetic — the refetch
 * corrects it — so a `null` fallback (an empty Today section) is fine. */
function inferTodayDay(tasks: DragBoardTasks): string | null {
  for (const t of tasks.today) {
    if (t.day !== null) return t.day;
  }
  return null;
}

/** A task's home location within the `backlog` tree: itself, plus the id of
 * the parent it's nested under (`null` = top-level). This is always the
 * source of truth for a task's parent/project — `today` is just a flat,
 * derived schedule view. */
interface HomeLocation {
  task: TaskDto;
  parentId: string | null;
}

function findHome(tasks: DragBoardTasks, id: string): HomeLocation | null {
  for (const t of tasks.backlog) {
    if (t.id === id) return { task: t, parentId: null };
    const sub = t.subtasks.find((s) => s.id === id);
    if (sub) return { task: sub, parentId: t.id };
  }
  return null;
}

function removeFromHome(tasks: DragBoardTasks, id: string, parentId: string | null): DragBoardTasks {
  if (parentId === null) {
    return { ...tasks, backlog: tasks.backlog.filter((t) => t.id !== id) };
  }
  return {
    ...tasks,
    backlog: tasks.backlog.map((t) => {
      if (t.id !== parentId) return t;
      return {
        ...t,
        subtasks: t.subtasks.filter((s) => s.id !== id),
        subtaskCounts: { ...t.subtaskCounts, total: Math.max(0, t.subtaskCounts.total - 1) },
      };
    }),
  };
}

function insertIntoHome(
  tasks: DragBoardTasks,
  item: TaskDto,
  parentId: string | null,
  beforeId: string | null,
  afterId: string | null,
): DragBoardTasks {
  if (parentId === null) {
    return { ...tasks, backlog: insertBySiblingIds(tasks.backlog, item, beforeId, afterId) };
  }
  let inserted = false;
  const backlog = tasks.backlog.map((t) => {
    if (t.id !== parentId) return t;
    inserted = true;
    return {
      ...t,
      subtasks: insertBySiblingIds(t.subtasks, item, beforeId, afterId),
      subtaskCounts: { ...t.subtaskCounts, total: t.subtaskCounts.total + 1 },
    };
  });
  // Destination parent isn't on this board snapshot — fall back to a
  // top-level append so the row isn't silently dropped; the refetch will
  // correct the nesting.
  return { ...tasks, backlog: inserted ? backlog : [...tasks.backlog, item] };
}

function patchHome(
  tasks: DragBoardTasks,
  id: string,
  parentId: string | null,
  patch: Partial<TaskDto>,
): DragBoardTasks {
  if (parentId === null) {
    return { ...tasks, backlog: tasks.backlog.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
  }
  return {
    ...tasks,
    backlog: tasks.backlog.map((t) => {
      if (t.id !== parentId) return t;
      return { ...t, subtasks: t.subtasks.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
    }),
  };
}

function removeFromToday(tasks: DragBoardTasks, id: string): DragBoardTasks {
  return { ...tasks, today: tasks.today.filter((t) => t.id !== id) };
}

/**
 * Applies one `moveTask` input to the board's task tree, entirely locally —
 * no RPC, no server round trip. Returns new arrays; `tasks` (and every
 * `TaskDto` untouched by the move) is left exactly as it was. `move: null`
 * is a no-op and returns `tasks` unchanged. A task id not present in the
 * `backlog` home tree (never on the board, or already moved away by a
 * faster-resolving mutation) is also a no-op — the refetch will reconcile.
 *
 * Mirrors `lib/db.ts`'s `moveTask`:
 * - Entering Today never touches the home tree (bucket/day are patched in
 *   place; sort_order/parent/project are untouched) — that's what makes the
 *   ghost stay put with sort_order untouched.
 * - Leaving Today for the Backlog "anywhere" (parent/project unchanged) is
 *   the same in-place patch, run in reverse — the snap-home rule.
 * - A real re-home/re-parent (parent or project actually changing) relocates
 *   the entry within the home tree and, per SPEC.md rule 2, promotes a
 *   newly-nested task's own subtasks to top-level siblings (subtasks are
 *   exactly one level deep).
 * - Per invariant 4, scheduling a parent never drags its subtasks into
 *   Today; a project/parent change, however, still mirrors onto any
 *   remaining real subtasks (invariant 2: a subtask's project always
 *   mirrors its parent's).
 */
export function applyMoveToBoard(
  tasks: DragBoardTasks,
  move: MoveTaskInput | null,
  today?: string | null,
): DragBoardTasks {
  if (!move) return tasks;

  // The home tree (`backlog`) is the source of truth when the task has an
  // entry there. Some fixtures (and, historically, boards mid-refetch) hold
  // a task only in the flat `today` array with no home ghost yet — that's
  // still a valid task to reorder within Today, just one with no home
  // entry to relocate. Absent from both is a genuine no-op.
  const home = findHome(tasks, move.id);
  const existingTodayEntry = tasks.today.find((t) => t.id === move.id) ?? null;
  if (!home && !existingTodayEntry) return tasks;

  const moving = home ? home.task : (existingTodayEntry as TaskDto);
  const currentParentId = home ? home.parentId : null;
  const currentProjectId = moving.projectId ?? null;

  const newParentId = move.parentId;
  const newProjectId =
    newParentId !== null
      ? (findHome(tasks, newParentId)?.task.projectId ?? null) // invariant 2: mirror the new parent
      : move.projectId !== undefined
        ? move.projectId
        : currentProjectId;

  const destBucket = move.bucket;
  const enteringToday = destBucket === "today";

  const homeChanged = newParentId !== currentParentId || newProjectId !== currentProjectId;
  // Only a real backlog reposition/re-home relocates the home entry — and
  // only when there IS a home entry to relocate. Entering Today, or
  // leaving it via snap-home (parent/project unchanged, beforeId/afterId
  // both null by construction — see computeTaskMove), leaves the home
  // tree's structure alone; only bucket/day are patched.
  const shouldRelocateHome =
    home !== null &&
    destBucket === "backlog" &&
    (homeChanged || move.beforeId !== null || move.afterId !== null);

  // A task with parent_id set can never itself have subtasks (depth cap),
  // so `moving.subtasks` is only non-empty when `moving` is a top-level
  // task — `nestingNow` only ever has real children to promote in that
  // case, matching lib/db.ts's `moveTask`.
  const nestingNow = newParentId !== null;
  const promoted: TaskDto[] = nestingNow ? moving.subtasks.map((s) => ({ ...s, parentId: null })) : [];
  // A relocating parent's still-remaining real subtasks mirror its new
  // project (invariant 2); their own bucket/day are untouched (invariant 4).
  const carriedSubtasks: TaskDto[] = nestingNow
    ? []
    : moving.subtasks.map((s) => ({ ...s, projectId: newProjectId }));

  let working: DragBoardTasks = tasks;

  if (shouldRelocateHome) {
    working = removeFromHome(working, move.id, currentParentId);
    const movedHomeTask: TaskDto = {
      ...moving,
      parentId: newParentId,
      projectId: newProjectId,
      bucket: "backlog",
      day: null,
      subtasks: nestingNow ? [] : carriedSubtasks,
      subtaskCounts: nestingNow ? { total: 0, done: 0 } : moving.subtaskCounts,
    };
    working = insertIntoHome(working, movedHomeTask, newParentId, move.beforeId, move.afterId);
    if (promoted.length > 0) {
      // Splice the promoted ex-children in as top-level siblings; their own
      // bucket/day/project are left exactly as they were (lib/db.ts leaves
      // their sort_order alone too, beyond the gap-filling this
      // approximates away — the refetch settles the exact order).
      working = { ...working, backlog: [...working.backlog, ...promoted] };
    }
  } else if (home !== null) {
    const destDay = enteringToday ? (today ?? inferTodayDay(tasks) ?? moving.day) : null;
    working = patchHome(working, move.id, currentParentId, { bucket: destBucket, day: destDay });
  }

  // --- Flat Today view -------------------------------------------------
  if (enteringToday) {
    const homeNow = home !== null ? (findHome(working, move.id)?.task ?? moving) : moving;
    const destDay = today ?? inferTodayDay(tasks) ?? homeNow.day;
    const flatEntry: TaskDto = {
      ...homeNow,
      parentId: newParentId,
      projectId: newProjectId,
      bucket: "today",
      day: home !== null ? homeNow.day : destDay,
      subtasks: [],
    };
    working = { ...working, today: insertBySiblingIds(working.today, flatEntry, move.beforeId, move.afterId) };
  } else {
    working = removeFromToday(working, move.id);
  }

  return working;
}
