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
// with; the actual before/after/nest/stage decision this drag exercises
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
import type { ProjectDto, TaskDto } from "@/contract";

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

function makeProject(overrides: Partial<ProjectDto> & { id: string; name: string }): ProjectDto {
  return {
    listId: "lst_1",
    color: "teal",
    sortOrder: 1000,
    collapsed: false,
    inProgressCollapsed: false,
    openCount: 0,
    inProgressCount: 0,
    overdueCount: 0,
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
            inProgress: { planned: 0, completed: 0 },
            backlog: {
              total: 2,
              overdue: 0,
              tasks: [
                makeTask({ id: "tsk_a", title: "First backlog item", stage: "pending" }),
                makeTask({ id: "tsk_b", title: "Second backlog item", stage: "pending" }),
              ],
            },
            totalOverdue: 0,
            serverNow: Date.now(),
            tags: [],
            projects: [],
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
      stage: "pending",
      parentId: "tsk_b",
      beforeId: null,
      afterId: null,
    });
  });
});

/**
 * Regression coverage for the reported bug: "the task goes to the proper
 * stage but the animation comes back." The root cause was that
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
      inProgress: { planned: 0, completed: 0 },
      backlog: {
        total: 2,
        overdue: 0,
        tasks: [
          makeTask({ id: "tsk_a", title: "First backlog item", stage: "pending" }),
          makeTask({ id: "tsk_b", title: "Second backlog item", stage: "pending" }),
        ],
      },
      totalOverdue: 0,
      serverNow: Date.now(),
      tags: [],
      projects: [],
    };
  }

  /** The server's authoritative post-move board: `tsk_a` nested under `tsk_b`. */
  function nestedBoard() {
    const nestedA = makeTask({
      id: "tsk_a",
      title: "First backlog item",
      stage: "pending",
      parentId: "tsk_b",
    });
    const b = makeTask({
      id: "tsk_b",
      title: "Second backlog item",
      stage: "pending",
      subtasks: [nestedA],
      subtaskCounts: { total: 1, done: 0 },
    });
    return {
      lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 2, overdueCount: 0 }],
      activeListId: "lst_1",
      inProgress: { planned: 0, completed: 0 },
      backlog: { total: 1, overdue: 0, tasks: [b] },
      totalOverdue: 0,
      serverNow: Date.now(),
      tags: [],
      projects: [],
    };
  }

  function textEquals(expected: string) {
    return (_content: string, element: Element | null) => element?.textContent === expected;
  }

  /** `textEquals` compares raw `textContent`, which — since the Phase 4
   * panel-collapse rework wrapped the heading `<span>` in a `<button>`
   * (`Section.tsx`) — now also matches that wrapping button (its only other
   * child is an `aria-hidden` chevron `<svg>`, which contributes no text).
   * Scope the query to the innermost `<span>` so it resolves to exactly one
   * element again, without weakening what's actually being asserted. */
  const headingTextOptions = { selector: "span" } as const;

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
    expect(screen.getByText(textEquals("BACKLOG · 2 pending"), headingTextOptions)).toBeTruthy();

    const grip = screen.getByLabelText('Reorder "First backlog item"');
    await dragFirstItemOntoSecond(grip);

    await waitFor(() => {
      const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
      expect(moves.length).toBeGreaterThan(0);
    });
    const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
    expect(moves[0].input).toEqual({
      id: "tsk_a",
      stage: "pending",
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
    expect(screen.getByText(textEquals("BACKLOG · 1 pending"), headingTextOptions)).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText(textEquals("BACKLOG · 1 pending"), headingTextOptions)).toBeTruthy());
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
    expect(screen.getByText(textEquals("BACKLOG · 1 pending"), headingTextOptions)).toBeTruthy();

    moveDeferred.reject(new Error("server rejected the move"));

    // Rolled back to EXACTLY the pre-drop arrangement, and the user is told.
    await waitFor(() => {
      expect(screen.getByLabelText('Add a subtask to "First backlog item"')).toBeTruthy();
    });
    expect(screen.getByText(textEquals("BACKLOG · 2 pending"), headingTextOptions)).toBeTruthy();
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
      inProgress: { planned: 0, completed: 0 },
      backlog: {
        total: 1,
        overdue: 0,
        tasks: [makeTask({ id: "tsk_a", title: "Rewrite onboarding email", tags: taskTags })],
      },
      totalOverdue: 0,
      serverNow: Date.now(),
      tags: tagCatalog(),
      projects: [],
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

