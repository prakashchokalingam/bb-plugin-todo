import { describe, expect, it } from "vitest";
import type { TaskDto } from "@/contract";
import {
  applyMoveToBoard,
  computeProjectReorder,
  computeTaskMove,
  dropZoneId,
  parseDropZoneId,
  resolveDropZone,
  type Bucket,
  type ComputeMoveResult,
  type DragBoardTasks,
  type DragTaskRef,
  type MoveTaskInput,
} from "./drag";

function makeTask(overrides: Partial<TaskDto> & { id: string }): TaskDto {
  return {
    listId: "lst_1",
    parentId: null,
    title: overrides.id,
    notes: null,
    bucket: "backlog",
    day: null,
    sortOrder: 1000,
    dueAt: null,
    hasDueTime: false,
    status: "open",
    completedAt: null,
    carriedCount: 0,
    createdAt: 0,
    updatedAt: 0,
    subtasks: [],
    subtaskCounts: { total: 0, done: 0 },
    tags: [],
    projectId: null,
    trail: null,
    inToday: false,
    ...overrides,
  };
}

/** A 32px-tall row at `index` in a simple vertical stack, matching how
 * dnd-kit reports rects for a list rendered top to bottom. */
function rowRect(index: number) {
  return { top: index * 32, height: 32 };
}

function board(backlog: TaskDto[]): DragBoardTasks {
  return { backlog };
}

/** Shorthand for a `DragTaskRef` grabbed from the Backlog column, the
 * common case in most of these tests — only the "leaving Today"/"dismiss"
 * tests need to construct one with `column: "today"` explicitly. */
function fromBacklog(task: Partial<DragTaskRef> & { taskId: string }): DragTaskRef {
  return { parentId: null, bucket: "backlog", inToday: false, column: "backlog", ...task };
}

function fromToday(task: Partial<DragTaskRef> & { taskId: string }): DragTaskRef {
  return { parentId: null, bucket: "today", inToday: true, column: "today", ...task };
}

describe("dropZoneId / parseDropZoneId", () => {
  it("round-trips a section id", () => {
    const id = dropZoneId("section", "today");
    expect(id).toBe("section:today:");
    expect(parseDropZoneId(id)).toEqual({ kind: "section", column: "today", targetId: "" });
  });

  it("round-trips a project id, distinctly per column", () => {
    const backlogId = dropZoneId("project", "backlog", "prj_1");
    const todayId = dropZoneId("project", "today", "prj_1");
    expect(backlogId).not.toBe(todayId);
    expect(parseDropZoneId(backlogId)).toEqual({ kind: "project", column: "backlog", targetId: "prj_1" });
    expect(parseDropZoneId(todayId)).toEqual({ kind: "project", column: "today", targetId: "prj_1" });
  });

  it("round-trips a task id, distinctly per column, so the same task can be a drop target from either column", () => {
    const backlogId = dropZoneId("task", "backlog", "tsk_1");
    const todayId = dropZoneId("task", "today", "tsk_1");
    expect(backlogId).not.toBe(todayId);
    expect(parseDropZoneId(backlogId)?.column).toBe("backlog");
    expect(parseDropZoneId(todayId)?.column).toBe("today");
  });

  it("returns null for an id from an unrelated scheme", () => {
    expect(parseDropZoneId("tsk_1")).toBeNull();
    expect(parseDropZoneId("today:tsk_1")).toBeNull();
    expect(parseDropZoneId("bogus:backlog:tsk_1")).toBeNull();
    expect(parseDropZoneId("project:north:prj_1")).toBeNull();
  });
});

