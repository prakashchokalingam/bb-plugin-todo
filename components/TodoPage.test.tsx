// @vitest-environment jsdom
//
// Integration check for the keyboard-only drag path (dnd-kit's
// KeyboardSensor, required so a task can be moved without a mouse): focus a
// row's grip, Space to pick up, ArrowDown to move, Space to drop, and assert
// a real `moveTask` call with the expected input.
//
// jsdom reports every element's `getBoundingClientRect()` as all-zero, so
// dnd-kit's collision detection has nothing to collide with — every rect is
// identical, so no candidate is ever "closer" than another. This test
// patches `HTMLElement.prototype.getBoundingClientRect` to give each
// measured element a distinct, stable rect (first-seen DOM order, stacked
// top to bottom) purely so collision detection has real geometry to work
// with; the actual before/after/nest/bucket decision this drag exercises
// lives in `lib/drag.ts` and is unit-tested there independently of the DOM.
vi.mock("sonner", () => {
  const toast = vi.fn() as unknown as {
    (...args: unknown[]): void;
    error: (...args: unknown[]) => void;
  };
  toast.error = vi.fn();
  return { toast };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import type { TaskDto } from "@/contract";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A promise plus its resolve/reject, for controlling exactly when an rpc
 * stub settles — the regression test needs to inspect the DOM WHILE
 * `moveTask`/`getBoard` are still pending, before releasing them. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Assigns every distinct element a unique, monotonically increasing `top`
 * (32px rows, first-seen DOM order) so dnd-kit's `closestCenter` collision
 * detection — and the keyboard sensor's `sortableKeyboardCoordinates`, which
 * depends on it — has non-degenerate geometry instead of jsdom's all-zero
 * rects.
 */
function stubSequentialRects() {
  const order = new WeakMap<Element, number>();
  let next = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (!order.has(this)) order.set(this, next++);
      const index = order.get(this) ?? 0;
      const top = index * 32;
      return {
        top,
        bottom: top + 32,
        left: 0,
        right: 240,
        width: 240,
        height: 32,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
}

function makeTask(overrides: Partial<TaskDto> & { id: string; title: string }): TaskDto {
  return {
    listId: "lst_1",
    parentId: null,
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

describe("TodoPage — keyboard drag (dnd-kit KeyboardSensor)", () => {
  beforeEach(() => {
    stubSequentialRects();
  });

  it("reordering a Backlog row with the keyboard fires a real moveTask", async () => {
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) {
      throw new Error("app.tsx has not registered the 'board' navPanel yet");
    }

    const view = renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => ({
            lists: [
              { id: "lst_1", name: "Work", sortOrder: 1000, openCount: 2, overdueCount: 0 },
            ],
            activeListId: "lst_1",
            today: { day: "2026-08-20", planned: 0, completed: 0, tasks: [] },
            backlog: {
              total: 2,
              overdue: 0,
              tasks: [
                makeTask({ id: "tsk_a", title: "First backlog item", bucket: "backlog" }),
                makeTask({ id: "tsk_b", title: "Second backlog item", bucket: "backlog" }),
              ],
            },
            totalOverdue: 0,
            serverNow: Date.now(),
            tags: [],
          }),
          moveTask: () => ({ ok: true as const }),
        } as never,
      },
    );

    await waitFor(() => screen.getByText("First backlog item"));

    const grip = screen.getByLabelText('Reorder "First backlog item"');
    grip.focus();
    fireEvent.keyDown(grip, { key: " ", code: "Space" });
    // dnd-kit's KeyboardSensor defers attaching its own keydown listener via
    // `setTimeout(() => this.listeners.add(...))` inside `attach()` — a real
    // macrotask, not a microtask. Firing the follow-up keys synchronously
    // (no event-loop turn in between) dispatches them before that listener
    // exists, so they're silently dropped. Yield one macrotask first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(grip, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(grip, { key: " ", code: "Space" });

    await waitFor(
      () => {
        const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
        expect(moves.length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );

    // The synthetic rects above are stable and non-degenerate (unlike
    // jsdom's real all-zero ones) but are not a faithful vertical-list
    // layout, so dnd-kit's `closestCenter` + keyboard coordinate getter can
    // land the drop in the "nest" band rather than "before"/"after" —
    // that zone classification (and its exact `moveTask` shape per zone) is
    // covered precisely, independent of any DOM/rects, in `lib/drag.test.ts`.
    // What this test verifies is the thing that *cannot* be verified there:
    // that a real keyboard-only drag, through dnd-kit's actual sensors and
    // collision detection, reaches `handleDragEnd` and fires exactly one
    // real `moveTask` RPC call end to end.
    const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
    expect(moves).toHaveLength(1);
    expect(moves[0].input).toEqual({
      id: "tsk_a",
      bucket: "backlog",
      parentId: "tsk_b",
      beforeId: null,
      afterId: null,
    });
  });
});

/**
 * Regression coverage for the reported bug: "the task goes to the proper
 * bucket but the animation comes back." The root cause was that
 * `handleDragEnd` updated local state only via `refetch()` — i.e. only
 * after the `moveTask` RPC round trip — so the DOM still showed the
 * dragged row at its OLD position while dnd-kit played the `DragOverlay`'s
 * drop animation back to it. These tests drive the exact same real
 * keyboard-drag path as the test above (which resolves to nesting `tsk_a`
 * under `tsk_b` — see its comment on `sortableKeyboardCoordinates` landing
 * in the "nest" band) but hold `moveTask`/`getBoard` open on a deferred
 * promise, so they can assert on the DOM while those promises are still
 * pending — the one thing that matters here.
 */
describe("TodoPage — optimistic drag (destination visible before the RPC round trip)", () => {
  beforeEach(() => {
    stubSequentialRects();
  });

  function initialBoard() {
    return {
      lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 2, overdueCount: 0 }],
      activeListId: "lst_1",
      today: { day: "2026-08-20", planned: 0, completed: 0, tasks: [] },
      backlog: {
        total: 2,
        overdue: 0,
        tasks: [
          makeTask({ id: "tsk_a", title: "First backlog item", bucket: "backlog" }),
          makeTask({ id: "tsk_b", title: "Second backlog item", bucket: "backlog" }),
        ],
      },
      totalOverdue: 0,
      serverNow: Date.now(),
      tags: [],
    };
  }

  /** The server's authoritative post-move board: `tsk_a` nested under `tsk_b`. */
  function nestedBoard() {
    const nestedA = makeTask({
      id: "tsk_a",
      title: "First backlog item",
      bucket: "backlog",
      parentId: "tsk_b",
    });
    const b = makeTask({
      id: "tsk_b",
      title: "Second backlog item",
      bucket: "backlog",
      subtasks: [nestedA],
      subtaskCounts: { total: 1, done: 0 },
    });
    return {
      lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 2, overdueCount: 0 }],
      activeListId: "lst_1",
      today: { day: "2026-08-20", planned: 0, completed: 0, tasks: [] },
      backlog: { total: 1, overdue: 0, tasks: [b] },
      totalOverdue: 0,
      serverNow: Date.now(),
      tags: [],
    };
  }

  function textEquals(expected: string) {
    return (_content: string, element: Element | null) => element?.textContent === expected;
  }

  /** Drives the same picked-up-drop-down-dropped keyboard sequence the test
   * above uses, then waits for the resulting `moveTask` call to be recorded. */
  async function dragFirstItemOntoSecond(grip: HTMLElement) {
    grip.focus();
    fireEvent.keyDown(grip, { key: " ", code: "Space" });
    // See the comment on the KeyboardSensor's deferred `attach()` above.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(grip, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(grip, { key: " ", code: "Space" });
  }

  it("shows the row already nested under its new parent while moveTask/getBoard are still pending", async () => {
    const moveDeferred = deferred<{ ok: true }>();
    let getBoardCalls = 0;
    const getBoardDeferred = deferred<ReturnType<typeof nestedBoard>>();

    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");

    const view = renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => {
            getBoardCalls += 1;
            return getBoardCalls === 1 ? initialBoard() : getBoardDeferred.promise;
          },
          moveTask: () => moveDeferred.promise,
        } as never,
      },
    );

    await waitFor(() => screen.getByText("First backlog item"));
    // Before the drop: both rows are top-level, so both get an
    // "add a subtask" affordance (`isTopLevel` in TaskRow.tsx).
    expect(screen.getByLabelText('Add a subtask to "First backlog item"')).toBeTruthy();
    expect(screen.getByText(textEquals("BACKLOG · 2"))).toBeTruthy();

    const grip = screen.getByLabelText('Reorder "First backlog item"');
    await dragFirstItemOntoSecond(grip);

    await waitFor(() => {
      const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
      expect(moves.length).toBeGreaterThan(0);
    });
    const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
    expect(moves[0].input).toEqual({
      id: "tsk_a",
      bucket: "backlog",
      parentId: "tsk_b",
      beforeId: null,
      afterId: null,
    });

    // *** The regression assertion ***: `moveDeferred` and `getBoardDeferred`
    // are both still unresolved — no RPC round trip has completed — yet the
    // board already reflects the destination: `tsk_a` is no longer
    // top-level (its "add a subtask" affordance is gone, since only
    // top-level rows get one), and the Backlog header count has already
    // dropped from 2 to 1 top-level rows.
    expect(screen.queryByLabelText('Add a subtask to "First backlog item"')).toBeNull();
    expect(screen.getByLabelText('Add a subtask to "Second backlog item"')).toBeTruthy();
    expect(screen.getByText(textEquals("BACKLOG · 1"))).toBeTruthy();
    expect(screen.getByText("First backlog item")).toBeTruthy();

    // Now let the RPC round trip actually complete and reconcile.
    moveDeferred.resolve({ ok: true });
    await waitFor(() => {
      expect(view.inspection.rpcCalls.filter((c) => c.method === "getBoard").length).toBeGreaterThan(1);
    });
    // Still reconciling — the optimistic projection must not have reverted
    // while the refetch itself is pending.
    expect(screen.queryByLabelText('Add a subtask to "First backlog item"')).toBeNull();

    getBoardDeferred.resolve(nestedBoard());
    await waitFor(() => expect(screen.getByText(textEquals("BACKLOG · 1"))).toBeTruthy());
    expect(screen.queryByLabelText('Add a subtask to "First backlog item"')).toBeNull();
  });

  it("rolls back to the pre-drop arrangement and calls toast.error when moveTask rejects", async () => {
    const moveDeferred = deferred<{ ok: true }>();

    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");

    const view = renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => initialBoard(),
          moveTask: () => moveDeferred.promise,
        } as never,
      },
    );

    await waitFor(() => screen.getByText("First backlog item"));

    const grip = screen.getByLabelText('Reorder "First backlog item"');
    await dragFirstItemOntoSecond(grip);

    await waitFor(() => {
      const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
      expect(moves.length).toBeGreaterThan(0);
    });

    // Optimistic state is applied before the rejection lands.
    expect(screen.queryByLabelText('Add a subtask to "First backlog item"')).toBeNull();
    expect(screen.getByText(textEquals("BACKLOG · 1"))).toBeTruthy();

    moveDeferred.reject(new Error("server rejected the move"));

    // Rolled back to EXACTLY the pre-drop arrangement, and the user is told.
    await waitFor(() => {
      expect(screen.getByLabelText('Add a subtask to "First backlog item"')).toBeTruthy();
    });
    expect(screen.getByText(textEquals("BACKLOG · 2"))).toBeTruthy();
    expect(toast.error).toHaveBeenCalled();
  });
});

