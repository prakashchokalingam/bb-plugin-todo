import { describe, expect, it } from "vitest";
import type { TaskDto } from "@/contract";
import {
  applyMoveToBoard,
  computeProjectReorder,
  computeTaskMove,
  dropZoneId,
  parseDropZoneId,
  resolveDropZone,
  type Column,
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
    stage: "pending",
    sortOrder: 1000,
    dueAt: null,
    hasDueTime: false,
    status: "open",
    completedAt: null,
    carriedDays: 0,
    createdAt: 0,
    updatedAt: 0,
    subtasks: [],
    subtaskCounts: { total: 0, done: 0 },
    tags: [],
    images: [],
    projectId: null,
    trail: null,
    inProgress: false,
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
 * common case in most of these tests — only the "leaving In Progress"/
 * "dismiss" tests need to construct one with `column: "in_progress"`
 * explicitly. */
function fromBacklog(task: Partial<DragTaskRef> & { taskId: string }): DragTaskRef {
  return { parentId: null, stage: "pending", inProgress: false, column: "backlog", ...task };
}

function fromInProgress(task: Partial<DragTaskRef> & { taskId: string }): DragTaskRef {
  return { parentId: null, stage: "in_progress", inProgress: true, column: "in_progress", ...task };
}

describe("dropZoneId / parseDropZoneId", () => {
  it("round-trips a section id", () => {
    const id = dropZoneId("section", "in_progress");
    expect(id).toBe("section:in_progress:");
    expect(parseDropZoneId(id)).toEqual({ kind: "section", column: "in_progress", targetId: "" });
  });

  it("round-trips a project id, distinctly per column", () => {
    const backlogId = dropZoneId("project", "backlog", "prj_1");
    const inProgressId = dropZoneId("project", "in_progress", "prj_1");
    expect(backlogId).not.toBe(inProgressId);
    expect(parseDropZoneId(backlogId)).toEqual({ kind: "project", column: "backlog", targetId: "prj_1" });
    expect(parseDropZoneId(inProgressId)).toEqual({ kind: "project", column: "in_progress", targetId: "prj_1" });
  });

  it("round-trips a task id, distinctly per column, so the same task can be a drop target from either column", () => {
    const backlogId = dropZoneId("task", "backlog", "tsk_1");
    const inProgressId = dropZoneId("task", "in_progress", "tsk_1");
    expect(backlogId).not.toBe(inProgressId);
    expect(parseDropZoneId(backlogId)?.column).toBe("backlog");
    expect(parseDropZoneId(inProgressId)?.column).toBe("in_progress");
  });

  it("returns null for an id from an unrelated scheme", () => {
    expect(parseDropZoneId("tsk_1")).toBeNull();
    expect(parseDropZoneId("in_progress:tsk_1")).toBeNull();
    expect(parseDropZoneId("bogus:backlog:tsk_1")).toBeNull();
    expect(parseDropZoneId("project:north:prj_1")).toBeNull();
  });
});

describe("computeTaskMove — Backlog row -> In Progress column, no specific target row", () => {
  it("flips stage and keeps a project task parentless, with no order write", () => {
    const task = makeTask({ id: "tsk_a", stage: "pending", projectId: "prj_1" });
    const b = board([task]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a" }),
      { kind: "section", column: "in_progress" },
      b,
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", stage: "in_progress", parentId: null, beforeId: null, afterId: null },
    });
    expect((result as { kind: "move"; move: MoveTaskInput }).move).not.toHaveProperty("projectId");
  });

  it("CENTRAL FIX — a subtask keeps its parentId (was: nulled)", () => {
    const parent = makeTask({
      id: "tsk_parent",
      stage: "pending",
      projectId: "prj_1",
      subtasks: [makeTask({ id: "tsk_sub", parentId: "tsk_parent", stage: "pending", projectId: "prj_1" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const b = board([parent]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_sub", parentId: "tsk_parent" }),
      { kind: "section", column: "in_progress" },
      b,
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_sub", stage: "in_progress", parentId: "tsk_parent", beforeId: null, afterId: null },
    });
  });

  it("no order write even when other tasks already sit in In Progress (regression: must not append to bottom)", () => {
    const already = makeTask({ id: "tsk_already", stage: "in_progress", inProgress: true });
    const dragged = makeTask({ id: "tsk_a", stage: "pending" });
    const b = board([already, dragged]);
    const result = computeTaskMove(fromBacklog({ taskId: "tsk_a" }), { kind: "section", column: "in_progress" }, b);
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", stage: "in_progress", parentId: null, beforeId: null, afterId: null },
    });
  });
});

describe("computeTaskMove — Backlog row -> In Progress, near a specific row", () => {
  it("flags scheduled and interpolates order from the HOME sibling group (the dragged task's OWN project, not the target's)", () => {
    const sibling1 = makeTask({ id: "tsk_s1", stage: "pending", projectId: "prj_1" });
    const sibling2 = makeTask({ id: "tsk_s2", stage: "pending", projectId: "prj_1" });
    const dragged = makeTask({ id: "tsk_a", stage: "pending", projectId: "prj_1" });
    const b = board([sibling1, sibling2, dragged]);
    // Drop tsk_a "before" sibling2, in the In Progress column. sibling2 is a
    // genuine member of tsk_a's own home group (same project), so it's a
    // usable order reference.
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a" }),
      { kind: "task", taskId: "tsk_s2", column: "in_progress" },
      b,
      rowRect(0),
      rowRect(1),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", stage: "in_progress", parentId: null, beforeId: "tsk_s2", afterId: "tsk_s1" },
    });
    expect((result as { kind: "move"; move: MoveTaskInput }).move).not.toHaveProperty("projectId");
  });

  it("a subtask entering In Progress near a row keeps its parentId (central fix, near-row route)", () => {
    const sibling = makeTask({ id: "tsk_sib", parentId: "tsk_parent", stage: "pending", projectId: "prj_1" });
    const parent = makeTask({
      id: "tsk_parent",
      stage: "pending",
      projectId: "prj_1",
      subtasks: [
        sibling,
        makeTask({ id: "tsk_sub", parentId: "tsk_parent", stage: "pending", projectId: "prj_1" }),
      ],
      subtaskCounts: { total: 2, done: 0 },
    });
    const b = board([parent]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_sub", parentId: "tsk_parent" }),
      { kind: "task", taskId: "tsk_sib", column: "in_progress" },
      b,
      rowRect(5), // after
      rowRect(0),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_sub", stage: "in_progress", parentId: "tsk_parent", beforeId: null, afterId: "tsk_sib" },
    });
  });

  it("degrades to no order write when the target row isn't a member of the dragged task's own home group", () => {
    // tsk_other belongs to a different (no) project and isn't a sibling of
    // tsk_a's home group — there's no meaningful position reference, so the
    // server's home-scoped sibling lookup would ignore beforeId/afterId
    // anyway; this must not send a stale/meaningless reference.
    const dragged = makeTask({ id: "tsk_a", stage: "pending", projectId: "prj_1" });
    const unrelated = makeTask({ id: "tsk_other", stage: "in_progress", inProgress: true, projectId: "prj_2" });
    const b = board([dragged, unrelated]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a" }),
      { kind: "task", taskId: "tsk_other", column: "in_progress" },
      b,
      rowRect(5),
      rowRect(0),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", stage: "in_progress", parentId: null, beforeId: null, afterId: null },
    });
  });
});

