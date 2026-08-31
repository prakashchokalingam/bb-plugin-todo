// Pure drag→moveTask mapping for the board's single DndContext (backlog↔today,
// reorder, nest-as-subtask, promote-a-subtask, project filing, project
// reordering, dismissing an auto-included task). No React, no dnd-kit
// runtime import — only plain data in, plain data out, so every one of the
// drag matrix's behaviours (and their edges) can be asserted directly
// without a DOM or a real drag gesture.
//
// Phase 3 model (the-todo-plugin-feels-stateful-valley.md, "Drag matrix"):
// Backlog is the one comprehensive task tree (`DragBoardTasks.backlog`);
// Today is a filtered, column-scoped VIEW over the exact same rows, not a
// second list. A task can render — and be dragged from, or dropped onto —
// EITHER column at once (every `inToday` row does, always, since Backlog
// never hides anything). `computeTaskMove` never nulls `parentId` on a move
// into Today — that was the bug the whole feature was originally named
// after (see the "CENTRAL FIX" tests in drag.test.ts) — and that invariant
// is still the most important thing in this file. What changed in Phase 3
// is *how* "which column" is known: since the same task id can be the drop
// target from either column's rendered instance, "which column" can no
// longer be read off the task's own `bucket` field (an auto-included task's
// `bucket` stays `'backlog'` even while it renders, and is draggable,
// inside the Today column). Both the dragged row (`DragTaskRef.column`) and
// the drop target (`DropTarget`'s `column`) now carry that fact explicitly,
// supplied by the caller from whichever column's DOM instance was actually
// touched.
import type { TaskDto } from "@/contract";

export type Bucket = "backlog" | "today";

/**
 * The task actually being dragged.
 *
 * `bucket` is the task's real, server-stored bucket (`'backlog' | 'today'`)
 * — the thing `moveTask` reads and writes. `inToday` mirrors `TaskDto`'s
 * field: whether the row currently satisfies Today membership at all
 * (manually scheduled OR auto-included by due date). `column` is neither of
 * those: it's which column's rendered row the pointer/keyboard grabbed —
 * necessary because an auto-included task (`bucket: "backlog"`, `inToday:
 * true`) renders in both columns simultaneously, and dragging its *Today*
 * instance out means something different (dismiss) from dragging its
 * *Backlog* instance to reorder it (ordinary reorder, not a dismissal).
 */
export interface DragTaskRef {
  taskId: string;
  parentId: string | null;
  bucket: Bucket;
  inToday: boolean;
  column: Bucket;
}

/**
 * What the pointer/keyboard-focus landed on. `null` = dropped on nothing.
 * Every non-null variant carries `column` — which column's rendered drop
 * zone received the drop — for the same reason `DragTaskRef.column` does:
 * a project group (and every task in it) can render in both columns at
 * once, so "project prj_1" or "task tsk_9" alone no longer says where the
 * task should end up. `"project"` is a drop directly on a project's header
 * or body — the one gesture that explicitly re-homes a task into a
 * *different* project (as opposed to landing "anywhere" in a column, which
 * snaps home instead for a task leaving Today — see the "section"/"backlog"
 * branch of `computeTaskMove`).
 */
export type DropTarget =
  | { kind: "section"; column: Bucket }
  | { kind: "task"; taskId: string; column: Bucket }
  | { kind: "project"; projectId: string; column: Bucket }
  | null;

/**
 * `backlog` is the ONE canonical task tree for the whole board (mirrors
 * `getBoard`'s wire shape since Phase 2 — `today.tasks` no longer exists).
 * Every open task lives here exactly once, in its real home position
 * (`project_id`/`parent_id`/`sort_order`), whether or not it currently
 * counts as "in Today". The grouped Today *view* is derived downstream
 * (`lib/todayView.ts`, Phase 3b) by filtering this same tree on `inToday` —
 * there is no second tree for this module to keep in sync, which is what
 * makes Phase 2's "one canonical tree per board load" guarantee hold all
 * the way through drag-and-drop.
 */
