import { describe, expect, it } from "vitest";
import type { TaskDto } from "@/contract";
import {
  applyMoveToBoard,
  computeTaskMove,
  resolveDropZone,
  type DragBoardTasks,
  type Bucket,
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
    ...overrides,
  };
}

/** A 32px-tall row at `index` in a simple vertical stack, matching how
 * dnd-kit reports rects for a list rendered top to bottom. */
function rowRect(index: number) {
  return { top: index * 32, height: 32 };
}

function emptyBoard(): DragBoardTasks {
  return { backlog: [], today: [] };
}

describe("computeTaskMove — cross-section (backlog <-> today)", () => {
  it("backlog -> today onto an empty Today body appends as the only item", () => {
    const board: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_a", bucket: "backlog" })],
      today: [],
    };
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "backlog" },
      { kind: "section", bucket: "today" },
      board,
    );
    expect(move).toEqual({
      id: "tsk_a",
      bucket: "today",
      parentId: null,
      beforeId: null,
      afterId: null,
    });
  });

  it("backlog -> today onto a populated Today body appends after the last row", () => {
    const board: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_a", bucket: "backlog" })],
      today: [
        makeTask({ id: "tsk_b", bucket: "today" }),
        makeTask({ id: "tsk_c", bucket: "today" }),
      ],
    };
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "backlog" },
      { kind: "section", bucket: "today" },
      board,
    );
    expect(move).toEqual({
      id: "tsk_a",
      bucket: "today",
      parentId: null,
      beforeId: null,
      afterId: "tsk_c",
    });
  });

  it("today -> backlog onto an empty Backlog body appends as the only item", () => {
    const board: DragBoardTasks = {
      backlog: [],
      today: [makeTask({ id: "tsk_a", bucket: "today" })],
    };
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "today" },
      { kind: "section", bucket: "backlog" },
      board,
    );
    expect(move).toEqual({
      id: "tsk_a",
      bucket: "backlog",
      parentId: null,
      beforeId: null,
      afterId: null,
    });
  });

  it("today -> backlog onto a populated Backlog body appends after the last row", () => {
    const board: DragBoardTasks = {
      backlog: [
        makeTask({ id: "tsk_x", bucket: "backlog" }),
        makeTask({ id: "tsk_y", bucket: "backlog" }),
      ],
      today: [makeTask({ id: "tsk_a", bucket: "today" })],
    };
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "today" },
      { kind: "section", bucket: "backlog" },
      board,
    );
    expect(move).toEqual({
      id: "tsk_a",
      bucket: "backlog",
      parentId: null,
      beforeId: null,
      afterId: "tsk_y",
    });
  });

  it("a cross-section move never keeps the source bucket — bucket always matches the destination", () => {
    const board: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_a", bucket: "backlog" })],
      today: [makeTask({ id: "tsk_target", bucket: "today" })],
    };
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "backlog" },
      { kind: "task", taskId: "tsk_target" },
      board,
      rowRect(5), // far below -> "after" zone
      rowRect(0),
    );
    expect(move?.bucket).toBe("today");
    expect(move?.bucket).not.toBe("backlog");
  });
});

