import { describe, expect, it } from "vitest";
import type { TaskDto } from "@/contract";
import {
  applyMoveToBoard,
  computeProjectReorder,
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
    projectId: null,
    trail: null,
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

  // CHANGED — drag matrix "Today row -> Backlog (anywhere): unschedule;
  // snaps home to its own project slot (NOT the drop position)". The old
  // expectation appended the row at the end of the Backlog body; the new
  // rule deliberately ignores drop position and leaves sort_order alone
  // (moveTask's snapHome branch), so beforeId/afterId are both null and
  // projectId is omitted rather than recomputed from the drop.
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

  // CHANGED — same snap-home rule as above; a populated Backlog body no
  // longer changes the outcome, since position is never computed for a
  // Today-sourced drop into Backlog.
  it("today -> backlog onto a populated Backlog body snaps home, ignoring the drop position", () => {
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
      afterId: null,
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
    // CHANGED — fixture only: bucket "today" -> "backlog". Per Phase 3
    // deviation #1 ("Today is genuinely flat"), a Today row's `.subtasks`
    // is always []; a real nested subtask (as this depth-cap test needs)
    // can only exist in the Backlog home tree. The assertion itself is
    // untouched — this test is about the depth cap, not about Today.
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      subtasks: [makeTask({ id: "tsk_sub1", parentId: "tsk_parent", bucket: "backlog" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const board: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_drag", bucket: "backlog" }), parent],
      today: [],
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

describe("computeTaskMove — the central fix: subtask -> Today keeps parentId", () => {
  // This is the bug the design doc names directly: "lib/drag.ts:106 ...
  // sends parentId: null on every cross-bucket drop — so the loss is
  // client-side". Drag matrix: "subtask -> Today: flag scheduled; parent_id
  // KEPT". Both routes into Today (dropping on the section body, and
  // dropping near an existing Today row) must preserve it.

  it("CENTRAL FIX — dropping a subtask on the Today section body keeps its parentId (was: nulled)", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      projectId: "prj_1",
      subtasks: [makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "backlog", projectId: "prj_1" })],
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
      parentId: "tsk_parent",
      beforeId: null,
      afterId: null,
    });
  });

  it("CENTRAL FIX — dropping a subtask near an existing Today row also keeps its parentId", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      projectId: "prj_1",
      subtasks: [makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "backlog", projectId: "prj_1" })],
      subtaskCounts: { total: 1, done: 0 },
    });
    const board: DragBoardTasks = {
      backlog: [parent],
      today: [makeTask({ id: "tsk_other", bucket: "today" })],
    };
    const move = computeTaskMove(
      { taskId: "tsk_sub", parentId: "tsk_parent", bucket: "backlog" },
      { kind: "task", taskId: "tsk_other" },
      board,
      rowRect(5), // well below -> "after"
      rowRect(0),
    );
    expect(move).toEqual({
      id: "tsk_sub",
      bucket: "today",
      parentId: "tsk_parent",
      beforeId: null,
      afterId: "tsk_other",
    });
  });

  it("project task -> Today: parentId stays null and projectId is omitted (ghost stays put)", () => {
    const task = makeTask({ id: "tsk_a", bucket: "backlog", projectId: "prj_1" });
    const board: DragBoardTasks = { backlog: [task], today: [] };
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
    expect(move).not.toHaveProperty("projectId");
  });
});

describe("computeTaskMove — promoting a subtask to top-level (Backlog only)", () => {
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
      projectId: null,
      beforeId: null,
      afterId: "tsk_other",
    });
  });
});