export interface DragBoardTasks {
  backlog: TaskDto[];
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

/**
 * The result of mapping one drag gesture to a server call.
 *
 * A discriminated union, not a sentinel on `MoveTaskInput`, on purpose:
 * `MoveTaskInput` is a wire shape forwarded verbatim to the `moveTask` RPC,
 * and an auto-included task leaving Today has nothing for `moveTask` to do
 * at all (there's no `bucket` flag to clear — `inToday` for such a row is
 * pure due-date derivation). Bolting a `dismiss: true` flag onto
 * `MoveTaskInput` would mean either every RPC caller has to remember to
 * strip it before the network call, or the server has to learn to ignore an
 * input shape it was never meant to see. A `kind` discriminant instead
 * forces every caller to `switch`/narrow before touching either payload, and
 * TypeScript flags a caller that forgets the new `"dismiss"` arm.
 *
 * `null` keeps its pre-Phase-3 meaning unchanged: the drop was a genuine
 * no-op (nothing to move, nothing to dismiss) — dropped on nothing, on
 * itself, or on an id no longer on the board.
 */
export type ComputeMoveResult = { kind: "move"; move: MoveTaskInput } | { kind: "dismiss"; id: string } | null;

function flattenBoardTasks(tasks: DragBoardTasks): TaskDto[] {
  const all: TaskDto[] = [];
  for (const t of tasks.backlog) all.push(t, ...t.subtasks);
  return all;
}

/** Finds a task anywhere on the board. `backlog` is the only tree there is
 * since Phase 2, so this is a flat id lookup across it and every subtask. */
export function findTaskInBoard(tasks: DragBoardTasks, id: string): TaskDto | null {
  for (const t of flattenBoardTasks(tasks)) {
    if (t.id === id) return t;
  }
  return null;
}

/**
 * Which of the three zones the drag currently sits in, relative to a
 * top-level or subtask target row. `canNest` is false for a subtask target
 * (subtasks are exactly one level deep — SPEC.md rule 2 — so they can never
 * be a nest target). Falls back to "before" when either rect is unavailable
 * (e.g. jsdom, which reports every rect as zeros).
 *
 * Purely geometric — it knows nothing about columns or drop-zone ids. See
 * `parseDropZoneId` below for the column-scoped id scheme `computeTaskMove`
 * relies on to build a `DropTarget` in the first place.
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

export type DropZoneKind = "section" | "project" | "task";

/**
 * Column-scoped droppable-id scheme for `components/TodoPage.tsx`'s
 * dnd-kit `id`s (Phase 4). Before Phase 3, "project prj_1" or the Backlog
 * section body were each rendered in exactly one place, so a bare kind+id
 * was unambiguous. Since Today now renders the *same* project groups (and
 * every `inToday` task) side by side with the Backlog, a droppable id needs
 * a column segment to say which rendered copy was actually dropped on.
 *
 * Format: `"<kind>:<column>:<targetId>"`, always three `:`-joined segments.
 * `targetId` is the empty string for `"section"` (there is exactly one
 * section droppable per column); a project id for `"project"`; a task id
 * for `"task"`. Task ids and project ids in this codebase are opaque
 * generated ids (see `lib/db.ts`) that never contain `:`, so the split is
 * unambiguous.
 *
 *   dropZoneId("section", "today")               -> "section:today:"
 *   dropZoneId("project", "backlog", "prj_1")     -> "project:backlog:prj_1"
 *   dropZoneId("task", "today", "tsk_9")          -> "task:today:tsk_9"
 *
 * A task's own *drag source* id (what dnd-kit reports as `active.id` while
 * it's being picked up, as opposed to a drop target) is a separate,
 * pre-existing scheme — `taskDragId` in `components/TaskRow.tsx` — which
 * already disambiguates a task's two simultaneous row instances and is out
 * of this module's scope. `dropZoneId`/`parseDropZoneId` are for drop
 * TARGETS: section bodies, project headers/bodies, and (if a caller prefers
 * one scheme end to end) task rows too.
 */
export function dropZoneId(kind: "section", column: Bucket): string;
export function dropZoneId(kind: "project" | "task", column: Bucket, targetId: string): string;
export function dropZoneId(kind: DropZoneKind, column: Bucket, targetId = ""): string {
  return `${kind}:${column}:${targetId}`;
}

/** Inverse of `dropZoneId`. Returns `null` for any id that doesn't match the
 * three-segment `"<kind>:<column>:<targetId>"` scheme (including ids from
 * an unrelated source, like `taskDragId`'s active-drag ids, which callers
 * should not feed through this parser). */
export function parseDropZoneId(
  id: string,
): { kind: DropZoneKind; column: Bucket; targetId: string } | null {
  const parts = id.split(":");
  if (parts.length !== 3) return null;
  const [kind, column, targetId] = parts;
  if (kind !== "section" && kind !== "project" && kind !== "task") return null;
  if (column !== "backlog" && column !== "today") return null;
  return { kind, column, targetId };
}

/**
 * Maps one drag gesture to exactly one server call, or `null` when the drop
 * is a no-op (dropped on nothing, on itself, or on an id no longer on the
 * board). The dragged id is always filtered out of whichever sibling group
 * is used to compute `beforeId`/`afterId`, so it can never appear as its own
 * neighbour.
 *
 * The one cross-cutting rule, checked first: a drag whose SOURCE was the
 * Today column (`active.column === "today"`) landing in the Backlog column
 * (`target.column === "backlog"`) is "leaving Today" — matrix rows "Today
 * row -> Backlog". Everything else (including reordering an `inToday` row
 * from its *Backlog* instance, which must NOT count as leaving Today) falls
 * through to the ordinary, column-agnostic placement logic below, which
 * simply stamps the destination `bucket` from `target.column` and computes
 * order from the task's real home sibling group in `tasks.backlog` — the
 * only sibling group that exists post-Phase-2, whether the row is landing
 * in the Backlog or in Today.
 */
export function computeTaskMove(
  active: DragTaskRef,
  target: DropTarget,
  tasks: DragBoardTasks,
  activeRect?: DragRect | null,
  overRect?: DragRect | null,
): ComputeMoveResult {
  if (target === null) return null;

  const destColumn = target.column;
  const leavingToday = active.column === "today" && destColumn === "backlog";

  if (leavingToday) {
    if (active.bucket === "backlog") {
      // Drag matrix: "Today row -> Backlog, auto-included only
      // (bucket === 'backlog' && inToday)". There is no `bucket` flag to
      // clear — `inToday` for this row is entirely due-date-derived — so
      // there is nothing for `moveTask` to express. (A drop directly on a
      // *different* project's header, `target.kind === "project"`, could in
      // principle both re-file AND dismiss in one gesture, but that combined
      // move isn't in the matrix and two RPCs don't fit one
      // `ComputeMoveResult`; dismissing is the safe, always-correct subset,
      // and re-filing from the Backlog column already works today.)
      return { kind: "dismiss", id: active.taskId };
    }
    // active.bucket === "today": the existing snap-home rule — dropping a
    // scheduled row "anywhere" in the Backlog column unschedules it without
    // moving it (position is deliberately not computed; `moveTask`'s
    // snapHome branch ignores beforeId/afterId regardless). Only an explicit
    // drop on a *different* project's header/body (`target.kind ===
    // "project"`) re-homes it instead — handled by falling through to the
    // ordinary "project" branch below, which forces `bucket: "backlog"` via
    // `destColumn` same as this branch would have.
    if (target.kind !== "project") {
      return {
        kind: "move",
        move: { id: active.taskId, bucket: "backlog", parentId: active.parentId, beforeId: null, afterId: null },
      };
    }
  }

  if (target.kind === "project") {
    // Drag matrix: "project task -> another project", "loose task ->
    // project body", "Today project A -> project B" — all converge on the
    // same shape: top-level, explicit projectId, appended at the end of
    // that project's home group (the only sibling group there is). `bucket`
    // is always `destColumn`: staying in Today (re-homing across two Today
    // project groups) keeps `bucket: "today"`; landing on a Backlog-column
    // project header — including the `leavingToday` fallthrough above —
    // yields `bucket: "backlog"`.
    const homeSiblings = tasks.backlog
      .filter((t) => (t.projectId ?? null) === target.projectId && t.id !== active.taskId)
      .map((t) => t.id);
    return {
      kind: "move",
      move: {
        id: active.taskId,
        bucket: destColumn,
        parentId: null,
        projectId: target.projectId,
        beforeId: null,
        afterId: homeSiblings.length > 0 ? homeSiblings[homeSiblings.length - 1] : null,
      },
    };
  }

  if (target.kind === "section") {
    if (destColumn === "today") {
      // Drag matrix: "Backlog row -> Today column, no specific target row".
      // Flag scheduled; NO order write. A subtask keeps its parent (CENTRAL
      // FIX), a project task stays parentless; `projectId` is omitted
      // entirely (moveTask's "omit = unchanged") and beforeId/afterId are
      // both null, which is exactly `lib/db.ts`'s `homeUnchanged` condition
      // — the row must stay exactly where it is in its home group.
      return {
        kind: "move",
        move: { id: active.taskId, bucket: "today", parentId: active.parentId, beforeId: null, afterId: null },
      };
    }

    // destColumn === "backlog", and not `leavingToday` (that case already
    // returned above) — an ordinary Backlog-column task dropped on the
    // generic section body: "project task -> loose area: project_id = NULL".
    const ids = tasks.backlog
      .filter((t) => (t.projectId ?? null) === null)
      .map((t) => t.id)
      .filter((id) => id !== active.taskId);
    return {
      kind: "move",
      move: {
        id: active.taskId,
        bucket: "backlog",
        parentId: null,
        projectId: null,
        beforeId: null,
        afterId: ids.length > 0 ? ids[ids.length - 1] : null,
      },
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
    const siblingIds = overTask.subtasks.map((s) => s.id).filter((id) => id !== active.taskId);
    return {
      kind: "move",
      move: {
        id: active.taskId,
        bucket: destColumn,
        parentId: overTask.id,
        beforeId: null,
        afterId: siblingIds.length > 0 ? siblingIds[siblingIds.length - 1] : null,
      },
    };
  }

  if (destColumn === "today") {
    // Matrix rows "Backlog row -> Today, near a specific row" and "Today
    // row -> Today: reorder" / "a subtask reordering among its own
    // siblings" (when already in Today). CENTRAL FIX still applies here:
    // `parentId` is always the DRAGGED task's own parentId — never adopted
    // from `overTask` — and `projectId` is always omitted. This mirrors
    // `lib/db.ts`'s `moveTask` precisely: when entering/staying in Today,
    // `newProjectId`/`newParentId` are the row's own *unchanged* home
    // (project omitted, parentId equal to what it already was), and the
    // server's `getHomeSiblingRows` lookup for `beforeId`/`afterId` is
    // scoped to THAT home group — not whatever group `overTask` happens to
    // belong to. So the sibling group used for order interpolation here is
    // the dragged task's own home siblings, and `overTask` only supplies a
    // usable position if it's actually a member of that group; otherwise
    // there is no meaningful reference and this degrades to the
    // no-specific-row case (flagged, no order write) rather than sending a
    // beforeId/afterId the server's home-scoped lookup would silently
    // ignore anyway.
    const activeProjectId = findTaskInBoard(tasks, active.taskId)?.projectId ?? null;
    const homeGroupIds =
      active.parentId !== null
        ? (findTaskInBoard(tasks, active.parentId)?.subtasks.map((s) => s.id) ?? [])
        : tasks.backlog.filter((t) => (t.projectId ?? null) === activeProjectId).map((t) => t.id);
    const filtered = homeGroupIds.filter((id) => id !== active.taskId);
    const idx = filtered.indexOf(overTask.id);

    if (idx === -1) {
      return {
        kind: "move",
        move: { id: active.taskId, bucket: "today", parentId: active.parentId, beforeId: null, afterId: null },
      };
    }
    if (zone === "before") {
      return {
        kind: "move",
        move: {
          id: active.taskId,
          bucket: "today",
          parentId: active.parentId,
          beforeId: overTask.id,
          afterId: idx > 0 ? filtered[idx - 1] : null,
        },
      };
    }
    return {
      kind: "move",
      move: {
        id: active.taskId,
        bucket: "today",
        parentId: active.parentId,
        beforeId: idx < filtered.length - 1 ? filtered[idx + 1] : null,
        afterId: overTask.id,
      },
    };
  }

  // destColumn === "backlog", ordinary Backlog-to-Backlog placement: landing
  // before/after an existing row either reorders in place or (per SPEC.md
  // rule 2) promotes/re-homes the dragged task to `overTask`'s own home
  // group — its project (top-level) or its parent's subtasks. This is the
  // one case where the target row's OWN home, not the dragged task's, wins:
  // unlike entering Today (a flag, never a relocation), landing among
  // ordinary Backlog rows always means "place me here."
  const groupIds =
    overTask.parentId === null
      ? tasks.backlog
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
      kind: "move",
      move: {
        id: active.taskId,
        bucket: destColumn,
        parentId: overTask.parentId,
        projectId: destProjectId,
        beforeId: overTask.id,
        afterId: idx > 0 ? filtered[idx - 1] : null,
      },
    };
  }
  return {
    kind: "move",
    move: {
      id: active.taskId,
      bucket: destColumn,
      parentId: overTask.parentId,
      projectId: destProjectId,
      beforeId: idx < filtered.length - 1 ? filtered[idx + 1] : null,
      afterId: overTask.id,
    },
  };
}