describe("computeTaskMove — In Progress row -> Backlog, stage === 'in_progress' (existing snap-home path)", () => {
  it("snaps home regardless of where it's dropped in the Backlog column", () => {
    const scheduled = makeTask({ id: "tsk_a", stage: "in_progress", projectId: "prj_1", inProgress: true });
    const other = makeTask({ id: "tsk_b", stage: "pending", projectId: "prj_2" });
    const b = board([scheduled, other]);
    const result = computeTaskMove(
      fromInProgress({ taskId: "tsk_a" }),
      { kind: "task", taskId: "tsk_b", column: "backlog" },
      b,
      rowRect(5),
      rowRect(0),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", stage: "pending", parentId: null, beforeId: null, afterId: null },
    });
    expect((result as { kind: "move"; move: MoveTaskInput }).move).not.toHaveProperty("projectId");
  });

  it("snaps home on a bare section-body drop too", () => {
    const scheduled = makeTask({ id: "tsk_a", stage: "in_progress", inProgress: true });
    const b = board([scheduled]);
    const result = computeTaskMove(fromInProgress({ taskId: "tsk_a" }), { kind: "section", column: "backlog" }, b);
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", stage: "pending", parentId: null, beforeId: null, afterId: null },
    });
  });

  it("leaves sort_order, parent_id, and project_id untouched (asserted via the omitted fields / null position)", () => {
    const scheduled = makeTask({ id: "tsk_a", parentId: null, stage: "in_progress", projectId: "prj_1", inProgress: true });
    const b = board([scheduled]);
    const result = computeTaskMove(fromInProgress({ taskId: "tsk_a" }), { kind: "section", column: "backlog" }, b) as {
      kind: "move";
      move: MoveTaskInput;
    };
    expect(result.move.beforeId).toBeNull();
    expect(result.move.afterId).toBeNull();
    expect(result.move.projectId).toBeUndefined();
    expect(result.move.parentId).toBeNull();
  });

  it("reordering an inProgress task from its Backlog-column instance is an ordinary reorder, NOT a snap-home", () => {
    // Same underlying task, same stage, but dragged from the BACKLOG
    // column this time — column, not stage, decides "leaving In Progress".
    const scheduled = makeTask({ id: "tsk_a", stage: "in_progress", projectId: "prj_1", inProgress: true });
    const sibling = makeTask({ id: "tsk_b", stage: "pending", projectId: "prj_1" });
    const b = board([scheduled, sibling]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a", stage: "in_progress", inProgress: true }),
      { kind: "task", taskId: "tsk_b", column: "backlog" },
      b,
      rowRect(5),
      rowRect(0),
    );
    // A real reorder: afterId points at tsk_b, not the null/null snap-home shape.
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", stage: "pending", parentId: null, projectId: "prj_1", beforeId: null, afterId: "tsk_b" },
    });
  });
});