describe("computeTaskMove — reorder within a section", () => {
  const board: DragBoardTasks = {
    backlog: [],
    today: [
      makeTask({ id: "tsk_a", bucket: "today" }),
      makeTask({ id: "tsk_b", bucket: "today" }),
      makeTask({ id: "tsk_c", bucket: "today" }),
    ],
  };

  it("dragging the last item to the top (before the first sibling)", () => {
    const move = computeTaskMove(
      { taskId: "tsk_c", parentId: null, bucket: "today" },
      { kind: "task", taskId: "tsk_a" },
      board,
      rowRect(0), // active rect coincides with / above the target -> "before"
      rowRect(1),
    );
    expect(move).toEqual({
      id: "tsk_c",
      bucket: "today",
      parentId: null,
      beforeId: "tsk_a",
      afterId: null,
    });
  });

  it("dragging the first item to the bottom (after the last sibling)", () => {
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "today" },
      { kind: "task", taskId: "tsk_c" },
      board,
      rowRect(5), // well below the target -> "after"
      rowRect(2),
    );
    expect(move).toEqual({
      id: "tsk_a",
      bucket: "today",
      parentId: null,
      beforeId: null,
      afterId: "tsk_c",
    });
  });

  it("dragging an outside item between two existing siblings", () => {
    const withExtra: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_d", bucket: "backlog" })],
      today: board.today,
    };
    // Drop "before" tsk_b, landing between tsk_a and tsk_b.
    const move = computeTaskMove(
      { taskId: "tsk_d", parentId: null, bucket: "backlog" },
      { kind: "task", taskId: "tsk_b" },
      withExtra,
      rowRect(0),
      rowRect(1),
    );
    expect(move).toEqual({
      id: "tsk_d",
      bucket: "today",
      parentId: null,
      beforeId: "tsk_b",
      afterId: "tsk_a",
    });
  });

  it("the dragged id is filtered out of its own sibling group, never appearing as beforeId/afterId", () => {
    // Drag tsk_b "after" tsk_c (its current next-neighbour's position) —
    // the resulting neighbours must never reference tsk_b itself.
    const move = computeTaskMove(
      { taskId: "tsk_b", parentId: null, bucket: "today" },
      { kind: "task", taskId: "tsk_c" },
      board,
      rowRect(5),
      rowRect(2),
    );
    expect(move).not.toBeNull();
    expect(move?.beforeId).not.toBe("tsk_b");
    expect(move?.afterId).not.toBe("tsk_b");
  });

  it("dropping a row onto itself is a no-op (null), not a self-referential move", () => {
    const move = computeTaskMove(
      { taskId: "tsk_b", parentId: null, bucket: "today" },
      { kind: "task", taskId: "tsk_b" },
      board,
      rowRect(1),
      rowRect(1),
    );
    expect(move).toBeNull();
  });
});