describe("computeTaskMove — Backlog row -> Today column, no specific target row", () => {
  it("flips bucket and keeps a project task parentless, with no order write", () => {
    const task = makeTask({ id: "tsk_a", bucket: "backlog", projectId: "prj_1" });
    const b = board([task]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a" }),
      { kind: "section", column: "today" },
      b,
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", bucket: "today", parentId: null, beforeId: null, afterId: null },
    });
    expect((result as { kind: "move"; move: MoveTaskInput }).move).not.toHaveProperty("projectId");
  });

  it("CENTRAL FIX — a subtask keeps its parentId (was: nulled)", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      projectId: "prj_1",
      subtasks: [makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "backlog", projectId: "prj_1" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const b = board([parent]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_sub", parentId: "tsk_parent" }),
      { kind: "section", column: "today" },
      b,
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_sub", bucket: "today", parentId: "tsk_parent", beforeId: null, afterId: null },
    });
  });

  it("no order write even when other tasks already sit in Today (regression: must not append to bottom)", () => {
    const already = makeTask({ id: "tsk_already", bucket: "today", inToday: true });
    const dragged = makeTask({ id: "tsk_a", bucket: "backlog" });
    const b = board([already, dragged]);
    const result = computeTaskMove(fromBacklog({ taskId: "tsk_a" }), { kind: "section", column: "today" }, b);
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", bucket: "today", parentId: null, beforeId: null, afterId: null },
    });
  });
});

describe("computeTaskMove — Backlog row -> Today, near a specific row", () => {
  it("flags scheduled and interpolates order from the HOME sibling group (the dragged task's OWN project, not the target's)", () => {
    const sibling1 = makeTask({ id: "tsk_s1", bucket: "backlog", projectId: "prj_1" });
    const sibling2 = makeTask({ id: "tsk_s2", bucket: "backlog", projectId: "prj_1" });
    const dragged = makeTask({ id: "tsk_a", bucket: "backlog", projectId: "prj_1" });
    const b = board([sibling1, sibling2, dragged]);
    // Drop tsk_a "before" sibling2, in the Today column. sibling2 is a
    // genuine member of tsk_a's own home group (same project), so it's a
    // usable order reference.
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a" }),
      { kind: "task", taskId: "tsk_s2", column: "today" },
      b,
      rowRect(0),
      rowRect(1),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", bucket: "today", parentId: null, beforeId: "tsk_s2", afterId: "tsk_s1" },
    });
    expect((result as { kind: "move"; move: MoveTaskInput }).move).not.toHaveProperty("projectId");
  });

  it("a subtask entering Today near a row keeps its parentId (central fix, near-row route)", () => {
    const sibling = makeTask({ id: "tsk_sib", parentId: "tsk_parent", bucket: "backlog", projectId: "prj_1" });
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      projectId: "prj_1",
      subtasks: [
        sibling,
        makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "backlog", projectId: "prj_1" }),
      ],
      subtaskCounts: { total: 2, done: 0 },
    });
    const b = board([parent]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_sub", parentId: "tsk_parent" }),
      { kind: "task", taskId: "tsk_sib", column: "today" },
      b,
      rowRect(5), // after
      rowRect(0),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_sub", bucket: "today", parentId: "tsk_parent", beforeId: null, afterId: "tsk_sib" },
    });
  });

  it("degrades to no order write when the target row isn't a member of the dragged task's own home group", () => {
    // tsk_other belongs to a different (no) project and isn't a sibling of
    // tsk_a's home group — there's no meaningful position reference, so the
    // server's home-scoped sibling lookup would ignore beforeId/afterId
    // anyway; this must not send a stale/meaningless reference.
    const dragged = makeTask({ id: "tsk_a", bucket: "backlog", projectId: "prj_1" });
    const unrelated = makeTask({ id: "tsk_other", bucket: "today", inToday: true, projectId: "prj_2" });
    const b = board([dragged, unrelated]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a" }),
      { kind: "task", taskId: "tsk_other", column: "today" },
      b,
      rowRect(5),
      rowRect(0),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", bucket: "today", parentId: null, beforeId: null, afterId: null },
    });
  });
});