/**
 * Phase 6 obligation 2 — end-to-end proof spanning the drag layer AND the
 * board's rendering together. Phase 4's `lib/drag.test.ts` proves
 * `computeTaskMove`'s shape in isolation; Phase 2's `lib/db.test.ts` proves
 * the DB half. Neither exercises a REAL dnd-kit gesture through the actual
 * component tree end to end — these tests do, following the same
 * keyboard-drag technique (`stubSequentialRects` + dnd-kit's KeyboardSensor)
 * as the "TodoPage — keyboard drag" describe block above.
 *
 * Phase 4 rewrite: ghost rows are gone. A task that qualifies for In
 * Progress (`task.inProgress`) renders as a normal, fully-interactive row in
 * BOTH columns at once — no dimming, no swapped checkbox — distinguished
 * only by its In Progress marker. The subtlety this suite surfaces and fixes (not merely
 * tests around) survives that rewrite unchanged: the same `TaskDto.id` on
 * screen twice at once used to collide as a duplicate dnd-kit sortable id;
 * `taskDragId` (`TaskRow.tsx`) still exists to prevent exactly that, and (b)
 * below plus the "same task, both columns" suite further down exercise it
 * directly, through real gestures, not just by reading the source.
 */
describe("TodoPage — projects & trail (end-to-end drag + render)", () => {
  beforeEach(() => {
    stubSequentialRects();
  });

  const project = makeProject({ id: "prj_1", name: "Q3 Launch", color: "teal" });

  function subtaskInProjectBoard() {
    const sub = makeTask({
      id: "tsk_sub",
      title: "Get legal sign-off",
      parentId: "tsk_parent",
      projectId: "prj_1",
    });
    const parent = makeTask({
      id: "tsk_parent",
      title: "Rewrite the onboarding email",
      projectId: "prj_1",
      subtasks: [sub],
      subtaskCounts: { total: 1, done: 0 },
    });
    return {
      lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 2, overdueCount: 0 }],
      activeListId: "lst_1",
      inProgress: { planned: 0, completed: 0 },
      backlog: { total: 1, overdue: 0, tasks: [parent] },
      totalOverdue: 0,
      serverNow: Date.now(),
      tags: [],
      projects: [project],
    };
  }

  /**
   * The server's authoritative board after `moveTask` schedules the
   * subtask. Since Phase 2, the Backlog is the one comprehensive tree: the
   * SAME subtask row (`stage: "in_progress"`, `inProgress: true`, its `trail` now
   * populated) is nested under its parent here — that single row is what
   * both columns render from. `lib/inProgressView`'s `selectInProgressView`
   * derives In Progress's copy from it: because the PARENT doesn't itself
   * qualify (`tsk_parent.inProgress` is false — never scheduled, never due),
   * the subtask surfaces in In Progress under a `"parentGroup"` row keyed
   * by that parent, inside the `Q3 Launch` project group — a
   * `ParentGroupHeader` naming the parent, followed by the subtask,
   * indented, with no trail (the header already names the parent).
   */
  function scheduledSubtaskBoard() {
    const sub = makeTask({
      id: "tsk_sub",
      title: "Get legal sign-off",
      parentId: "tsk_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
      trail: {
        projectId: "prj_1",
        projectName: "Q3 Launch",
        projectColor: "teal",
        parentId: "tsk_parent",
        parentTitle: "Rewrite the onboarding email",
      },
    });
    const parent = makeTask({
      id: "tsk_parent",
      title: "Rewrite the onboarding email",
      projectId: "prj_1",
      subtasks: [sub],
      subtaskCounts: { total: 1, done: 0 },
    });
    return {
      lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 2, overdueCount: 0 }],
      activeListId: "lst_1",
      inProgress: { planned: 1, completed: 0 },
      backlog: { total: 1, overdue: 0, tasks: [parent] },
      totalOverdue: 0,
      serverNow: Date.now(),
      tags: [],
      projects: [{ ...project, inProgressCount: 1 }],
    };
  }

  async function dragSubtaskIntoInProgress() {
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");

    let getBoardCalls = 0;
    const view = renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => {
            getBoardCalls += 1;
            return getBoardCalls === 1 ? subtaskInProjectBoard() : scheduledSubtaskBoard();
          },
          moveTask: () => ({ ok: true as const }),
        } as never,
      },
    );

    await waitFor(() => screen.getByText("Get legal sign-off"));

    const grip = screen.getByLabelText('Reorder "Get legal sign-off"');
    grip.focus();
    fireEvent.keyDown(grip, { key: " ", code: "Space" });
    // See the KeyboardSensor deferred-`attach()` comment on the describe
    // block above: a real macrotask, not a microtask, must elapse before
    // its own keydown listener exists.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Empirically, landing the In Progress column's own (initially empty)
    // droppable from a Backlog subtask takes several ArrowDown hops through
    // every intervening sortable/droppable (project header, sibling rows,
    // the project body, the loose-task row, both column containers) —
    // dnd-kit's `sortableKeyboardCoordinates` walks its droppable registry
    // one candidate at a time. 15 presses lands reliably past all of them
    // onto the empty In Progress column and stays there (verified stable across a
    // wide press range), without needing to hand-compute dnd-kit's internal
    // measurement order.
    for (let i = 0; i < 15; i++) {
      fireEvent.keyDown(grip, { key: "ArrowDown", code: "ArrowDown" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fireEvent.keyDown(grip, { key: " ", code: "Space" });

    await waitFor(() => {
      const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
      expect(moves.length).toBeGreaterThan(0);
    });

    return view;
  }

  it("(a) dragging a subtask from a project into In Progress keeps its parent, and In Progress shows its trail", async () => {
    const view = await dragSubtaskIntoInProgress();

    // The CENTRAL FIX (design doc's Problem section correction, lib/drag.ts
    // "CENTRAL FIX" comment): parentId is KEPT, not nulled, and projectId is
    // omitted entirely (moveTask's "omit = unchanged").
    const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
    expect(moves[0].input).toEqual({
      id: "tsk_sub",
      stage: "in_progress",
      parentId: "tsk_parent",
      beforeId: null,
      afterId: null,
    });

    // The server's authoritative post-move board (this test's `getBoard`
    // stub's second response) renders the scheduled subtask under a
    // `"parentGroup"` row inside In Progress's own "Q3 Launch" project
    // group: a `ParentGroupHeader` naming the parent ("Rewrite the
    // onboarding email"), with the subtask indented below it — no trail on
    // either the header or the subtask row. "Q3 Launch" itself comes from
    // the project group's OWN header (In Progress's `ProjectHeader`), so it
    // appears at least twice on screen either way (once per column's copy
    // of the project).
    await waitFor(() => {
      expect(screen.getAllByText("Q3 Launch").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Rewrite the onboarding email").length).toBeGreaterThan(0);
  });

  it("(b) the subtask remains a normal, fully-interactive row in its project after being scheduled", async () => {
    await dragSubtaskIntoInProgress();

    // No more ghosts, no more per-row "In Progress marker": the project's
    // own (Backlog) copy of the subtask is still on screen as a real,
    // undimmed row, and the ▶/◀ stage toggle is the only sign of which
    // column each instance belongs to — the Backlog instance offers "Move
    // to In Progress" (it can still be started), while the In Progress
    // instance offers "Move to Backlog" (`actions.onParkTask`, the only way
    // left to leave In Progress). Scoped to each row via its `data-task-id`
    // container (`TaskRow.tsx`) rather than a bare `getAllByLabelText`
    // count, since the fixture's parent task also renders its own "Move to
    // In Progress" toggle.
    let grips: HTMLElement[] = [];
    await waitFor(() => {
      grips = screen.getAllByLabelText('Reorder "Get legal sign-off"');
      expect(grips.length).toBe(2);
    });
    const rows = grips.map((grip) => grip.closest('[data-task-id="tsk_sub"]') as HTMLElement);
    expect(rows.every(Boolean)).toBe(true);
    expect(within(rows[0]).getByLabelText("Move to In Progress")).toBeTruthy();
    expect(within(rows[1]).getByLabelText("Move to Backlog")).toBeTruthy();
    // Two full rows, not one real + one ghost: the drag handle (a real,
    // interactive control only a live row has) exists for BOTH the Backlog
    // instance and the In Progress instance.
    expect(grips.length).toBe(2);

    // The parent itself is untouched: still showing the "add a subtask"
    // affordance only top-level rows get — proving invariant 4 (scheduling
    // a subtask never drags its parent into In Progress).
    expect(
      screen.getByLabelText('Add a subtask to "Rewrite the onboarding email"'),
    ).toBeTruthy();
  });

  it("(c) dragging its In Progress instance back to the Backlog snaps it home, without colliding with its own Backlog instance", async () => {
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");

    const view = renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => scheduledSubtaskBoard(),
          moveTask: () => ({ ok: true as const }),
        } as never,
      },
    );

    await waitFor(() => {
      expect(screen.getAllByText("Get legal sign-off").length).toBeGreaterThan(0);
    });

    // Two rows share this label at once: the Backlog instance (nested under
    // its project) and the In Progress instance (indented under its
    // `ParentGroupHeader`) — the exact "same task, two live DOM instances" situation `taskDragId`
    // exists for (`TaskRow.tsx`). In Progress renders after the Backlog in the
    // DOM, so it's the last match. Grabbing and dropping THIS one (not the
    // Backlog one) is the real-gesture proof that dnd-kit's id registry
    // doesn't collide the two: if it did, this drag would either move the
    // wrong instance or silently no-op instead of producing the snap-home
    // `moveTask` call asserted below.
    const grips = screen.getAllByLabelText('Reorder "Get legal sign-off"');
    const inProgressGrip = grips[grips.length - 1];
    inProgressGrip.focus();
    fireEvent.keyDown(inProgressGrip, { key: " ", code: "Space" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Empirically, two ArrowDown hops from the In Progress row land the drop
    // directly ON the (unrelated, still-in-the-Backlog) parent task's own
    // row — a deliberately "wrong" landing spot within the Backlog, chosen
    // specifically to prove the snap-home rule doesn't care where it lands.
    fireEvent.keyDown(inProgressGrip, { key: "ArrowDown", code: "ArrowDown" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(inProgressGrip, { key: "ArrowDown", code: "ArrowDown" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(inProgressGrip, { key: " ", code: "Space" });

    await waitFor(() => {
      const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
      expect(moves.length).toBeGreaterThan(0);
    });

    // The snap-home rule (design doc "Drag matrix"): dropped ON
    // "tsk_parent"'s own row, yet `beforeId`/`afterId` are both null — the
    // drop position is discarded entirely. `parentId` is carried over
    // unchanged (still "tsk_parent"), and `projectId` is omitted (moveTask's
    // "omit = unchanged"), so the subtask returns to exactly the slot it
    // already lived in, not wherever the pointer/focus happened to land.
    // This is also the `id` the id-collision proof above hinges on: had the
    // Backlog instance moved instead, this input's `id` would still read
    // "tsk_sub" (same task) but the drop math — computed from whichever DOM
    // row dnd-kit actually tracked as "active" — would differ from what a
    // correct In-Progress-column drag produces.
    const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
    expect(moves[0].input).toEqual({
      id: "tsk_sub",
      stage: "pending",
      parentId: "tsk_parent",
      beforeId: null,
      afterId: null,
    });
  });

  it("(d) a task carried several times still renders its full trail", async () => {
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");

    const carried = makeTask({
      id: "tsk_carried",
      title: "Draft the copy",
      parentId: "tsk_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
      carriedDays: 6,
      trail: {
        projectId: "prj_1",
        projectName: "Q3 Launch",
        projectColor: "teal",
        parentId: "tsk_parent",
        parentTitle: "Rewrite the onboarding email",
      },
    });
    // `carried`'s parent must itself be reachable from `backlog.tasks` for
    // `selectInProgressView` to find it at all — since Phase 2 there is no
    // separate flat `inProgress.tasks` array to short-circuit through; the
    // parent doesn't itself qualify for In Progress (never scheduled, never
    // due), so `carried` surfaces under a `"parentGroup"` row exactly like
    // (a)/(b)'s subtask above.
    const parent = makeTask({
      id: "tsk_parent",
      title: "Rewrite the onboarding email",
      projectId: "prj_1",
      subtasks: [carried],
      subtaskCounts: { total: 1, done: 0 },
    });

    renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => ({
            lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 1, overdueCount: 0 }],
            activeListId: "lst_1",
            inProgress: { planned: 1, completed: 0 },
            backlog: { total: 1, overdue: 0, tasks: [parent] },
            totalOverdue: 0,
            serverNow: Date.now(),
            tags: [],
            projects: [project],
          }),
        } as never,
      },
    );

    await waitFor(() => screen.getAllByText("Draft the copy"));

    // The "carried Nx" badge survives a task also having an In Progress
    // marker and a trail — the marker is no longer either/or with the carried
    // badge (both features coexist on the same row).
    expect(screen.getAllByText("carried 6d").length).toBeGreaterThan(0);
    // The project name (via the group's own header) and the parent's name
    // (via its `ParentGroupHeader`) both still render regardless of how
    // many times the task's been carried.
    expect(screen.getAllByText("Q3 Launch").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Rewrite the onboarding email").length).toBeGreaterThan(0);
  });
});

/**
 * Coverage for the design doc's "one new question" (Data plan): an
 * auto-included task (never manually scheduled — `stage` stays
 * `'pending'`, `inProgress` true purely from its due date) has no `stage`
 * flag for `moveTask` to clear, so dragging its IN-PROGRESS instance out of
 * In Progress must dispatch `setTaskStage` instead — never `moveTask` —
 * while dragging its BACKLOG instance is an entirely ordinary reorder that
 * must NOT dismiss it. Both gestures exercise the exact same on-screen
 * situation as the suite above (the same task, two live rows at once), so
 * they double as further real-gesture proof that `taskDragId`'s
 * column-scoped ids don't collide — this time on a task that was never
 * dragged INTO In Progress at all,
 * only ever auto-included.
 */
describe("TodoPage — dismissing vs. reordering an auto-included task", () => {
  beforeEach(() => {
    stubSequentialRects();
  });

  /** `tsk_auto` is due today (so `inProgress: true` with `stage` still
   * "pending" — the auto-included case), loose (no project, to keep the DOM
   * simple and the keyboard-drag press counts stable), with a plain sibling
   * loose task, `tsk_other`, purely as a Backlog reorder target. */
  function autoIncludedBoard() {
    return {
      lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 2, overdueCount: 0 }],
      activeListId: "lst_1",
      inProgress: { planned: 1, completed: 0 },
      backlog: {
        total: 2,
        overdue: 0,
        tasks: [
          makeTask({
            id: "tsk_auto",
            title: "Renew the domain",
            stage: "pending",
            inProgress: true,
            dueAt: new Date("2026-08-27T10:00:00").getTime(),
          }),
          makeTask({ id: "tsk_other", title: "Buy stamps", stage: "pending" }),
        ],
      },
      totalOverdue: 0,
      serverNow: new Date("2026-08-27T09:00:00").getTime(),
      tags: [],
      projects: [],
    };
  }

  it("dragging the In Progress instance into the Backlog column calls setTaskStage, never moveTask", async () => {
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");

    const view = renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => autoIncludedBoard(),
          setTaskStage: () => ({ ok: true as const }),
          moveTask: () => ({ ok: true as const }),
        } as never,
      },
    );

    await waitFor(() => {
      expect(screen.getAllByText("Renew the domain").length).toBeGreaterThan(0);
    });

    // Two live rows for the same task: the Backlog instance and the In
    // Progress instance (In Progress's "Unfiled" loose group, since this
    // task is loose). Grab the SECOND — the In Progress one, rendered after
    // the Backlog in the DOM — and hop it once. Empirically (verified
    // against several press counts), dnd-kit's `sortableKeyboardCoordinates`
    // wraps a single ArrowDown from the last sortable in its registry back
    // onto the first droppable candidate, which — with only two loose tasks
    // per column in this fixture — lands on the Backlog column's own body.
    // A larger press count instead walks back into an In-Progress-column
    // target and re-enters In Progress (an ordinary reorder there), the
    // opposite of what this test means to exercise.
    const grips = screen.getAllByLabelText('Reorder "Renew the domain"');
    const inProgressGrip = grips[grips.length - 1];
    inProgressGrip.focus();
    fireEvent.keyDown(inProgressGrip, { key: " ", code: "Space" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(inProgressGrip, { key: "ArrowDown", code: "ArrowDown" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(inProgressGrip, { key: " ", code: "Space" });

    await waitFor(() => {
      const dismisses = view.inspection.rpcCalls.filter((c) => c.method === "setTaskStage");
      expect(dismisses.length).toBeGreaterThan(0);
    });

    expect(
      view.inspection.rpcCalls.filter((c) => c.method === "setTaskStage")[0].input,
    ).toEqual({ id: "tsk_auto", stage: "pending" });
    // The one thing this whole test exists to prove: no `moveTask` at all —
    // there's no `stage` flag on an auto-included task for it to clear.
    expect(view.inspection.rpcCalls.some((c) => c.method === "moveTask")).toBe(false);
  });

  it("reordering the SAME task's Backlog instance among Backlog siblings is an ordinary reorder, not a dismissal", async () => {
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");

    const view = renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => autoIncludedBoard(),
          setTaskStage: () => ({ ok: true as const }),
          moveTask: () => ({ ok: true as const }),
        } as never,
      },
    );

    await waitFor(() => {
      expect(screen.getAllByText("Renew the domain").length).toBeGreaterThan(0);
    });

    // This time grab the FIRST instance — the Backlog one — and nudge it
    // past its own sibling, entirely within the Backlog column.
    const grips = screen.getAllByLabelText('Reorder "Renew the domain"');
    const backlogGrip = grips[0];
    backlogGrip.focus();
    fireEvent.keyDown(backlogGrip, { key: " ", code: "Space" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(backlogGrip, { key: "ArrowDown", code: "ArrowDown" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(backlogGrip, { key: " ", code: "Space" });

    await waitFor(() => {
      const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
      expect(moves.length).toBeGreaterThan(0);
    });

    // An ordinary Backlog-to-Backlog reorder: `stage` stays "pending", and
    // — the assertion this test exists for — no dismissal was triggered by
    // merely moving the task's OWN Backlog row among its Backlog siblings.
    expect(view.inspection.rpcCalls.some((c) => c.method === "setTaskStage")).toBe(false);
    const moves = view.inspection.rpcCalls.filter((c) => c.method === "moveTask");
    expect(moves[0].input).toMatchObject({ id: "tsk_auto", stage: "pending" });
  });
});

/**
 * The one-click ▶ Start / ◀ Park stage-toggle buttons on `TaskRow` (the
 * feature request's "change the status to inprogress to pending state
 * (vice versa)" without a drag gesture). Both directions always call
 * `setTaskStage` directly — no `task.stage`-based routing to `moveTask` —
 * see `TodoPage.tsx`'s `setTaskStageAction`.
 */
describe("TodoPage — the ▶ Start / ◀ Park one-click stage toggle", () => {
  it("▶ Start on a Backlog row calls setTaskStage(id, 'in_progress') and optimistically shows the task in In Progress before the RPC resolves", async () => {
    const stageDeferred = deferred<{ ok: true }>();
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");

    const view = renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => ({
            lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 1, overdueCount: 0 }],
            activeListId: "lst_1",
            inProgress: { planned: 0, completed: 0 },
            backlog: {
              total: 1,
              overdue: 0,
              tasks: [makeTask({ id: "tsk_1", title: "Draft the copy", stage: "pending" })],
            },
            totalOverdue: 0,
            serverNow: new Date("2026-08-27T09:00:00").getTime(),
            tags: [],
            projects: [],
          }),
          setTaskStage: () => stageDeferred.promise,
        } as never,
      },
    );

    await waitFor(() => screen.getByText("Draft the copy"));
    // Only the Backlog instance exists yet — not `inProgress`.
    expect(screen.getAllByText("Draft the copy")).toHaveLength(1);

    fireEvent.click(screen.getByLabelText("Move to In Progress"));

    await waitFor(() => {
      expect(view.inspection.rpcCalls.some((c) => c.method === "setTaskStage")).toBe(true);
    });
    expect(view.inspection.rpcCalls.find((c) => c.method === "setTaskStage")?.input).toEqual({
      id: "tsk_1",
      stage: "in_progress",
    });

    // Optimistic: the row is already doubled into In Progress too, before
    // `setTaskStage` has resolved.
    await waitFor(() => {
      expect(screen.getAllByText("Draft the copy")).toHaveLength(2);
    });

    stageDeferred.resolve({ ok: true });
  });

  it("◀ Park on an In Progress row calls setTaskStage(id, 'pending'); a rejection rolls back and toasts", async () => {
    const stageDeferred = deferred<{ ok: true }>();
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");

    const view = renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => ({
            lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 1, overdueCount: 0 }],
            activeListId: "lst_1",
            inProgress: { planned: 1, completed: 0 },
            backlog: {
              total: 1,
              overdue: 0,
              tasks: [
                makeTask({
                  id: "tsk_1",
                  title: "Get legal sign-off",
                  stage: "in_progress",
                  inProgress: true,
                }),
              ],
            },
            totalOverdue: 0,
            serverNow: new Date("2026-08-27T09:00:00").getTime(),
            tags: [],
            projects: [],
          }),
          setTaskStage: () => stageDeferred.promise,
        } as never,
      },
    );

    await waitFor(() => {
      expect(screen.getAllByText("Get legal sign-off")).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByLabelText("Move to Backlog")[0]);

    await waitFor(() => {
      expect(view.inspection.rpcCalls.some((c) => c.method === "setTaskStage")).toBe(true);
    });
    expect(view.inspection.rpcCalls.find((c) => c.method === "setTaskStage")?.input).toEqual({
      id: "tsk_1",
      stage: "pending",
    });

    // Optimistic: only the Backlog instance remains while the RPC is still
    // pending — the In Progress instance has already disappeared.
    await waitFor(() => {
      expect(screen.getAllByText("Get legal sign-off")).toHaveLength(1);
    });

    stageDeferred.reject(new Error("server rejected the park"));

    // Rolled back: the task reappears in In Progress too, and the user is told.
    await waitFor(() => {
      expect(screen.getAllByText("Get legal sign-off")).toHaveLength(2);
    });
    expect(toast.error).toHaveBeenCalled();
  });
});