/**
 * Drag matrix: "project header -> project header: reorder projects". A
 * project drag never touches tasks, so it's a plain id-array reorder for
 * the `reorderProjects` RPC — mirroring dnd-kit's `arrayMove` without a
 * dnd-kit import (this module's no-runtime-import rule). Project headers are
 * only ever draggable in the Backlog column (Today's are read-only labels —
 * SPEC), so this never needs a `column` discriminator.
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
// RPC resolves, so the row is already sitting in its destination by the time
// dnd-kit's drop animation would otherwise play (see
// `components/TodoPage.tsx`'s `handleDragEnd` for why that ordering matters:
// the fly-back-then-refetch UX bug). It only needs to get BUCKET, PARENT,
// PROJECT and `inToday` right — `sortOrder` is not reproduced faithfully,
// since only the server (via `lib/db.ts`'s `moveTask`) knows the real
// gap-filling math; the follow-up `getBoard` refetch is authoritative and
// will settle the exact order. Recomputing real Today membership from
// `dueAt`/`today_dismissed_day` is explicitly NOT this function's job —
// `inToday` is set to exactly what the move implies (true entering/staying
// in Today, false leaving it or being dismissed from it), and the refetch
// corrects anything more subtle (e.g. an auto-included task that's still
// due today after being "moved" within the Backlog).

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

/** A task's home location within the `backlog` tree: itself, plus the id of
 * the parent it's nested under (`null` = top-level). Since Phase 2 this is
 * the ONLY location a task has — there is no separate Today tree to keep in
 * sync. */
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