describe("computeTaskMove — Today row -> Backlog, bucket === 'today' (existing snap-home path)", () => {
  it("snaps home regardless of where it's dropped in the Backlog column", () => {
    const scheduled = makeTask({ id: "tsk_a", bucket: "today", projectId: "prj_1", inToday: true });
    const other = makeTask({ id: "tsk_b", bucket: "backlog", projectId: "prj_2" });
    const b = board([scheduled, other]);
    const result = computeTaskMove(
      fromToday({ taskId: "tsk_a" }),
      { kind: "task", taskId: "tsk_b", column: "backlog" },
      b,
      rowRect(5),
      rowRect(0),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", bucket: "backlog", parentId: null, beforeId: null, afterId: null },
    });
    expect((result as { kind: "move"; move: MoveTaskInput }).move).not.toHaveProperty("projectId");
  });

  it("snaps home on a bare section-body drop too", () => {
    const scheduled = makeTask({ id: "tsk_a", bucket: "today", inToday: true });
    const b = board([scheduled]);
    const result = computeTaskMove(fromToday({ taskId: "tsk_a" }), { kind: "section", column: "backlog" }, b);
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", bucket: "backlog", parentId: null, beforeId: null, afterId: null },
    });
  });

  it("leaves sort_order, parent_id, and project_id untouched (asserted via the omitted fields / null position)", () => {
    const scheduled = makeTask({ id: "tsk_a", parentId: null, bucket: "today", projectId: "prj_1", inToday: true });
    const b = board([scheduled]);
    const result = computeTaskMove(fromToday({ taskId: "tsk_a" }), { kind: "section", column: "backlog" }, b) as {
      kind: "move";
      move: MoveTaskInput;
    };
    expect(result.move.beforeId).toBeNull();
    expect(result.move.afterId).toBeNull();
    expect(result.move.projectId).toBeUndefined();
    expect(result.move.parentId).toBeNull();
  });

  it("reordering an inToday task from its Backlog-column instance is an ordinary reorder, NOT a snap-home", () => {
    // Same underlying task, same bucket, but dragged from the BACKLOG
    // column this time — column, not bucket, decides "leaving Today".
    const scheduled = makeTask({ id: "tsk_a", bucket: "today", projectId: "prj_1", inToday: true });
    const sibling = makeTask({ id: "tsk_b", bucket: "backlog", projectId: "prj_1" });
    const b = board([scheduled, sibling]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a", bucket: "today", inToday: true }),
      { kind: "task", taskId: "tsk_b", column: "backlog" },
      b,
      rowRect(5),
      rowRect(0),
    );
    // A real reorder: afterId points at tsk_b, not the null/null snap-home shape.
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", bucket: "backlog", parentId: null, projectId: "prj_1", beforeId: null, afterId: "tsk_b" },
    });
  });
});

describe("computeTaskMove — Today row -> Backlog, auto-included only (bucket 'backlog' && inToday)", () => {
  it("produces a dismiss outcome, not a moveTask", () => {
    const auto = makeTask({ id: "tsk_a", bucket: "backlog", inToday: true, dueAt: 1000 });
    const other = makeTask({ id: "tsk_b", bucket: "backlog" });
    const b = board([auto, other]);
    const result = computeTaskMove(
      fromToday({ taskId: "tsk_a", bucket: "backlog", inToday: true }),
      { kind: "task", taskId: "tsk_b", column: "backlog" },
      b,
      rowRect(5),
      rowRect(0),
    );
    expect(result).toEqual({ kind: "dismiss", id: "tsk_a" });
  });

  it("dismisses on a bare section-body drop too", () => {
    const auto = makeTask({ id: "tsk_a", bucket: "backlog", inToday: true, dueAt: 1000 });
    const b = board([auto]);
    const result = computeTaskMove(
      fromToday({ taskId: "tsk_a", bucket: "backlog", inToday: true }),
      { kind: "section", column: "backlog" },
      b,
    );
    expect(result).toEqual({ kind: "dismiss", id: "tsk_a" });
  });

  it("does NOT dismiss when the same task is reordered from its Backlog-column instance", () => {
    const auto = makeTask({ id: "tsk_a", bucket: "backlog", inToday: true, dueAt: 1000, projectId: "prj_1" });
    const sibling = makeTask({ id: "tsk_b", bucket: "backlog", projectId: "prj_1" });
    const b = board([auto, sibling]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a", inToday: true }),
      { kind: "task", taskId: "tsk_b", column: "backlog" },
      b,
      rowRect(5),
      rowRect(0),
    );
    expect(result?.kind).toBe("move");
  });
});