describe("computeTaskMove — nesting into a subtask", () => {
  it("dropping into the middle band of a top-level row nests under it", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "today",
      subtasks: [makeTask({ id: "tsk_sub1", parentId: "tsk_parent", bucket: "today" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const board: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_drag", bucket: "backlog" })],
      today: [parent],
    };
    // Same rect (dead center) -> squarely inside the nest band.
    const move = computeTaskMove(
      { taskId: "tsk_drag", parentId: null, bucket: "backlog" },
      { kind: "task", taskId: "tsk_parent" },
      board,
      rowRect(0),
      rowRect(0),
    );
    expect(move).toEqual({
      id: "tsk_drag",
      bucket: "today",
      parentId: "tsk_parent",
      beforeId: null,
      afterId: "tsk_sub1",
    });
  });

  it("nesting under a top-level row with no existing subtasks appends as its only subtask", () => {
    const board: DragBoardTasks = {
      backlog: [],
      today: [
        makeTask({ id: "tsk_parent", bucket: "today" }),
        makeTask({ id: "tsk_drag", bucket: "today" }),
      ],
    };
    const move = computeTaskMove(
      { taskId: "tsk_drag", parentId: null, bucket: "today" },
      { kind: "task", taskId: "tsk_parent" },
      board,
      rowRect(0),
      rowRect(0),
    );
    expect(move).toEqual({
      id: "tsk_drag",
      bucket: "today",
      parentId: "tsk_parent",
      beforeId: null,
      afterId: null,
    });
  });

  it("dropping onto a subtask never nests — depth stays 1", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "today",
      subtasks: [makeTask({ id: "tsk_sub1", parentId: "tsk_parent", bucket: "today" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const board: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_drag", bucket: "backlog" })],
      today: [parent],
    };
    // Dead-center rects — if subtasks were nestable this would be "nest".
    const move = computeTaskMove(
      { taskId: "tsk_drag", parentId: null, bucket: "backlog" },
      { kind: "task", taskId: "tsk_sub1" },
      board,
      rowRect(0),
      rowRect(0),
    );
    expect(move).not.toBeNull();
    // Promoted to a sibling of tsk_sub1 (parentId = the subtask's own
    // parent), never parented under the subtask itself.
    expect(move?.parentId).toBe("tsk_parent");
    expect(move?.parentId).not.toBe("tsk_sub1");
  });
});

describe("computeTaskMove — promoting a subtask to top-level", () => {
  it("dragging a subtask onto a section body promotes it (parentId: null)", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      subtasks: [makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "backlog" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const board: DragBoardTasks = { backlog: [parent], today: [] };
    const move = computeTaskMove(
      { taskId: "tsk_sub", parentId: "tsk_parent", bucket: "backlog" },
      { kind: "section", bucket: "today" },
      board,
    );
    expect(move).toEqual({
      id: "tsk_sub",
      bucket: "today",
      parentId: null,
      beforeId: null,
      afterId: null,
    });
  });

  it("dragging a subtask into the before/after zone of a top-level row promotes it", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      subtasks: [makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "backlog" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const otherTop = makeTask({ id: "tsk_other", bucket: "backlog" });
    const board: DragBoardTasks = { backlog: [parent, otherTop], today: [] };
    const move = computeTaskMove(
      { taskId: "tsk_sub", parentId: "tsk_parent", bucket: "backlog" },
      { kind: "task", taskId: "tsk_other" },
      board,
      rowRect(5), // well below -> "after"
      rowRect(1),
    );
    expect(move).toEqual({
      id: "tsk_sub",
      bucket: "backlog",
      parentId: null,
      beforeId: null,
      afterId: "tsk_other",
    });
  });
});

describe("computeTaskMove — a subtask reordering among its own siblings", () => {
  it("keeps parentId and computes beforeId/afterId from the parent's subtasks only", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "today",
      subtasks: [
        makeTask({ id: "tsk_s1", parentId: "tsk_parent", bucket: "today" }),
        makeTask({ id: "tsk_s2", parentId: "tsk_parent", bucket: "today" }),
        makeTask({ id: "tsk_s3", parentId: "tsk_parent", bucket: "today" }),
      ],
      subtaskCounts: { total: 3, done: 0 },
    });
    const board: DragBoardTasks = { backlog: [], today: [parent] };
    // Drag s3 to before s1 (top of its sibling group).
    const move = computeTaskMove(
      { taskId: "tsk_s3", parentId: "tsk_parent", bucket: "today" },
      { kind: "task", taskId: "tsk_s1" },
      board,
      rowRect(0),
      rowRect(1),
    );
    expect(move).toEqual({
      id: "tsk_s3",
      bucket: "today",
      parentId: "tsk_parent",
      beforeId: "tsk_s1",
      afterId: null,
    });
  });
});