/**
 * The In Progress column's own grouping/hiding behaviour
 * (`lib/inProgressView.ts`'s unit tests already cover the pure derivation
 * exhaustively; this proves `TodoPage`/`Section`/`ProjectGroup` actually
 * render what it derives).
 */
describe("TodoPage — In Progress column rendering", () => {
  it("groups by project and hides a project with nothing qualifying for In Progress", async () => {
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");

    const busyProject = makeProject({ id: "prj_busy", name: "Q3 Launch", color: "teal" });
    const quietProject = makeProject({ id: "prj_quiet", name: "Someday", color: "slate" });

    renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => ({
            lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 2, overdueCount: 0 }],
            activeListId: "lst_1",
            inProgress: { planned: 1, completed: 0 },
            backlog: {
              total: 2,
              overdue: 0,
              tasks: [
                makeTask({
                  id: "tsk_busy",
                  title: "Get legal sign-off",
                  projectId: "prj_busy",
                  stage: "in_progress",
                  inProgress: true,
                }),
                // Nothing in "Someday" qualifies for In Progress — it must
                // not render a group there at all (unlike the Backlog, which
                // never hides an empty project).
                makeTask({
                  id: "tsk_quiet",
                  title: "Eventually reorganize the garage",
                  projectId: "prj_quiet",
                }),
              ],
            },
            totalOverdue: 0,
            serverNow: Date.now(),
            tags: [],
            projects: [busyProject, quietProject],
          }),
        } as never,
      },
    );

    await waitFor(() => {
      expect(screen.getAllByText("Q3 Launch").length).toBeGreaterThan(0);
    });
    // "Someday" still renders once, for its Backlog card — but never a
    // second time for an (empty, hidden) In Progress card.
    expect(screen.getAllByText("Someday").length).toBe(1);
  });

  it("shows a ParentGroupHeader for a non-qualifying parent's subtask under the loose/Unfiled group", async () => {
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");

    const sub = makeTask({
      id: "tsk_sub",
      title: "Ship the invoice fix",
      parentId: "tsk_parent",
      stage: "in_progress",
      inProgress: true,
      trail: {
        projectId: null,
        projectName: null,
        projectColor: null,
        parentId: "tsk_parent",
        parentTitle: "Q4 invoicing cleanup",
      },
    });
    const parent = makeTask({
      id: "tsk_parent",
      title: "Q4 invoicing cleanup",
      subtasks: [sub],
      subtaskCounts: { total: 1, done: 0 },
    });

    renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => ({
            lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 1, overdueCount: 0 }],
            activeListId: "lst_1",
            inProgress: { planned: 1, completed: 0 },
            backlog: { total: 1, overdue: 0, tasks: [parent] },
            totalOverdue: 0,
            serverNow: Date.now(),
            tags: [],
            projects: [],
          }),
        } as never,
      },
    );

    // The loose group in In Progress is labelled "Unfiled" (see Section.tsx and
    // the UX doc's mockup), and the subtask's `"parentGroup"` row's own
    // `ParentGroupHeader` names its parent — no trail on either the header
    // or the subtask row (this task is loose, so there's no project to
    // show either way).
    await waitFor(() => screen.getByText("Unfiled"));
    expect(screen.getAllByText("Q4 invoicing cleanup").length).toBeGreaterThan(0);
  });
});