describe("computeTaskMove — Today project A -> project B (re-home, sort_order only, bucket unchanged)", () => {
  it("stays in Today: bucket remains 'today', project changes, order appended in the target project", () => {
    const scheduled = makeTask({ id: "tsk_a", bucket: "today", projectId: "prj_1", inToday: true });
    const inTargetProject = makeTask({ id: "tsk_in_prj2", bucket: "backlog", projectId: "prj_2" });
    const b = board([scheduled, inTargetProject]);
    const result = computeTaskMove(
      fromToday({ taskId: "tsk_a" }),
      { kind: "project", projectId: "prj_2", column: "today" },
      b,
    );
    expect(result).toEqual({
      kind: "move",
      move: {
        id: "tsk_a",
        bucket: "today",
        parentId: null,
        projectId: "prj_2",
        beforeId: null,
        afterId: "tsk_in_prj2",
      },
    });
  });

  it("dropping on a different project's header in the BACKLOG column unschedules AND re-homes", () => {
    const scheduled = makeTask({ id: "tsk_a", bucket: "today", projectId: "prj_1", inToday: true });
    const b = board([scheduled]);
    const result = computeTaskMove(
      fromToday({ taskId: "tsk_a" }),
      { kind: "project", projectId: "prj_2", column: "backlog" },
      b,
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", bucket: "backlog", parentId: null, projectId: "prj_2", beforeId: null, afterId: null },
    });
  });
});

describe("computeTaskMove — reorder within Today, same project", () => {
  it("plain reorder among home siblings", () => {
    const a = makeTask({ id: "tsk_a", bucket: "today", projectId: "prj_1", inToday: true });
    const bTask = makeTask({ id: "tsk_b", bucket: "today", projectId: "prj_1", inToday: true });
    const c = makeTask({ id: "tsk_c", bucket: "today", projectId: "prj_1", inToday: true });
    const brd = board([a, bTask, c]);
    const result = computeTaskMove(
      fromToday({ taskId: "tsk_c" }),
      { kind: "task", taskId: "tsk_a", column: "today" },
      brd,
      rowRect(0),
      rowRect(1),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_c", bucket: "today", parentId: null, beforeId: "tsk_a", afterId: null },
    });
  });
});

describe("computeTaskMove — project header reorder (unchanged)", () => {
  it("reorders the project id array", () => {
    const ids = ["prj_1", "prj_2", "prj_3"];
    expect(computeProjectReorder("prj_3", "prj_1", ids)).toEqual(["prj_3", "prj_1", "prj_2"]);
  });

  it("is a no-op dragging onto itself", () => {
    expect(computeProjectReorder("prj_1", "prj_1", ["prj_1", "prj_2"])).toBeNull();
  });

  it("is a no-op for an unknown id", () => {
    expect(computeProjectReorder("prj_1", "prj_ghost", ["prj_1", "prj_2"])).toBeNull();
  });
});