/**
 * Applies one `computeTaskMove` result to the board's task tree, entirely
 * locally — no RPC, no server round trip. Returns new arrays; `tasks` (and
 * every `TaskDto` untouched by the move) is left exactly as it was.
 * `outcome: null` is a no-op and returns `tasks` unchanged. A task id not
 * present in `tasks.backlog` is also a no-op — the refetch will reconcile.
 *
 * Mirrors `lib/db.ts`'s `moveTask`/`dismissFromToday`:
 * - A "dismiss" outcome patches only `inToday: false` on the row — exactly
 *   what `dismissFromToday` does server-side (it never touches `bucket`,
 *   `day`, `parent_id`, or `project_id`).
 * - Entering Today (or the snap-home "leaving Today anywhere" case) with no
 *   real re-home (`beforeId`/`afterId` both null, parent/project unchanged)
 *   patches `bucket`/`day`/`inToday` in place, matching `lib/db.ts`'s
 *   `homeUnchanged`/`snapHome` guards: no `sort_order` write, so the row
 *   must not move position in the array either.
 * - A real re-home/re-parent (parent or project actually changing, or an
 *   explicit `beforeId`/`afterId`) relocates the entry within the tree and,
 *   per SPEC.md rule 2, promotes a newly-nested task's own subtasks to
 *   top-level siblings (subtasks are exactly one level deep).
 * - Per invariant 4, scheduling a parent never drags its subtasks into
 *   Today; a project/parent change, however, still mirrors onto any
 *   remaining real subtasks (invariant 2: a subtask's project always
 *   mirrors its parent's).
 */