describe("computeTaskMove — In Progress row -> Backlog, auto-included only (stage 'pending' && inProgress)", () => {
  it("produces a dismiss outcome, not a moveTask", () => {
    const auto = makeTask({ id: "tsk_a", stage: "pending", inProgress: true, dueAt: 1000 });
    const other = makeTask({ id: "tsk_b", stage: "pending" });
    const b = board([auto, other]);
    const result = computeTaskMove(
      fromInProgress({ taskId: "tsk_a", stage: "pending", inProgress: true }),
      { kind: "task", taskId: "tsk_b", column: "backlog" },
      b,
      rowRect(5),
      rowRect(0),
    );
    expect(result).toEqual({ kind: "dismiss", id: "tsk_a" });
  });

  it("dismisses on a bare section-body drop too", () => {
    const auto = makeTask({ id: "tsk_a", stage: "pending", inProgress: true, dueAt: 1000 });
    const b = board([auto]);
    const result = computeTaskMove(
      fromInProgress({ taskId: "tsk_a", stage: "pending", inProgress: true }),
      { kind: "section", column: "backlog" },
      b,
    );
    expect(result).toEqual({ kind: "dismiss", id: "tsk_a" });
  });

  it("does NOT dismiss when the same task is reordered from its Backlog-column instance", () => {
    const auto = makeTask({ id: "tsk_a", stage: "pending", inProgress: true, dueAt: 1000, projectId: "prj_1" });
    const sibling = makeTask({ id: "tsk_b", stage: "pending", projectId: "prj_1" });
    const b = board([auto, sibling]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a", inProgress: true }),
      { kind: "task", taskId: "tsk_b", column: "backlog" },
      b,
      rowRect(5),
      rowRect(0),
    );
    expect(result?.kind).toBe("move");
  });
});