describe("computeTaskMove — nesting into a subtask", () => {
  it("dropping into the middle band of a top-level row nests under it, bucket following the target column", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "today",
      inToday: true,
      subtasks: [makeTask({ id: "tsk_sub1", parentId: "tsk_parent", bucket: "backlog" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const dragged = makeTask({ id: "tsk_drag", bucket: "backlog" });
    const b = board([parent, dragged]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_drag" }),
      { kind: "task", taskId: "tsk_parent", column: "today" },
      b,
      rowRect(0),
      rowRect(0),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_drag", bucket: "today", parentId: "tsk_parent", beforeId: null, afterId: "tsk_sub1" },
    });
  });

  it("nesting under a top-level row with no existing subtasks appends as its only subtask", () => {
    const parent = makeTask({ id: "tsk_parent", bucket: "backlog" });
    const dragged = makeTask({ id: "tsk_drag", bucket: "backlog" });
    const b = board([parent, dragged]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_drag" }),
      { kind: "task", taskId: "tsk_parent", column: "backlog" },
      b,
      rowRect(0),
      rowRect(0),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_drag", bucket: "backlog", parentId: "tsk_parent", beforeId: null, afterId: null },
    });
  });

  it("dropping onto a subtask never nests — depth stays 1", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      subtasks: [makeTask({ id: "tsk_sub1", parentId: "tsk_parent", bucket: "backlog" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const dragged = makeTask({ id: "tsk_drag", bucket: "backlog" });
    const b = board([dragged, parent]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_drag" }),
      { kind: "task", taskId: "tsk_sub1", column: "backlog" },
      b,
      rowRect(0),
      rowRect(0),
    ) as { kind: "move"; move: MoveTaskInput };
    expect(result.kind).toBe("move");
    expect(result.move.parentId).toBe("tsk_parent");
    expect(result.move.parentId).not.toBe("tsk_sub1");
  });
});

describe("computeTaskMove — promoting a subtask to top-level", () => {
  it("dragging a subtask into the before/after zone of a top-level row promotes it", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      subtasks: [makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "backlog" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const otherTop = makeTask({ id: "tsk_other", bucket: "backlog" });
    const b = board([parent, otherTop]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_sub", parentId: "tsk_parent" }),
      { kind: "task", taskId: "tsk_other", column: "backlog" },
      b,
      rowRect(5),
      rowRect(1),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_sub", bucket: "backlog", parentId: null, projectId: null, beforeId: null, afterId: "tsk_other" },
    });
  });
});

describe("computeTaskMove — a subtask reordering among its own siblings", () => {
  it("keeps parentId and computes beforeId/afterId from the real (backlog-tree) sibling group", () => {
    const s1 = makeTask({ id: "tsk_s1", parentId: "tsk_parent", bucket: "backlog" });
    const s2 = makeTask({ id: "tsk_s2", parentId: "tsk_parent", bucket: "backlog" });
    const s3 = makeTask({ id: "tsk_s3", parentId: "tsk_parent", bucket: "backlog" });
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      subtasks: [s1, s2, s3],
      subtaskCounts: { total: 3, done: 0 },
    });
    const b = board([parent]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_s3", parentId: "tsk_parent" }),
      { kind: "task", taskId: "tsk_s1", column: "backlog" },
      b,
      rowRect(0),
      rowRect(1),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_s3", bucket: "backlog", parentId: "tsk_parent", beforeId: "tsk_s1", afterId: null },
    });
  });
});

describe("computeTaskMove — no-op edges", () => {
  it("dropping on nothing (target: null) returns null", () => {
    const b = board([makeTask({ id: "tsk_a" })]);
    expect(computeTaskMove(fromBacklog({ taskId: "tsk_a" }), null, b)).toBeNull();
  });

  it("dropping on itself returns null", () => {
    const b = board([makeTask({ id: "tsk_a" })]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a" }),
      { kind: "task", taskId: "tsk_a", column: "backlog" },
      b,
    );
    expect(result).toBeNull();
  });

  it("dropping on an id no longer on the board returns null", () => {
    const b = board([makeTask({ id: "tsk_a" })]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a" }),
      { kind: "task", taskId: "tsk_does_not_exist", column: "backlog" },
      b,
    );
    expect(result).toBeNull();
  });

  it("an empty board with a section drop still resolves to a clean append into the loose area", () => {
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_only" }),
      { kind: "section", column: "backlog" },
      board([]),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_only", bucket: "backlog", parentId: null, projectId: null, beforeId: null, afterId: null },
    });
  });
});

describe("resolveDropZone", () => {
  it("falls back to 'before' when rects are unavailable (e.g. jsdom's zeroed getBoundingClientRect)", () => {
    expect(resolveDropZone(true, null, null)).toBe("before");
    expect(resolveDropZone(true, undefined, undefined)).toBe("before");
  });

  it("resolves 'nest' only within the middle band, and only when nesting is allowed", () => {
    const over = { top: 100, height: 32 }; // center = 116, band = 8 -> [108, 124]
    expect(resolveDropZone(true, { top: 100, height: 32 }, over)).toBe("nest");
    expect(resolveDropZone(false, { top: 100, height: 32 }, over)).toBe("before");
  });

  it("resolves 'before' above the band and 'after' below it", () => {
    const over = { top: 100, height: 32 };
    expect(resolveDropZone(true, { top: 0, height: 32 }, over)).toBe("before");
    expect(resolveDropZone(true, { top: 300, height: 32 }, over)).toBe("after");
  });
});