export function applyMoveToBoard(
  tasks: DragBoardTasks,
  outcome: ComputeMoveResult,
  today?: string | null,
): DragBoardTasks {
  if (!outcome) return tasks;

  if (outcome.kind === "dismiss") {
    const home = findHome(tasks, outcome.id);
    if (!home) return tasks;
    return patchHome(tasks, outcome.id, home.parentId, { inToday: false });
  }

  const move = outcome.move;
  const home = findHome(tasks, move.id);
  if (!home) return tasks;

  const moving = home.task;
  const currentParentId = home.parentId;
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
  // Only a real reposition/re-home relocates the entry within the tree —
  // entering Today, or leaving it via snap-home (parent/project unchanged,
  // beforeId/afterId both null by construction — see computeTaskMove),
  // leaves the tree's structure alone; only bucket/day/inToday are patched.
  const shouldRelocate = homeChanged || move.beforeId !== null || move.afterId !== null;

  // A task with parent_id set can never itself have subtasks (depth cap),
  // so `moving.subtasks` is only non-empty when `moving` is a top-level
  // task — `nestingNow` only ever has real children to promote in that
  // case, matching lib/db.ts's `moveTask`.
  const nestingNow = newParentId !== null;
  const promoted: TaskDto[] = nestingNow ? moving.subtasks.map((s) => ({ ...s, parentId: null })) : [];
  // A relocating parent's still-remaining real subtasks mirror its new
  // project (invariant 2); their own bucket/day/inToday are untouched
  // (invariant 4).
  const carriedSubtasks: TaskDto[] = nestingNow
    ? []
    : moving.subtasks.map((s) => ({ ...s, projectId: newProjectId }));

  const destDay = enteringToday ? (today ?? moving.day ?? null) : null;

  let working: DragBoardTasks = tasks;

  if (shouldRelocate) {
    working = removeFromHome(working, move.id, currentParentId);
    const movedTask: TaskDto = {
      ...moving,
      parentId: newParentId,
      projectId: newProjectId,
      bucket: destBucket,
      day: destDay,
      inToday: enteringToday,
      subtasks: nestingNow ? [] : carriedSubtasks,
      subtaskCounts: nestingNow ? { total: 0, done: 0 } : moving.subtaskCounts,
    };
    working = insertIntoHome(working, movedTask, newParentId, move.beforeId, move.afterId);
    if (promoted.length > 0) {
      // Splice the promoted ex-children in as top-level siblings; their own
      // bucket/day/project/inToday are left exactly as they were (lib/db.ts
      // leaves their sort_order alone too, beyond the gap-filling this
      // approximates away — the refetch settles the exact order).
      working = { ...working, backlog: [...working.backlog, ...promoted] };
    }
  } else {
    working = patchHome(working, move.id, currentParentId, {
      bucket: destBucket,
      day: destDay,
      inToday: enteringToday,
    });
  }

  return working;
}