describe("computeTaskMove — In Progress project A -> project B (re-home, sort_order only, stage unchanged)", () => {
  it("stays in In Progress: stage remains 'in_progress', project changes, order appended in the target project", () => {
    const scheduled = makeTask({ id: "tsk_a", stage: "in_progress", projectId: "prj_1", inProgress: true });
    const inTargetProject = makeTask({ id: "tsk_in_prj2", stage: "pending", projectId: "prj_2" });
    const b = board([scheduled, inTargetProject]);
    const result = computeTaskMove(
      fromInProgress({ taskId: "tsk_a" }),
      { kind: "project", projectId: "prj_2", column: "in_progress" },
      b,
    );
    expect(result).toEqual({
      kind: "move",
      move: {
        id: "tsk_a",
        stage: "in_progress",
        parentId: null,
        projectId: "prj_2",
        beforeId: null,
        afterId: "tsk_in_prj2",
      },
    });
  });

  it("dropping on a different project's header in the BACKLOG column unschedules AND re-homes", () => {
    const scheduled = makeTask({ id: "tsk_a", stage: "in_progress", projectId: "prj_1", inProgress: true });
    const b = board([scheduled]);
    const result = computeTaskMove(
      fromInProgress({ taskId: "tsk_a" }),
      { kind: "project", projectId: "prj_2", column: "backlog" },
      b,
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_a", stage: "pending", parentId: null, projectId: "prj_2", beforeId: null, afterId: null },
    });
  });
});