describe("Bucket type sanity", () => {
  it("only 'backlog' and 'today' are valid buckets", () => {
    const buckets: Bucket[] = ["backlog", "today"];
    expect(buckets).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// A task visible in both columns at once must be draggable from either,
// without id collision — the direct consequence of Backlog being
// comprehensive (decision 1) plus Today rendering the same rows (decision 6).
// ---------------------------------------------------------------------------
describe("computeTaskMove — a task visible in both columns can be dragged from either", () => {
  it("dragging its Backlog-column instance onto a Backlog target reorders normally", () => {
    const auto = makeTask({ id: "tsk_a", bucket: "backlog", inToday: true, dueAt: 1, projectId: "prj_1" });
    const sibling = makeTask({ id: "tsk_b", bucket: "backlog", projectId: "prj_1" });
    const b = board([auto, sibling]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a", inToday: true }),
      { kind: "task", taskId: "tsk_b", column: "backlog" },
      b,
      rowRect(5),
      rowRect(0),
    );
    expect(result?.kind).toBe("move");
  });

  it("dragging its Today-column instance onto a Backlog target dismisses it", () => {
    const auto = makeTask({ id: "tsk_a", bucket: "backlog", inToday: true, dueAt: 1, projectId: "prj_1" });
    const sibling = makeTask({ id: "tsk_b", bucket: "backlog", projectId: "prj_1" });
    const b = board([auto, sibling]);
    const result = computeTaskMove(
      fromToday({ taskId: "tsk_a", bucket: "backlog", inToday: true }),
      { kind: "task", taskId: "tsk_b", column: "backlog" },
      b,
      rowRect(5),
      rowRect(0),
    );
    expect(result).toEqual({ kind: "dismiss", id: "tsk_a" });
  });
});

describe("applyMoveToBoard", () => {
  it("returns the same board unchanged for a null outcome (no-op)", () => {
    const b = board([makeTask({ id: "tsk_a" })]);
    expect(applyMoveToBoard(b, null)).toBe(b);
  });

  it("entering Today with no target row: leaves sort_order untouched (stays at its array index)", () => {
    const first = makeTask({ id: "tsk_first", bucket: "backlog" });
    const a = makeTask({ id: "tsk_a", bucket: "backlog", projectId: "prj_1" });
    const last = makeTask({ id: "tsk_last", bucket: "backlog" });
    const b = board([first, a, last]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", bucket: "today", parentId: null, beforeId: null, afterId: null },
    };
    const next = applyMoveToBoard(b, outcome, "2026-08-27");

    // Same position, same length — no relocation happened.
    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_first", "tsk_a", "tsk_last"]);
    const patched = next.backlog[1];
    expect(patched.bucket).toBe("today");
    expect(patched.inToday).toBe(true);
    expect(patched.day).toBe("2026-08-27");
    expect(patched.projectId).toBe("prj_1");
  });

  it("leaving Today via snap-home: leaves sort_order, parent_id, and project_id untouched", () => {
    const other = makeTask({ id: "tsk_other", bucket: "backlog", projectId: "prj_2" });
    const scheduled = makeTask({ id: "tsk_a", bucket: "today", projectId: "prj_1", inToday: true, day: "2026-08-27" });
    const b = board([other, scheduled]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", bucket: "backlog", parentId: null, beforeId: null, afterId: null },
    };
    const next = applyMoveToBoard(b, outcome);

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_other", "tsk_a"]);
    const patched = next.backlog[1];
    expect(patched.bucket).toBe("backlog");
    expect(patched.inToday).toBe(false);
    expect(patched.day).toBeNull();
    expect(patched.projectId).toBe("prj_1");
  });

  it("an auto-included task dragged out of Today produces the dismiss outcome and NOT a moveTask", () => {
    const auto = makeTask({ id: "tsk_a", bucket: "backlog", inToday: true, dueAt: 1, projectId: "prj_1" });
    const b = board([auto]);
    const outcome = computeTaskMove(
      fromToday({ taskId: "tsk_a", bucket: "backlog", inToday: true }),
      { kind: "section", column: "backlog" },
      b,
    );
    expect(outcome).toEqual({ kind: "dismiss", id: "tsk_a" });

    const next = applyMoveToBoard(b, outcome);
    // bucket/parent/project/day untouched — only inToday flips.
    expect(next.backlog[0].bucket).toBe("backlog");
    expect(next.backlog[0].projectId).toBe("prj_1");
    expect(next.backlog[0].inToday).toBe(false);
    expect(next.backlog[0].dueAt).toBe(1);
  });

  it("reorder within a section: relocates within the same tree per beforeId/afterId", () => {
    const a = makeTask({ id: "tsk_a", bucket: "today", inToday: true });
    const bTask = makeTask({ id: "tsk_b", bucket: "today", inToday: true });
    const c = makeTask({ id: "tsk_c", bucket: "today", inToday: true });
    const brd = board([a, bTask, c]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_c", bucket: "today", parentId: null, beforeId: "tsk_a", afterId: null },
    };
    const next = applyMoveToBoard(brd, outcome);

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_c", "tsk_a", "tsk_b"]);
  });

  it("nesting: dropping a top-level task onto another makes it a subtask, removed from the top-level array", () => {
    const a = makeTask({ id: "tsk_a", bucket: "backlog" });
    const parent = makeTask({ id: "tsk_parent", bucket: "backlog" });
    const b = board([a, parent]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", bucket: "backlog", parentId: "tsk_parent", beforeId: null, afterId: null },
    };
    const next = applyMoveToBoard(b, outcome);

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_parent"]);
    const nextParent = next.backlog[0];
    expect(nextParent.subtasks.map((s) => s.id)).toEqual(["tsk_a"]);
    expect(nextParent.subtaskCounts.total).toBe(1);
    expect(nextParent.subtasks[0].parentId).toBe("tsk_parent");
    expect(nextParent.subtasks[0].bucket).toBe("backlog");
  });

  it("nesting a task that itself has subtasks promotes those children to top-level siblings", () => {
    const grandchild1 = makeTask({ id: "tsk_gc1", parentId: "tsk_a", bucket: "backlog" });
    const grandchild2 = makeTask({ id: "tsk_gc2", parentId: "tsk_a", bucket: "backlog" });
    const a = makeTask({
      id: "tsk_a",
      bucket: "backlog",
      subtasks: [grandchild1, grandchild2],
      subtaskCounts: { total: 2, done: 0 },
    });
    const parent = makeTask({ id: "tsk_parent", bucket: "backlog" });
    const b = board([a, parent]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", bucket: "backlog", parentId: "tsk_parent", beforeId: null, afterId: null },
    };
    const next = applyMoveToBoard(b, outcome);

    const nextParent = next.backlog.find((t) => t.id === "tsk_parent");
    expect(nextParent?.subtasks.map((s) => s.id)).toEqual(["tsk_a"]);
    const nestedA = nextParent?.subtasks[0];
    expect(nestedA?.subtasks).toEqual([]);
    expect(nestedA?.subtaskCounts).toEqual({ total: 0, done: 0 });

    const topIds = next.backlog.map((t) => t.id);
    expect(topIds).toContain("tsk_gc1");
    expect(topIds).toContain("tsk_gc2");
    const gc1 = next.backlog.find((t) => t.id === "tsk_gc1");
    const gc2 = next.backlog.find((t) => t.id === "tsk_gc2");
    expect(gc1?.parentId).toBeNull();
    expect(gc2?.parentId).toBeNull();
    expect(gc1?.bucket).toBe("backlog");
  });

  it("scheduling a parent into Today does NOT drag its subtasks along (invariant 4)", () => {
    const sub = makeTask({ id: "tsk_sub", parentId: "tsk_a", bucket: "backlog" });
    const a = makeTask({
      id: "tsk_a",
      bucket: "backlog",
      subtasks: [sub],
      subtaskCounts: { total: 1, done: 0 },
    });
    const b = board([a]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", bucket: "today", parentId: null, beforeId: null, afterId: null },
    };
    const next = applyMoveToBoard(b, outcome, "2026-08-20");

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_a"]);
    expect(next.backlog[0].bucket).toBe("today");
    expect(next.backlog[0].inToday).toBe(true);
    expect(next.backlog[0].day).toBe("2026-08-20");
    expect(next.backlog[0].subtasks.map((s) => s.id)).toEqual(["tsk_sub"]);
    expect(next.backlog[0].subtasks[0].bucket).toBe("backlog");
    expect(next.backlog[0].subtasks[0].inToday).toBe(false);
    expect(next.backlog[0].subtasks[0].day).toBeNull();
  });

  it("does not mutate the input board's arrays or task objects", () => {
    const sub = makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "backlog" });
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      subtasks: [sub],
      subtaskCounts: { total: 1, done: 0 },
    });
    const other = makeTask({ id: "tsk_other", bucket: "backlog" });
    const b = board([other, parent]);
    const snapshotBacklog = [...b.backlog];
    const snapshotParent = { ...parent, subtasks: [...parent.subtasks] };

    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_sub", bucket: "today", parentId: "tsk_parent", beforeId: null, afterId: null },
    };
    applyMoveToBoard(b, outcome);

    expect(b.backlog).toEqual(snapshotBacklog);
    expect(b.backlog.find((t) => t.id === "tsk_parent")).toEqual(snapshotParent);
    expect(b.backlog.find((t) => t.id === "tsk_parent")?.subtasks).toHaveLength(1);
    expect(b.backlog.find((t) => t.id === "tsk_parent")?.subtasks[0].id).toBe("tsk_sub");
    expect(b.backlog[0]).toBe(other);
  });

  it("a move for a task id not present on the given board is a no-op", () => {
    const b = board([makeTask({ id: "tsk_a" })]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_ghost", bucket: "today", parentId: null, beforeId: null, afterId: null },
    };
    expect(applyMoveToBoard(b, outcome)).toBe(b);
  });

  it("a dismiss for a task id not present on the given board is a no-op", () => {
    const b = board([makeTask({ id: "tsk_a" })]);
    expect(applyMoveToBoard(b, { kind: "dismiss", id: "tsk_ghost" })).toBe(b);
  });

  it("re-homing to a different project relocates the entry and writes the explicit projectId", () => {
    const a = makeTask({ id: "tsk_a", bucket: "backlog", projectId: "prj_1" });
    const inTarget = makeTask({ id: "tsk_in_prj2", bucket: "backlog", projectId: "prj_2" });
    const b = board([a, inTarget]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", bucket: "backlog", parentId: null, projectId: "prj_2", beforeId: null, afterId: "tsk_in_prj2" },
    };
    const next = applyMoveToBoard(b, outcome);

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_in_prj2", "tsk_a"]);
    expect(next.backlog[1].projectId).toBe("prj_2");
  });

  it("sets inToday in all four directions: entering, staying, leaving, dismissing", () => {
    // Entering.
    const enter = applyMoveToBoard(board([makeTask({ id: "tsk_a", bucket: "backlog" })]), {
      kind: "move",
      move: { id: "tsk_a", bucket: "today", parentId: null, beforeId: null, afterId: null },
    });
    expect(enter.backlog[0].inToday).toBe(true);

    // Staying (reorder within Today).
    const stay = applyMoveToBoard(
      board([
        makeTask({ id: "tsk_a", bucket: "today", inToday: true }),
        makeTask({ id: "tsk_b", bucket: "today", inToday: true }),
      ]),
      { kind: "move", move: { id: "tsk_a", bucket: "today", parentId: null, beforeId: null, afterId: "tsk_b" } },
    );
    expect(stay.backlog.find((t) => t.id === "tsk_a")?.inToday).toBe(true);

    // Leaving (snap-home).
    const leave = applyMoveToBoard(board([makeTask({ id: "tsk_a", bucket: "today", inToday: true })]), {
      kind: "move",
      move: { id: "tsk_a", bucket: "backlog", parentId: null, beforeId: null, afterId: null },
    });
    expect(leave.backlog[0].inToday).toBe(false);

    // Dismissing (auto-included).
    const dismiss = applyMoveToBoard(board([makeTask({ id: "tsk_a", bucket: "backlog", inToday: true })]), {
      kind: "dismiss",
      id: "tsk_a",
    });
    expect(dismiss.backlog[0].inToday).toBe(false);
    expect(dismiss.backlog[0].bucket).toBe("backlog"); // dismiss never touches bucket
  });
});