describe("computeTaskMove — a subtask reordering among its own siblings", () => {
  // CHANGED — Phase 3 deviation #1: Today is genuinely flat (buildTodayDto
  // forces subtasks: [] on every Today row), so a scheduled subtask never
  // sits nested inside a Today parent's `.subtasks`; it's its own flat
  // top-level entry, still carrying its real parentId. This fixture models
  // that: three flat Today entries that happen to share a parentId, rather
  // than one Today parent with a real nested `.subtasks` array. The
  // resolved move is unchanged in shape (parentId kept, sibling group is
  // the flat Today list) — only the board shape backing it changed.
  it("keeps parentId and computes beforeId/afterId from the flat Today siblings", () => {
    const board: DragBoardTasks = {
      backlog: [],
      today: [
        makeTask({ id: "tsk_s1", parentId: "tsk_parent", bucket: "today" }),
        makeTask({ id: "tsk_s2", parentId: "tsk_parent", bucket: "today" }),
        makeTask({ id: "tsk_s3", parentId: "tsk_parent", bucket: "today" }),
      ],
    };
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

  // CHANGED — drag matrix "project task -> loose area: project_id = NULL".
  // A drop on the generic Backlog section body (as opposed to a specific
  // project header/body) now explicitly unfiles the task.
  it("an empty board with a section drop still resolves to a clean append into the loose area", () => {
    const move = computeTaskMove(
      { taskId: "tsk_only", parentId: null, bucket: "backlog" },
      { kind: "section", bucket: "backlog" },
      emptyBoard(),
    );
    expect(move).toEqual({
      id: "tsk_only",
      bucket: "backlog",
      parentId: null,
      projectId: null,
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

// ---------------------------------------------------------------------------
// The drag matrix, table-driven — docs/design/2026-08-27-projects.md,
// "Drag matrix". Each row below is one line of that table; the test name
// says which.
// ---------------------------------------------------------------------------
describe("computeTaskMove — drag matrix", () => {
  it("project task -> Today: flag scheduled, ghost stays (parentId null, projectId omitted)", () => {
    const task = makeTask({ id: "tsk_a", bucket: "backlog", projectId: "prj_1" });
    const board: DragBoardTasks = { backlog: [task], today: [] };
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "backlog" },
      { kind: "section", bucket: "today" },
      board,
    );
    expect(move).toEqual({ id: "tsk_a", bucket: "today", parentId: null, beforeId: null, afterId: null });
  });

  it("subtask -> Today: flag scheduled, parent_id KEPT", () => {
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      projectId: "prj_1",
      subtasks: [makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "backlog", projectId: "prj_1" })],
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
      parentId: "tsk_parent",
      beforeId: null,
      afterId: null,
    });
  });

  it("Today row -> Backlog (anywhere): unschedule, snaps home (parent kept, projectId omitted, no position)", () => {
    const scheduled = makeTask({ id: "tsk_a", bucket: "today", projectId: "prj_1" });
    const otherProjectTask = makeTask({ id: "tsk_b", bucket: "backlog", projectId: "prj_2" });
    const board: DragBoardTasks = {
      backlog: [otherProjectTask],
      today: [scheduled],
    };
    // Landing on a specific task belonging to an unrelated project must
    // still snap home, not reorder next to that task.
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "today" },
      { kind: "task", taskId: "tsk_b" },
      board,
      rowRect(5),
      rowRect(0),
    );
    expect(move).toEqual({ id: "tsk_a", bucket: "backlog", parentId: null, beforeId: null, afterId: null });
    expect(move).not.toHaveProperty("projectId");
  });

  it("Today row -> a different project's header: unschedule AND re-home", () => {
    const scheduled = makeTask({ id: "tsk_a", bucket: "today", projectId: "prj_1" });
    const board: DragBoardTasks = {
      backlog: [
        scheduled,
        makeTask({ id: "tsk_in_prj2", bucket: "backlog", projectId: "prj_2" }),
      ],
      today: [scheduled],
    };
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "today" },
      { kind: "project", projectId: "prj_2" },
      board,
    );
    expect(move).toEqual({
      id: "tsk_a",
      bucket: "backlog",
      parentId: null,
      projectId: "prj_2",
      beforeId: null,
      afterId: "tsk_in_prj2",
    });
  });

  it("Today row -> Today: reorder (parentId untouched)", () => {
    const board: DragBoardTasks = {
      backlog: [],
      today: [
        makeTask({ id: "tsk_a", bucket: "today" }),
        makeTask({ id: "tsk_b", bucket: "today" }),
      ],
    };
    const move = computeTaskMove(
      { taskId: "tsk_b", parentId: null, bucket: "today" },
      { kind: "task", taskId: "tsk_a" },
      board,
      rowRect(0),
      rowRect(1),
    );
    expect(move).toEqual({ id: "tsk_b", bucket: "today", parentId: null, beforeId: "tsk_a", afterId: null });
  });

  it("project task -> another project: re-home (explicit projectId, top-level)", () => {
    const target = makeTask({ id: "tsk_target", bucket: "backlog", projectId: "prj_2" });
    const board: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_a", bucket: "backlog", projectId: "prj_1" }), target],
      today: [],
    };
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "backlog" },
      { kind: "task", taskId: "tsk_target" },
      board,
      rowRect(5), // after
      rowRect(1),
    );
    expect(move).toEqual({
      id: "tsk_a",
      bucket: "backlog",
      parentId: null,
      projectId: "prj_2",
      beforeId: null,
      afterId: "tsk_target",
    });
  });

  it("project task -> loose area: projectId = null", () => {
    const board: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_a", bucket: "backlog", projectId: "prj_1" })],
      today: [],
    };
    const move = computeTaskMove(
      { taskId: "tsk_a", parentId: null, bucket: "backlog" },
      { kind: "section", bucket: "backlog" },
      board,
    );
    expect(move).toEqual({
      id: "tsk_a",
      bucket: "backlog",
      parentId: null,
      projectId: null,
      beforeId: null,
      afterId: null,
    });
  });

  it("loose task -> project body: file into project", () => {
    const inProject = makeTask({ id: "tsk_in_prj", bucket: "backlog", projectId: "prj_1" });
    const board: DragBoardTasks = {
      backlog: [makeTask({ id: "tsk_loose", bucket: "backlog", projectId: null }), inProject],
      today: [],
    };
    const move = computeTaskMove(
      { taskId: "tsk_loose", parentId: null, bucket: "backlog" },
      { kind: "project", projectId: "prj_1" },
      board,
    );
    expect(move).toEqual({
      id: "tsk_loose",
      bucket: "backlog",
      parentId: null,
      projectId: "prj_1",
      beforeId: null,
      afterId: "tsk_in_prj",
    });
  });

  it("project header -> project header: reorder projects", () => {
    const ids = ["prj_1", "prj_2", "prj_3"];
    expect(computeProjectReorder("prj_3", "prj_1", ids)).toEqual(["prj_3", "prj_1", "prj_2"]);
  });

  it("project header -> itself is a no-op", () => {
    const ids = ["prj_1", "prj_2"];
    expect(computeProjectReorder("prj_1", "prj_1", ids)).toBeNull();
  });

  it("project header -> an unknown project id is a no-op", () => {
    const ids = ["prj_1", "prj_2"];
    expect(computeProjectReorder("prj_1", "prj_ghost", ids)).toBeNull();
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

  // CHANGED — drag matrix "project task -> Today: ghost stays in project".
  // The old expectation removed the task from `backlog` entirely; the new
  // ghost model keeps its home entry in place (now flagged `bucket:
  // "today"`) *and* adds it to the flat `today` array.
  it("scheduling into Today: the task stays in backlog as a ghost AND appears in today", () => {
    const a = makeTask({ id: "tsk_a", bucket: "backlog", projectId: "prj_1" });
    const b = makeTask({ id: "tsk_b", bucket: "today" });
    const board: DragBoardTasks = { backlog: [a], today: [b] };
    const move: MoveTaskInput = {
      id: "tsk_a",
      bucket: "today",
      parentId: null,
      beforeId: null,
      afterId: "tsk_b",
    };
    const next = applyMoveToBoard(board, move, "2026-08-27");

    // Ghost: still in backlog, at the same slot, now flagged today.
    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_a"]);
    expect(next.backlog[0].bucket).toBe("today");
    expect(next.backlog[0].projectId).toBe("prj_1");
    // Also present, flat, in today.
    expect(next.today.map((t) => t.id)).toEqual(["tsk_b", "tsk_a"]);
    expect(next.today[1].bucket).toBe("today");
    expect(next.today[1].parentId).toBeNull();
    expect(next.today[1].projectId).toBe("prj_1");
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

  // CHANGED — Phase 3 deviation #1 (Today is genuinely flat) plus drag
  // matrix "Today row -> Backlog (anywhere): unschedule; snaps home". The
  // old fixture nested a real subtask inside a Today parent's `.subtasks`,
  // which can no longer happen (Today rows are always flat). This now
  // models a subtask that is BOTH homed (nested in Backlog, under its real
  // parent) and scheduled (flat in Today), and drags it back to the
  // Backlog: it disappears from `today` and its home entry — never moved —
  // is simply un-ghosted.
  it("unscheduling a subtask: it leaves the flat Today array; its home nesting is untouched", () => {
    const sub = makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "today", projectId: "prj_1" });
    const parent = makeTask({
      id: "tsk_parent",
      bucket: "backlog",
      projectId: "prj_1",
      subtasks: [sub],
      subtaskCounts: { total: 1, done: 0 },
    });
    const flatToday = makeTask({ id: "tsk_sub", parentId: "tsk_parent", bucket: "today", projectId: "prj_1" });
    const board: DragBoardTasks = { backlog: [parent], today: [flatToday] };
    const move: MoveTaskInput = {
      id: "tsk_sub",
      bucket: "backlog",
      parentId: "tsk_parent",
      beforeId: null,
      afterId: null,
    };
    const next = applyMoveToBoard(board, move);

    expect(next.today).toHaveLength(0);
    const nextParent = next.backlog.find((t) => t.id === "tsk_parent");
    expect(nextParent?.subtasks.map((s) => s.id)).toEqual(["tsk_sub"]);
    expect(nextParent?.subtasks[0].bucket).toBe("backlog");
    expect(nextParent?.subtasks[0].day).toBeNull();
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

    // tsk_a's former children are promoted to top-level siblings.
    const topIds = next.backlog.map((t) => t.id);
    expect(topIds).toContain("tsk_gc1");
    expect(topIds).toContain("tsk_gc2");
    const gc1 = next.backlog.find((t) => t.id === "tsk_gc1");
    const gc2 = next.backlog.find((t) => t.id === "tsk_gc2");
    expect(gc1?.parentId).toBeNull();
    expect(gc2?.parentId).toBeNull();
    expect(gc1?.bucket).toBe("backlog");
  });

  // CHANGED — invariant 4 ("scheduling a parent does not drag its
  // subtasks along, and scheduling a parent does not drag its subtasks
  // along ... reverses lib/db.ts:565") replaces the old "carries its
  // subtasks along" behaviour. Scheduling a parent into Today now only
  // gives the PARENT a flat Today entry; its real subtask stays exactly
  // where it was — homed, unscheduled, in the Backlog.
  it("scheduling a parent into Today does NOT drag its subtasks along (invariant 4)", () => {
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

    // Ghost: tsk_a stays in backlog, still parenting tsk_sub, which is
    // untouched (still backlog, still no day).
    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_a"]);
    expect(next.backlog[0].bucket).toBe("today");
    expect(next.backlog[0].subtasks.map((s) => s.id)).toEqual(["tsk_sub"]);
    expect(next.backlog[0].subtasks[0].bucket).toBe("backlog");
    expect(next.backlog[0].subtasks[0].day).toBeNull();

    // Today gains only the parent, flat (no nested subtasks).
    expect(next.today.map((t) => t.id)).toEqual(["tsk_a"]);
    expect(next.today[0].day).toBe("2026-08-20");
    expect(next.today[0].subtasks).toEqual([]);
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
    const board: DragBoardTasks = { backlog: [other, parent], today: [] };
    const snapshotBacklog = [...board.backlog];
    const snapshotParent = { ...parent, subtasks: [...parent.subtasks] };

    // The central-fix case: scheduling the subtask into Today keeps its
    // parentId, and must not mutate the source board while doing so.
    const move: MoveTaskInput = {
      id: "tsk_sub",
      bucket: "today",
      parentId: "tsk_parent",
      beforeId: null,
      afterId: null,
    };
    applyMoveToBoard(board, move);

    // The original arrays are untouched (still the same elements, same
    // order, same length) and the original parent object's own fields and
    // `subtasks` array are unchanged.
    expect(board.backlog).toEqual(snapshotBacklog);
    expect(board.today).toEqual([]);
    expect(board.backlog.find((t) => t.id === "tsk_parent")).toEqual(snapshotParent);
    expect(board.backlog.find((t) => t.id === "tsk_parent")?.subtasks).toHaveLength(1);
    expect(board.backlog.find((t) => t.id === "tsk_parent")?.subtasks[0].id).toBe("tsk_sub");
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

  it("re-homing to a different project relocates the home entry and writes the explicit projectId", () => {
    const a = makeTask({ id: "tsk_a", bucket: "backlog", projectId: "prj_1" });
    const inTarget = makeTask({ id: "tsk_in_prj2", bucket: "backlog", projectId: "prj_2" });
    const board: DragBoardTasks = { backlog: [a, inTarget], today: [] };
    const move: MoveTaskInput = {
      id: "tsk_a",
      bucket: "backlog",
      parentId: null,
      projectId: "prj_2",
      beforeId: null,
      afterId: "tsk_in_prj2",
    };
    const next = applyMoveToBoard(board, move);

    expect(next.backlog.map((t) => t.id)).toEqual(["tsk_in_prj2", "tsk_a"]);
    expect(next.backlog[1].projectId).toBe("prj_2");
  });
});