/**
 * Phase 4 panel collapse (`hooks/usePanelCollapse.ts` + `CollapsedRail.tsx`):
 * collapsing a panel replaces its `Section` with a `CollapsedRail`, hands the
 * freed space to the other (still `flex-1`) panel, enforces "never both
 * collapsed at once" by construction, and persists per list in localStorage
 * — deliberately NOT through the server/board data, so a fresh mount must
 * still see it via `localStorage` alone, without any RPC round trip.
 */
describe("TodoPage — panel collapse", () => {
  // This Node runtime ships a broken built-in `globalThis.localStorage`
  // (backed by no file, every method throws/undefined — see the
  // `--localstorage-file` startup warning), which vitest's jsdom
  // environment leaves in place instead of jsdom's own Storage
  // implementation. A real browser (what `usePanelCollapse.ts` actually
  // runs in) has a working `localStorage`; this in-memory stand-in exists
  // purely so THIS test environment does too.
  function installMemoryLocalStorage() {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
        setItem: (k: string, v: string) => {
          store.set(k, String(v));
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
        clear: () => {
          store.clear();
        },
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() {
          return store.size;
        },
      },
    });
  }

  beforeEach(() => {
    installMemoryLocalStorage();
  });

  function collapseBoard() {
    return {
      lists: [{ id: "lst_1", name: "Work", sortOrder: 1000, openCount: 1, overdueCount: 0 }],
      activeListId: "lst_1",
      inProgress: { planned: 2, completed: 1 },
      backlog: {
        total: 1,
        overdue: 0,
        tasks: [makeTask({ id: "tsk_1", title: "Draft the copy", stage: "pending" })],
      },
      totalOverdue: 0,
      serverNow: Date.now(),
      tags: [],
      projects: [],
    };
  }

  async function renderBoard() {
    const app = await loadPluginApp(() => import("@/app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) throw new Error("app.tsx has not registered the 'board' navPanel yet");
    const view = renderSlot(
      { component: board.component },
      { subPath: "" },
      { rpc: { getBoard: () => collapseBoard() } as never },
    );
    // Wait for the tab (always rendered regardless of panel collapse state)
    // rather than "Draft the copy" itself — a remounted, still-collapsed
    // Backlog never shows that task text at all.
    await waitFor(() => screen.getByText("Work"));
    return view;
  }

  it("collapsing Backlog gives In Progress full width", async () => {
    await renderBoard();

    // Both panels start expanded: two real Section headings, no rail yet.
    expect(screen.getByText("BACKLOG", { exact: false })).toBeTruthy();
    expect(screen.getByText("IN PROGRESS")).toBeTruthy();
    expect(screen.queryByLabelText(/^Expand /)).toBeNull();

    fireEvent.click(screen.getByLabelText("Collapse BACKLOG"));

    // Backlog is now a rail (its Section header is gone; the rail's own
    // "Expand" control is the only remaining trace of it), while In
    // Progress is untouched and still a full Section.
    const rail = await screen.findByLabelText("Expand BACKLOG");
    expect(screen.queryByLabelText("Collapse BACKLOG")).toBeNull();
    expect(screen.getByText("IN PROGRESS")).toBeTruthy();

    // The rail's own wrapper collapses to the fixed ~40px width class; the
    // still-expanded In Progress column keeps `flex-1`, so it's the one
    // that gets the freed space — "the other panel takes full width" is a
    // consequence of this class swap, not a separately-computed style.
    expect(rail.parentElement?.className).toContain("@3xl:w-9");
    expect(rail.parentElement?.className).toContain("@3xl:flex-none");
    const inProgressWrapper = screen.getByText("IN PROGRESS").closest("section")?.parentElement;
    expect(inProgressWrapper?.className).toContain("flex-1");
    expect(inProgressWrapper?.className).not.toContain("@3xl:w-9");
  });

  it("collapsing the second panel automatically restores the first", async () => {
    await renderBoard();

    fireEvent.click(screen.getByLabelText("Collapse BACKLOG"));
    await screen.findByLabelText("Expand BACKLOG");

    // Collapsing In Progress next must restore Backlog — never both
    // collapsed at once (enforced by the hook's single-value encoding, not
    // by anything in the view).
    fireEvent.click(screen.getByLabelText("Collapse IN PROGRESS"));

    await screen.findByLabelText("Expand IN PROGRESS");
    expect(screen.queryByLabelText("Expand BACKLOG")).toBeNull();
    expect(screen.getByText("BACKLOG", { exact: false })).toBeTruthy();
  });

  it("the collapse choice survives a remount via localStorage", async () => {
    const view = await renderBoard();

    fireEvent.click(screen.getByLabelText("Collapse BACKLOG"));
    await screen.findByLabelText("Expand BACKLOG");

    view.lifecycle.unmount();
    cleanup();

    // A brand-new mount for the SAME list, with no interaction at all — the
    // choice must come back from `localStorage.todo.panel.lst_1`, not from
    // any board/server data (this test's `getBoard` stub carries no notion
    // of collapse at all).
    await renderBoard();
    expect(await screen.findByLabelText("Expand BACKLOG")).toBeTruthy();
    expect(screen.queryByLabelText("Collapse BACKLOG")).toBeNull();
  });
});