describe("computeTaskMove — no-op edges", () => {
  const board: DragBoardTasks = {
    backlog: [makeTask({ id: "tsk_a", bucket: "backlog" })],
    today: [],
  };

  it("dropping on nothing (target: null) returns null", () => {
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "backlog" },
      null,
      board,
    );
    expect(move).toBeNull();
  });

  it("dropping on itself returns null", () => {
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "backlog" },
      { kind: "task", taskId: "tsk_a" },
      board,
    );
    expect(move).toBeNull();
  });

  it("dropping on an id no longer on the board returns null", () => {
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "backlog" },
      { kind: "task", taskId: "tsk_does_not_exist" },
      board,
    );
    expect(move).toBeNull();
  });

  it("an empty board with a section drop still resolves to a clean append", () => {
    const move = computeTaskMove(
      { taskId: "tsk_only", parentId: null, bucket: "backlog" },
      { kind: "section", bucket: "backlog" },
      emptyBoard(),
    );
    expect(move).toEqual({
      id: "tsk_only",
      bucket: "backlog",
      parentId: null,
      beforeId: null,
      afterId: null,
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

describe("applyMoveToBoard", () => {
  it("returns the same board unchanged for a null move (no-op)", () => {
    const board: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_a", bucket: "backlog" })],
      today: [],
    };
    expect(applyMoveToBoard(board, null)).toBe(board);
  });

  it("cross-section move: relocates a top-level task to the other bucket's array, updating its bucket", () => {
    const a = makeTask({ id: "tsk_a", bucket: "backlog" });
    const b = makeTask({ id: "tsk_b", bucket: "today" });
    const board: DragBoardTasks = { backlog: [a], today: [b] };
    const move: MoveTaskInput = {
      id: "tsk_a",
      bucket: "today",
      parentId: null,
      beforeId: null,
      afterId: "tsk_b",
    };
    const next = applyMoveToBoard(board, move);

    expect(next.backlog).toHaveLength(0);
    expect(next.today.map((t) => t.id)).toEqual(["tsk_b", "tsk_a"]);
    expect(next.today[1].bucket).toBe("today");
    expect(next.today[1].parentId).toBeNull();
  });

  it("reorder within a section: moves the task within the same top-level array per beforeId/afterId", () => {
    const a = makeTask({ id: "tsk_a", bucket: "today" });
    const b = makeTask({ id: "tsk_b", bucket: "today" });
    const c = makeTask({ id: "tsk_c", bucket: "today" });
    const board: DragBoardTasks = { backlog: [], today: [a, b, c] };
    const move: MoveTaskInput = {
      id: "tsk_c",
      bucket: "today",
      parentId: null,
      beforeId: "tsk_a",
      afterId: null,
    };
    const next = applyMoveToBoard(board, move);

    expect(next.today.map((t) => t.id)).toEqual(["tsk_c", "tsk_a", "tsk_b"]);
    expect(next.backlog).toBe(board.backlog);
  });

  it("nesting: dropping a top-level task onto another makes it a subtask, removed from the top-level array", () => {
    const a = makeTask({ id: "tsk_a", bucket: "backlog" });
    const parent = makeTask({ id: "tsk_parent", bucket: "backlog" });
    const board: DragBoardTasks = { backlog: [a, parent], today: [] };
    const move: MoveTaskInput = {
      id: "tsk_a",
      bucket: "backlog",
      parentId: "tsk_parent",
      beforeId: null,
      afterId: null,
    };
    const next = applyMoveToBoard(board, move);

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_parent"]);
    const nextParent = next.backlog[0];
    expect(nextParent.subtasks.map((s) => s.id)).toEqual(["tsk_a"]);
    expect(nextParent.subtaskCounts.total).toBe(1);
    expect(nextParent.subtasks[0].parentId).toBe("tsk_parent");
    expect(nextParent.subtasks[0].bucket).toBe("backlog");
  });

  it("promoting a subtask: dropping a subtask onto a section makes it top-level again", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "today",
      subtasks: [makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "today" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const board: DragBoardTasks = { backlog: [], today: [parent] };
    const move: MoveTaskInput = {
      id: "tsk_sub",
      bucket: "backlog",
      parentId: null,
      beforeId: null,
      afterId: null,
    };
    const next = applyMoveToBoard(board, move);

    expect(next.today[0].subtasks).toHaveLength(0);
    expect(next.today[0].subtaskCounts.total).toBe(0);
    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_sub"]);
    expect(next.backlog[0].parentId).toBeNull();
    expect(next.backlog[0].bucket).toBe("backlog");
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
    const board: DragBoardTasks = { backlog: [a, parent], today: [] };
    const move: MoveTaskInput = {
      id: "tsk_a",
      bucket: "backlog",
      parentId: "tsk_parent",
      beforeId: null,
      afterId: null,
    };
    const next = applyMoveToBoard(board, move);

    // tsk_a is now nested under tsk_parent, with no subtasks of its own
    // (subtasks are exactly one level deep — SPEC.md rule 2).
    const nextParent = next.backlog.find((t) => t.id === "tsk_parent");
    expect(nextParent?.subtasks.map((s) => s.id)).toEqual(["tsk_a"]);
    const nestedA = nextParent?.subtasks[0];
    expect(nestedA?.subtasks).toEqual([]);
    expect(nestedA?.subtaskCounts).toEqual({ total: 0, done: 0 });

    // tsk_a's former children are promoted to top-level siblings, placed
    // immediately after the parent they were nested under.
    const topIds = next.backlog.map((t) => t.id);
    expect(topIds).toContain("tsk_gc1");
    expect(topIds).toContain("tsk_gc2");
    const gc1 = next.backlog.find((t) => t.id === "tsk_gc1");
    const gc2 = next.backlog.find((t) => t.id === "tsk_gc2");
    expect(gc1?.parentId).toBeNull();
    expect(gc2?.parentId).toBeNull();
    expect(gc1?.bucket).toBe("backlog");
  });

  it("a parent moving (not being nested) carries its subtasks along, mirroring its new bucket", () => {
    const sub = makeTask({ id: "tsk_sub", parentId: "tsk_a", bucket: "backlog" });
    const a = makeTask({
      id: "tsk_a",
      bucket: "backlog",
      subtasks: [sub],
      subtaskCounts: { total: 1, done: 0 },
    });
    const board: DragBoardTasks = { backlog: [a], today: [] };
    const move: MoveTaskInput = {
      id: "tsk_a",
      bucket: "today",
      parentId: null,
      beforeId: null,
      afterId: null,
    };
    const next = applyMoveToBoard(board, move, "2026-08-20");

    expect(next.backlog).toHaveLength(0);
    expect(next.today.map((t) => t.id)).toEqual(["tsk_a"]);
    expect(next.today[0].bucket).toBe("today");
    expect(next.today[0].subtasks[0].bucket).toBe("today");
    expect(next.today[0].subtasks[0].day).toBe("2026-08-20");
  });

  it("does not mutate the input board's arrays or task objects", () => {
    const sub = makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "today" });
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "today",
      subtasks: [sub],
      subtaskCounts: { total: 1, done: 0 },
    });
    const other = makeTask({ id: "tsk_other", bucket: "backlog" });
    const board: DragBoardTasks = { backlog: [other], today: [parent] };
    const snapshotBacklog = [...board.backlog];
    const snapshotToday = [...board.today];
    const snapshotParent = { ...parent, subtasks: [...parent.subtasks] };

    const move: MoveTaskInput = {
      id: "tsk_sub",
      bucket: "backlog",
      parentId: null,
      beforeId: null,
      afterId: "tsk_other",
    };
    applyMoveToBoard(board, move);

    // The original arrays are untouched (still the same elements, same
    // order, same length) and the original parent object's own fields and
    // `subtasks` array are unchanged.
    expect(board.backlog).toEqual(snapshotBacklog);
    expect(board.today).toEqual(snapshotToday);
    expect(board.today[0]).toEqual(snapshotParent);
    expect(board.today[0].subtasks).toHaveLength(1);
    expect(board.today[0].subtasks[0].id).toBe("tsk_sub");
    expect(board.backlog[0]).toBe(other);
  });

  it("a move for a task id not present on the given board is a no-op", () => {
    const board: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_a", bucket: "backlog" })],
      today: [],
    };
    const move: MoveTaskInput = {
      id: "tsk_ghost",
      bucket: "today",
      parentId: null,
      beforeId: null,
      afterId: null,
    };
    expect(applyMoveToBoard(board, move)).toBe(board);
  });
});