describe("computeTaskMove — reorder within In Progress, same project", () => {
  it("plain reorder among home siblings", () => {
    const a = makeTask({ id: "tsk_a", stage: "in_progress", projectId: "prj_1", inProgress: true });
    const bTask = makeTask({ id: "tsk_b", stage: "in_progress", projectId: "prj_1", inProgress: true });
    const c = makeTask({ id: "tsk_c", stage: "in_progress", projectId: "prj_1", inProgress: true });
    const brd = board([a, bTask, c]);
    const result = computeTaskMove(
      fromInProgress({ taskId: "tsk_c" }),
      { kind: "task", taskId: "tsk_a", column: "in_progress" },
      brd,
      rowRect(0),
      rowRect(1),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_c", stage: "in_progress", parentId: null, beforeId: "tsk_a", afterId: null },
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
  it("dropping into the middle band of a top-level row nests under it, stage following the target column", () => {
    const parent = makeTask({
      id: "tsk_parent",
      stage: "in_progress",
      inProgress: true,
      subtasks: [makeTask({ id: "tsk_sub1", parentId: "tsk_parent", stage: "pending" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const dragged = makeTask({ id: "tsk_drag", stage: "pending" });
    const b = board([parent, dragged]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_drag" }),
      { kind: "task", taskId: "tsk_parent", column: "in_progress" },
      b,
      rowRect(0),
      rowRect(0),
    );
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_drag", stage: "in_progress", parentId: "tsk_parent", beforeId: null, afterId: "tsk_sub1" },
    });
  });

  it("nesting under a top-level row with no existing subtasks appends as its only subtask", () => {
    const parent = makeTask({ id: "tsk_parent", stage: "pending" });
    const dragged = makeTask({ id: "tsk_drag", stage: "pending" });
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
      move: { id: "tsk_drag", stage: "pending", parentId: "tsk_parent", beforeId: null, afterId: null },
    });
  });

  it("dropping onto a subtask never nests — depth stays 1", () => {
    const parent = makeTask({
      id: "tsk_parent",
      stage: "pending",
      subtasks: [makeTask({ id: "tsk_sub1", parentId: "tsk_parent", stage: "pending" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const dragged = makeTask({ id: "tsk_drag", stage: "pending" });
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
      stage: "pending",
      subtasks: [makeTask({ id: "tsk_sub", parentId: "tsk_parent", stage: "pending" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const otherTop = makeTask({ id: "tsk_other", stage: "pending" });
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
      move: { id: "tsk_sub", stage: "pending", parentId: null, projectId: null, beforeId: null, afterId: "tsk_other" },
    });
  });
});

describe("computeTaskMove — a subtask reordering among its own siblings", () => {
  it("keeps parentId and computes beforeId/afterId from the real (backlog-tree) sibling group", () => {
    const s1 = makeTask({ id: "tsk_s1", parentId: "tsk_parent", stage: "pending" });
    const s2 = makeTask({ id: "tsk_s2", parentId: "tsk_parent", stage: "pending" });
    const s3 = makeTask({ id: "tsk_s3", parentId: "tsk_parent", stage: "pending" });
    const parent = makeTask({
      id: "tsk_parent",
      stage: "pending",
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
    // `toEqual` alone would NOT catch `projectId: undefined` sneaking into
    // `move` (vitest's `toEqual` treats an undefined-valued key as absent),
    // which is exactly how this scenario used to slip a literal `undefined`
    // into the RPC payload and blow up the SDK's JSON validator. Pin it down
    // explicitly: the key must be genuinely absent, not present-but-undefined.
    expect(result).toEqual({
      kind: "move",
      move: { id: "tsk_s3", stage: "pending", parentId: "tsk_parent", beforeId: "tsk_s1", afterId: null },
    });
    expect((result as { kind: "move"; move: MoveTaskInput }).move).not.toHaveProperty("projectId");
  });
});

describe("computeTaskMove — dropping a top-level task onto a subtask (regression)", () => {
  // Reproduces the reported runtime error: "rpc input at $input.projectId is
  // not a JSON value". Dropping a dragged task next to a row whose
  // `parentId !== null` (a subtask) used to compute `projectId: undefined`
  // and put that literal key/value into the returned `move`, which the SDK's
  // JSON validator rejects because `.optional()` in the contract means "key
  // absent", not "present with an undefined value".
  it("dropping a plain top-level task next to a subtask omits projectId entirely, no undefined values anywhere", () => {
    const sub = makeTask({ id: "tsk_sub", parentId: "tsk_parent", stage: "pending" });
    const parent = makeTask({
      id: "tsk_parent",
      stage: "pending",
      projectId: "prj_1",
      subtasks: [sub],
      subtaskCounts: { total: 1, done: 0 },
    });
    const dragged = makeTask({ id: "tsk_drag", stage: "pending", projectId: "prj_2" });
    const b = board([parent, dragged]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_drag" }),
      { kind: "task", taskId: "tsk_sub", column: "backlog" },
      b,
      rowRect(0),
      rowRect(0),
    ) as { kind: "move"; move: MoveTaskInput };

    expect(result.kind).toBe("move");
    // The key must be genuinely absent, not present-but-undefined — this is
    // the exact distinction `toEqual` alone cannot pin down.
    expect(result.move).not.toHaveProperty("projectId");
    expect(Object.values(result.move).every((v) => v !== undefined)).toBe(true);
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
      move: { id: "tsk_only", stage: "pending", parentId: null, projectId: null, beforeId: null, afterId: null },
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

describe("Column type sanity", () => {
  it("only 'backlog' and 'in_progress' are valid columns", () => {
    const columns: Column[] = ["backlog", "in_progress"];
    expect(columns).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// A task visible in both columns at once must be draggable from either,
// without id collision — the direct consequence of Backlog being
// comprehensive (decision 1) plus In Progress rendering the same rows (decision 6).
// ---------------------------------------------------------------------------
describe("computeTaskMove — a task visible in both columns can be dragged from either", () => {
  it("dragging its Backlog-column instance onto a Backlog target reorders normally", () => {
    const auto = makeTask({ id: "tsk_a", stage: "pending", inProgress: true, dueAt: 1, projectId: "prj_1" });
    const sibling = makeTask({ id: "tsk_b", stage: "pending", projectId: "prj_1" });
    const b = board([auto, sibling]);
    const result = computeTaskMove(
      fromBacklog({ taskId: "tsk_a", inProgress: true }),
      { kind: "task", taskId: "tsk_b", column: "backlog" },
      b,
      rowRect(5),
      rowRect(0),
    );
    expect(result?.kind).toBe("move");
  });

  it("dragging its In Progress-column instance onto a Backlog target dismisses it", () => {
    const auto = makeTask({ id: "tsk_a", stage: "pending", inProgress: true, dueAt: 1, projectId: "prj_1" });
    const sibling = makeTask({ id: "tsk_b", stage: "pending", projectId: "prj_1" });
    const b = board([auto, sibling]);
    const result = computeTaskMove(
      fromInProgress({ taskId: "tsk_a", stage: "pending", inProgress: true }),
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

  it("entering In Progress with no target row: leaves sort_order untouched (stays at its array index)", () => {
    const first = makeTask({ id: "tsk_first", stage: "pending" });
    const a = makeTask({ id: "tsk_a", stage: "pending", projectId: "prj_1" });
    const last = makeTask({ id: "tsk_last", stage: "pending" });
    const b = board([first, a, last]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", stage: "in_progress", parentId: null, beforeId: null, afterId: null },
    };
    const next = applyMoveToBoard(b, outcome);

    // Same position, same length — no relocation happened.
    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_first", "tsk_a", "tsk_last"]);
    const patched = next.backlog[1];
    expect(patched.stage).toBe("in_progress");
    expect(patched.inProgress).toBe(true);
    expect(patched.projectId).toBe("prj_1");
  });

  it("leaving In Progress via snap-home: leaves sort_order, parent_id, and project_id untouched", () => {
    const other = makeTask({ id: "tsk_other", stage: "pending", projectId: "prj_2" });
    const scheduled = makeTask({ id: "tsk_a", stage: "in_progress", projectId: "prj_1", inProgress: true });
    const b = board([other, scheduled]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", stage: "pending", parentId: null, beforeId: null, afterId: null },
    };
    const next = applyMoveToBoard(b, outcome);

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_other", "tsk_a"]);
    const patched = next.backlog[1];
    expect(patched.stage).toBe("pending");
    expect(patched.inProgress).toBe(false);
    expect(patched.projectId).toBe("prj_1");
  });

  // `stage: "pending"` + `inProgress: true` is no longer a reachable domain
  // state (membership is solely stage-based now), so `computeTaskMove` can
  // never actually produce a "dismiss" outcome in practice — but
  // `applyMoveToBoard` still supports one structurally (see its doc
  // comment), so this exercises that harmless dead path directly with a
  // hand-built outcome rather than a real drag gesture.
  it("a hand-built dismiss outcome patches only inProgress, leaving stage/parent/project untouched", () => {
    const task = makeTask({ id: "tsk_a", stage: "pending", inProgress: true, dueAt: 1, projectId: "prj_1" });
    const b = board([task]);
    const outcome: ComputeMoveResult = { kind: "dismiss", id: "tsk_a" };

    const next = applyMoveToBoard(b, outcome);
    expect(next.backlog[0].stage).toBe("pending");
    expect(next.backlog[0].projectId).toBe("prj_1");
    expect(next.backlog[0].inProgress).toBe(false);
    expect(next.backlog[0].dueAt).toBe(1);
  });

  it("reorder within a section: relocates within the same tree per beforeId/afterId", () => {
    const a = makeTask({ id: "tsk_a", stage: "in_progress", inProgress: true });
    const bTask = makeTask({ id: "tsk_b", stage: "in_progress", inProgress: true });
    const c = makeTask({ id: "tsk_c", stage: "in_progress", inProgress: true });
    const brd = board([a, bTask, c]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_c", stage: "in_progress", parentId: null, beforeId: "tsk_a", afterId: null },
    };
    const next = applyMoveToBoard(brd, outcome);

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_c", "tsk_a", "tsk_b"]);
  });

  it("nesting: dropping a top-level task onto another makes it a subtask, removed from the top-level array", () => {
    const a = makeTask({ id: "tsk_a", stage: "pending" });
    const parent = makeTask({ id: "tsk_parent", stage: "pending" });
    const b = board([a, parent]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", stage: "pending", parentId: "tsk_parent", beforeId: null, afterId: null },
    };
    const next = applyMoveToBoard(b, outcome);

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_parent"]);
    const nextParent = next.backlog[0];
    expect(nextParent.subtasks.map((s) => s.id)).toEqual(["tsk_a"]);
    expect(nextParent.subtaskCounts.total).toBe(1);
    expect(nextParent.subtasks[0].parentId).toBe("tsk_parent");
    expect(nextParent.subtasks[0].stage).toBe("pending");
  });

  it("nesting a task that itself has subtasks promotes those children to top-level siblings", () => {
    const grandchild1 = makeTask({ id: "tsk_gc1", parentId: "tsk_a", stage: "pending" });
    const grandchild2 = makeTask({ id: "tsk_gc2", parentId: "tsk_a", stage: "pending" });
    const a = makeTask({
      id: "tsk_a",
      stage: "pending",
      subtasks: [grandchild1, grandchild2],
      subtaskCounts: { total: 2, done: 0 },
    });
    const parent = makeTask({ id: "tsk_parent", stage: "pending" });
    const b = board([a, parent]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", stage: "pending", parentId: "tsk_parent", beforeId: null, afterId: null },
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
    expect(gc1?.stage).toBe("pending");
  });

  it("scheduling a parent into In Progress does NOT drag its subtasks along (invariant 4)", () => {
    const sub = makeTask({ id: "tsk_sub", parentId: "tsk_a", stage: "pending" });
    const a = makeTask({
      id: "tsk_a",
      stage: "pending",
      subtasks: [sub],
      subtaskCounts: { total: 1, done: 0 },
    });
    const b = board([a]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", stage: "in_progress", parentId: null, beforeId: null, afterId: null },
    };
    const next = applyMoveToBoard(b, outcome);

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_a"]);
    expect(next.backlog[0].stage).toBe("in_progress");
    expect(next.backlog[0].inProgress).toBe(true);
    expect(next.backlog[0].subtasks.map((s) => s.id)).toEqual(["tsk_sub"]);
    expect(next.backlog[0].subtasks[0].stage).toBe("pending");
    expect(next.backlog[0].subtasks[0].inProgress).toBe(false);
  });

  it("does not mutate the input board's arrays or task objects", () => {
    const sub = makeTask({ id: "tsk_sub", parentId: "tsk_parent", stage: "pending" });
    const parent = makeTask({
      id: "tsk_parent",
      stage: "pending",
      subtasks: [sub],
      subtaskCounts: { total: 1, done: 0 },
    });
    const other = makeTask({ id: "tsk_other", stage: "pending" });
    const b = board([other, parent]);
    const snapshotBacklog = [...b.backlog];
    const snapshotParent = { ...parent, subtasks: [...parent.subtasks] };

    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_sub", stage: "in_progress", parentId: "tsk_parent", beforeId: null, afterId: null },
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
      move: { id: "tsk_ghost", stage: "in_progress", parentId: null, beforeId: null, afterId: null },
    };
    expect(applyMoveToBoard(b, outcome)).toBe(b);
  });

  it("a dismiss for a task id not present on the given board is a no-op", () => {
    const b = board([makeTask({ id: "tsk_a" })]);
    expect(applyMoveToBoard(b, { kind: "dismiss", id: "tsk_ghost" })).toBe(b);
  });

  it("re-homing to a different project relocates the entry and writes the explicit projectId", () => {
    const a = makeTask({ id: "tsk_a", stage: "pending", projectId: "prj_1" });
    const inTarget = makeTask({ id: "tsk_in_prj2", stage: "pending", projectId: "prj_2" });
    const b = board([a, inTarget]);
    const outcome: ComputeMoveResult = {
      kind: "move",
      move: { id: "tsk_a", stage: "pending", parentId: null, projectId: "prj_2", beforeId: null, afterId: "tsk_in_prj2" },
    };
    const next = applyMoveToBoard(b, outcome);

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_in_prj2", "tsk_a"]);
    expect(next.backlog[1].projectId).toBe("prj_2");
  });

  it("sets inProgress in all four directions: entering, staying, leaving, dismissing", () => {
    // Entering.
    const enter = applyMoveToBoard(board([makeTask({ id: "tsk_a", stage: "pending" })]), {
      kind: "move",
      move: { id: "tsk_a", stage: "in_progress", parentId: null, beforeId: null, afterId: null },
    });
    expect(enter.backlog[0].inProgress).toBe(true);

    // Staying (reorder within In Progress).
    const stay = applyMoveToBoard(
      board([
        makeTask({ id: "tsk_a", stage: "in_progress", inProgress: true }),
        makeTask({ id: "tsk_b", stage: "in_progress", inProgress: true }),
      ]),
      { kind: "move", move: { id: "tsk_a", stage: "in_progress", parentId: null, beforeId: null, afterId: "tsk_b" } },
    );
    expect(stay.backlog.find((t) => t.id === "tsk_a")?.inProgress).toBe(true);

    // Leaving (snap-home).
    const leave = applyMoveToBoard(board([makeTask({ id: "tsk_a", stage: "in_progress", inProgress: true })]), {
      kind: "move",
      move: { id: "tsk_a", stage: "pending", parentId: null, beforeId: null, afterId: null },
    });
    expect(leave.backlog[0].inProgress).toBe(false);

    // Dismissing (auto-included).
    const dismiss = applyMoveToBoard(board([makeTask({ id: "tsk_a", stage: "pending", inProgress: true })]), {
      kind: "dismiss",
      id: "tsk_a",
    });
    expect(dismiss.backlog[0].inProgress).toBe(false);
    expect(dismiss.backlog[0].stage).toBe("pending"); // dismiss never touches stage
  });
});