/**
 * Tags integration (design spec §4.1, §4.3, §4.5, §6): the row's 🏷 opens a
 * picker over the global catalog, toggling a checkbox is a full-set
 * `setTaskTags` replace (never add/remove pairs), the inline "Create …" row
 * only appears for a query that doesn't already exactly match a tag name,
 * and "Manage tags…" opens the one board-level `TagManagerDialog` via the
 * `open-tag-manager` board-bus command rather than a per-row dialog.
 */
describe("TodoPage — tags", () => {
  function tagCatalog() {
    return [
      { id: "tag_urgent", name: "urgent", color: "red" as const, sortOrder: 1000, taskCount: 2 },
      { id: "tag_bug", name: "bug", color: "amber" as const, sortOrder: 2000, taskCount: 1 },
    ];
  }

  function boardWithTags(taskTags: { id: string; name: string; color: "red" | "amber" }[] = []) {
    return {
      lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 1, overdueCount: 0 }],
      activeListId: "lst_1",
      today: { day: "2026-08-20", planned: 0, completed: 0, tasks: [] },
      backlog: {
        total: 1,
        overdue: 0,
        tasks: [makeTask({ id: "tsk_a", title: "Rewrite onboarding email", tags: taskTags })],
      },
      totalOverdue: 0,
      serverNow: Date.now(),
      tags: tagCatalog(),
    };
  }

  async function renderBoard(rpcOverrides: Record<string, unknown> = {}) {
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");
    return renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => boardWithTags(),
          ...rpcOverrides,
        } as never,
      },
    );
  }

  it("opens the tag picker from the row's 🏷 button", async () => {
    await renderBoard();
    await waitFor(() => screen.getByText("Rewrite onboarding email"));

    expect(screen.queryByText("urgent")).toBeNull();
    fireEvent.click(
      screen.getByLabelText('Edit tags for "Rewrite onboarding email"'),
    );
    await waitFor(() => {
      expect(screen.getByText("urgent")).toBeTruthy();
      expect(screen.getByText("bug")).toBeTruthy();
    });
  });

  it("toggling a checkbox calls setTaskTags with the full new set", async () => {
    const view = await renderBoard({
      setTaskTags: ({ tagIds }: { taskId: string; tagIds: string[] }) => ({
        task: makeTask({ id: "tsk_a", title: "Rewrite onboarding email", tags: [] }),
        _tagIds: tagIds,
      }),
    });
    await waitFor(() => screen.getByText("Rewrite onboarding email"));

    fireEvent.click(
      screen.getByLabelText('Edit tags for "Rewrite onboarding email"'),
    );
    await waitFor(() => screen.getByText("urgent"));

    fireEvent.click(screen.getByRole("checkbox", { name: 'Apply tag "urgent"' }));

    await waitFor(() => {
      const calls = view.inspection.rpcCalls.filter((c) => c.method === "setTaskTags");
      expect(calls.length).toBeGreaterThan(0);
    });
    const calls = view.inspection.rpcCalls.filter((c) => c.method === "setTaskTags");
    expect(calls[0].input).toEqual({ taskId: "tsk_a", tagIds: ["tag_urgent"] });

    // The popover stays open after a toggle (several tags can be applied in
    // one pass) rather than closing on selection.
    expect(screen.getByText("bug")).toBeTruthy();
  });

  it("toggling an already-applied tag off keeps the rest of the set", async () => {
    const view = await renderBoard({
      getBoard: () =>
        boardWithTags([
          { id: "tag_urgent", name: "urgent", color: "red" },
          { id: "tag_bug", name: "bug", color: "amber" },
        ]),
      setTaskTags: () => ({
        task: makeTask({ id: "tsk_a", title: "Rewrite onboarding email", tags: [] }),
      }),
    });
    await waitFor(() => screen.getByText("Rewrite onboarding email"));

    fireEvent.click(
      screen.getByLabelText('Edit tags for "Rewrite onboarding email"'),
    );
    await waitFor(() =>
      screen.getByRole("checkbox", { name: 'Remove tag "urgent"' }),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: 'Remove tag "urgent"' }));

    await waitFor(() => {
      const calls = view.inspection.rpcCalls.filter((c) => c.method === "setTaskTags");
      expect(calls.length).toBeGreaterThan(0);
    });
    const calls = view.inspection.rpcCalls.filter((c) => c.method === "setTaskTags");
    expect(calls[0].input).toEqual({ taskId: "tsk_a", tagIds: ["tag_bug"] });
  });

  it("the create row appears only for a query that doesn't already match a tag", async () => {
    await renderBoard();
    await waitFor(() => screen.getByText("Rewrite onboarding email"));

    fireEvent.click(
      screen.getByLabelText('Edit tags for "Rewrite onboarding email"'),
    );
    const input = await screen.findByLabelText("Filter or create a tag");

    // A partial, non-exact query still offers to create — only an *exact*
    // (case-insensitive) match suppresses the create row.
    fireEvent.change(input, { target: { value: "urg" } });
    expect(screen.getByLabelText('Create tag "urg"')).toBeTruthy();

    fireEvent.change(input, { target: { value: "urgent" } });
    expect(screen.queryByLabelText('Create tag "urgent"')).toBeNull();

    fireEvent.change(input, { target: { value: "URGENT" } });
    expect(screen.queryByLabelText('Create tag "URGENT"')).toBeNull();

    fireEvent.change(input, { target: { value: "design" } });
    await waitFor(() => {
      expect(screen.getByLabelText('Create tag "design"')).toBeTruthy();
    });
  });

  // Regression test for the bug where the create row's colour swatch was
  // wired with `PopoverAnchor` (positioning only, no click handler) instead
  // of `PopoverTrigger`, so clicking it did nothing and the colour grid
  // never opened. This exercises the full nested-popover interaction: the
  // swatch popover opens without dismissing the outer tag picker, picking a
  // colour updates the pending swatch and closes only the inner popover, and
  // the picker itself (with the create row still present) stays open.
  it("clicking the create row's colour swatch opens the colour grid and choosing a colour updates it", async () => {
    await renderBoard();
    await waitFor(() => screen.getByText("Rewrite onboarding email"));

    fireEvent.click(
      screen.getByLabelText('Edit tags for "Rewrite onboarding email"'),
    );
    const input = await screen.findByLabelText("Filter or create a tag");
    fireEvent.change(input, { target: { value: "design" } });
    await waitFor(() => screen.getByLabelText('Create tag "design"'));

    expect(screen.queryByRole("group", { name: "Tag color" })).toBeNull();

    fireEvent.click(screen.getByLabelText("Choose a color for the new tag"));

    // The inner swatch popover opened without closing the outer picker.
    await waitFor(() => {
      expect(screen.getByRole("group", { name: "Tag color" })).toBeTruthy();
    });
    expect(screen.getByLabelText('Create tag "design"')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Violet" }));

    // Choosing a colour closes only the inner popover…
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Tag color" })).toBeNull();
    });
    // …leaving the outer picker (and the create row) open.
    expect(screen.getByLabelText('Create tag "design"')).toBeTruthy();
    expect(screen.getByLabelText("Filter or create a tag")).toBeTruthy();
  });

  it("'Manage tags…' emits open-tag-manager, opening the one board-level dialog", async () => {
    await renderBoard();
    await waitFor(() => screen.getByText("Rewrite onboarding email"));

    fireEvent.click(
      screen.getByLabelText('Edit tags for "Rewrite onboarding email"'),
    );
    await waitFor(() => screen.getByText("urgent"));

    expect(screen.queryByText("Manage tags")).toBeNull();
    fireEvent.click(screen.getByLabelText("Manage tags"));

    await waitFor(() => {
      expect(screen.getByText("Manage tags")).toBeTruthy();
    });
  });

  // Regression test for the bug where a freshly-created tag's chip never
  // appeared: `onSetTaskTags` resolved the new chip list from the `board`
  // closed over at render time, which couldn't possibly contain a tag that
  // was created a moment earlier in the same gesture, so `.filter()` silently
  // dropped it. The fix threads the new tag straight into the catalog
  // (`patchBoard`) and resolves chips from the CURRENT board, not a refetch.
  it("a newly-created tag's chip appears on the row immediately, without waiting for a refetch", async () => {
    const getBoardHang = deferred<ReturnType<typeof boardWithTags>>();
    let getBoardCalls = 0;

    const view = await renderBoard({
      getBoard: () => {
        getBoardCalls += 1;
        // Only the initial load resolves; every refetch triggered by this
        // gesture (`onCreateTag`'s and `onSetTaskTags`'s `refetch()`) hangs
        // forever, so the test can prove the chip renders without either
        // one ever completing.
        return getBoardCalls === 1 ? boardWithTags() : getBoardHang.promise;
      },
      createTag: ({ name, color }: { name: string; color: string }) => ({
        tag: { id: "tag_design", name, color, sortOrder: 3000, taskCount: 0 },
      }),
      setTaskTags: () => ({
        task: makeTask({ id: "tsk_a", title: "Rewrite onboarding email", tags: [] }),
      }),
    });

    await waitFor(() => screen.getByText("Rewrite onboarding email"));
    fireEvent.click(
      screen.getByLabelText('Edit tags for "Rewrite onboarding email"'),
    );
    const input = await screen.findByLabelText("Filter or create a tag");
    fireEvent.change(input, { target: { value: "design" } });
    await waitFor(() => screen.getByLabelText('Create tag "design"'));

    fireEvent.click(screen.getByLabelText('Create tag "design"'));

    // No `getBoard` refetch has resolved (it can't — it's hung on purpose),
    // yet the new tag's chip is already on the row. Scoped to `view.container`
    // (the row's own subtree) rather than `screen`, since the still-open
    // picker popover — rendered through a portal outside `container` — also
    // lists "design" once it's part of the catalog, which would otherwise
    // make this an ambiguous, multi-match query.
    await waitFor(() => {
      expect(within(view.container).getByText("design")).toBeTruthy();
    });
    expect(getBoardCalls).toBeGreaterThan(1);

    const setTaskTagsCalls = view.inspection.rpcCalls.filter(
      (c) => c.method === "setTaskTags",
    );
    expect(setTaskTagsCalls[0]?.input).toEqual({
      taskId: "tsk_a",
      tagIds: ["tag_design"],
    });
  });

  // Regression test for the interleaved-toggle bug: `onSetTaskTags` used to
  // capture the whole board (`preDropBoard = board`) and, on RPC failure,
  // swap the ENTIRE board back to that stale snapshot — discarding any other
  // toggle that had landed in between. Two toggles fired back to back on the
  // same task, where the second succeeds and the first then fails, must
  // leave the second toggle's tag on the task rather than erasing it.
  it("a later successful toggle survives an earlier toggle's failure on the same task", async () => {
    const rpcA = deferred<{ task: TaskDto }>();
    const rpcB = deferred<{ task: TaskDto }>();
    const getBoardHang = deferred<ReturnType<typeof boardWithTags>>();
    let setTaskTagsCalls = 0;
    let getBoardCalls = 0;

    await renderBoard({
      // The refetch each successful/failed `setTaskTags` schedules must not
      // be allowed to land — this test's `getBoard` stub is state-blind (it
      // always describes the ORIGINAL board), so a real refetch resolving
      // here would clobber the optimistic state under test with stale
      // server data that doesn't reflect either toggle. Hanging it isolates
      // exactly the thing this regression is about: what the optimistic
      // apply/rollback state machine does before any round trip completes.
      getBoard: () => {
        getBoardCalls += 1;
        return getBoardCalls === 1 ? boardWithTags() : getBoardHang.promise;
      },
      setTaskTags: () => {
        setTaskTagsCalls += 1;
        return setTaskTagsCalls === 1 ? rpcA.promise : rpcB.promise;
      },
    });

    await waitFor(() => screen.getByText("Rewrite onboarding email"));
    fireEvent.click(
      screen.getByLabelText('Edit tags for "Rewrite onboarding email"'),
    );
    await waitFor(() => screen.getByText("urgent"));

    // Toggle A: apply "urgent". Fires setTaskTags #1 (held open on `rpcA`).
    fireEvent.click(screen.getByRole("checkbox", { name: 'Apply tag "urgent"' }));
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: 'Remove tag "urgent"' })).toBeTruthy();
    });

    // Toggle B, before A resolves: apply "bug" on top of the optimistic
    // state left by A. Fires setTaskTags #2 (held open on `rpcB`), with the
    // full set ["tag_urgent", "tag_bug"].
    fireEvent.click(screen.getByRole("checkbox", { name: 'Apply tag "bug"' }));
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: 'Remove tag "bug"' })).toBeTruthy();
    });
    expect(setTaskTagsCalls).toBe(2);

    // B resolves first (server-confirmed) and starts its own refetch...
    rpcB.resolve({
      task: makeTask({
        id: "tsk_a",
        title: "Rewrite onboarding email",
        tags: [
          { id: "tag_urgent", name: "urgent", color: "red" },
          { id: "tag_bug", name: "bug", color: "amber" },
        ],
      }),
    });
    // ...then A rejects.
    rpcA.reject(new Error("stale request rejected by the server"));

    // Both tags must still show as applied — A's failure must not have
    // wiped out B's server-confirmed "bug", nor its own "urgent" (which B's
    // full-set replace also carried forward).
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: 'Remove tag "bug"' })).toBeTruthy();
    });
    expect(screen.getByRole("checkbox", { name: 'Remove tag "urgent"' })).toBeTruthy();
    expect(toast.error).toHaveBeenCalled();
  });

  // Regression test for the "+ New tag" collision: clicking it twice before
  // renaming the first used to create two tags both literally named
  // "New tag", colliding on the case-insensitive uniqueness constraint and
  // surfacing a generic toast on the second click.
  it("two consecutive '+ New tag' clicks in the manager produce two distinct default names", async () => {
    const getBoardHang = deferred<ReturnType<typeof boardWithTags>>();
    let getBoardCalls = 0;
    const view = await renderBoard({
      // `TagManagerDialog` resyncs its local catalog from the `tags` prop
      // whenever it changes (so drag/rename stay in step with the parent).
      // A real refetch here would bring back the ORIGINAL two-tag catalog
      // and stomp on the dialog's own optimistic append of the tag just
      // created — hang every refetch after the initial load so this test
      // isolates exactly what `nextDefaultTagName` does with the dialog's
      // own local state between two clicks, independent of that refetch.
      getBoard: () => {
        getBoardCalls += 1;
        return getBoardCalls === 1 ? boardWithTags() : getBoardHang.promise;
      },
      createTag: ({ name, color }: { name: string; color: string }) => ({
        tag: {
          id: `tag_${name.toLowerCase().replace(/\s+/g, "_")}`,
          name,
          color,
          sortOrder: 1000,
          taskCount: 0,
        },
      }),
    });
    await waitFor(() => screen.getByText("Rewrite onboarding email"));

    fireEvent.click(
      screen.getByLabelText('Edit tags for "Rewrite onboarding email"'),
    );
    await waitFor(() => screen.getByText("urgent"));
    fireEvent.click(screen.getByLabelText("Manage tags"));
    await waitFor(() => screen.getByText("Manage tags"));

    const newTagButton = screen.getByRole("button", { name: /New tag/i });
    fireEvent.click(newTagButton);
    // Wait for the FULL round trip — including the `setLocalTags` that
    // folds the new tag into the catalog the next click's default-name
    // computation reads — not just for the RPC call to have fired, since
    // that's what a second click racing the first needs to see.
    await waitFor(() => {
      expect(screen.getByDisplayValue("New tag")).toBeTruthy();
    });

    fireEvent.click(newTagButton);
    await waitFor(() => {
      const calls = view.inspection.rpcCalls.filter((c) => c.method === "createTag");
      expect(calls.length).toBe(2);
    });

    const names = view.inspection.rpcCalls
      .filter((c) => c.method === "createTag")
      .map((c) => (c.input as { name: string }).name);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).not.toBe(names[1]);
  });
});
