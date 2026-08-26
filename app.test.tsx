// @vitest-environment jsdom
//
// Frontend test suite for the plugin's `app.tsx` surfaces plus the
// Archive/Undo/Sidebar components this agent owns. `renderSlot` accepts any
// `{ component }` shape, not only registrations captured by `loadPluginApp`,
// so ArchivePanel / OverdueAccessory / TodoHeaderActions are exercised
// directly against a stubbed rpc — independent of whatever `app.tsx` /
// `TodoPage` (owned by another agent working in parallel) currently contain.
//
// The "board nav panel" tests at the bottom load the real `app.tsx` and will
// only pass once that agent has registered the `board` navPanel described in
// docs/SPEC.md; if it's missing or mid-flight they report a clear failure
// rather than a false pass.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  installTestPluginRuntime,
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { TagDto, TaskDto } from "@/contract";
import TodoHeaderActions from "./components/TodoHeaderActions";
import { TaskRow } from "./components/TaskRow";
import type { BoardActions } from "./components/Section";
import { emitBoardCommand, useBoardCommand } from "./lib/board-bus";

vi.mock("sonner", () => {
  const toast = vi.fn() as unknown as {
    (...args: unknown[]): void;
    error: (...args: unknown[]) => void;
  };
  toast.error = vi.fn();
  return { toast };
});
import { toast } from "sonner";

// `@get-bb/plugin-sdk/app` binds its hooks (useRpc, useRealtime, …) to
// `globalThis.__bbPluginRuntime.pluginSdkApp` once, the first time that
// module is evaluated. Any component that imports it — ArchivePanel,
// OverdueAccessory, useCompleteWithUndo — must therefore be imported
// AFTER `installTestPluginRuntime()` runs, via dynamic import; a static
// top-level import would bind those hooks to `undefined` before the test
// runtime exists. `TodoHeaderActions` and `lib/board-bus` don't touch the
// SDK, so they stay static imports above.
installTestPluginRuntime();
const { default: ArchivePanel } = await import("./components/ArchivePanel");
const { default: OverdueAccessory } = await import(
  "./components/OverdueAccessory"
);
const { useCompleteWithUndo } = await import("./hooks/useCompleteWithUndo");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "tsk_1",
    listId: "lst_1",
    parentId: null,
    title: "Standup",
    notes: null,
    bucket: "today",
    day: "2026-08-20",
    sortOrder: 1000,
    dueAt: null,
    hasDueTime: false,
    status: "done",
    completedAt: Date.now(),
    carriedCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    subtasks: [],
    subtaskCounts: { total: 0, done: 0 },
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// lib/board-bus
// ---------------------------------------------------------------------------

describe("board-bus", () => {
  it("delivers commands to subscribers and stops after unsubscribe", () => {
    const received: string[] = [];
    function Listener() {
      useBoardCommand((cmd) => received.push(cmd));
      return null;
    }
    const view = renderSlot({ component: Listener }, {});
    emitBoardCommand("open-archive");
    expect(received).toEqual(["open-archive"]);
    view.unmount();
    emitBoardCommand("create-list");
    expect(received).toEqual(["open-archive"]);
  });

  it("emitting with no listener mounted is a no-op, never throws", () => {
    expect(() => emitBoardCommand("open-archive")).not.toThrow();
  });

  it("supports multiple simultaneous subscribers", () => {
    const a: string[] = [];
    const b: string[] = [];
    function ListenerA() {
      useBoardCommand((cmd) => a.push(cmd));
      return null;
    }
    function ListenerB() {
      useBoardCommand((cmd) => b.push(cmd));
      return null;
    }
    renderSlot({ component: ListenerA }, {});
    renderSlot({ component: ListenerB }, {});
    emitBoardCommand("create-list");
    expect(a).toEqual(["create-list"]);
    expect(b).toEqual(["create-list"]);
  });
});

// ---------------------------------------------------------------------------
// components/TodoHeaderActions
// ---------------------------------------------------------------------------

describe("TodoHeaderActions", () => {
  it("emits open-archive and create-list with accessible buttons", () => {
    const received: string[] = [];
    function Listener() {
      useBoardCommand((cmd) => received.push(cmd));
      return null;
    }
    renderSlot({ component: Listener }, {});
    renderSlot({ component: TodoHeaderActions }, {});

    fireEvent.click(screen.getByRole("button", { name: /open archive/i }));
    fireEvent.click(screen.getByRole("button", { name: /create a new tab/i }));

    expect(received).toEqual(["open-archive", "create-list"]);
  });
});

// ---------------------------------------------------------------------------
// components/OverdueAccessory
// ---------------------------------------------------------------------------

describe("OverdueAccessory", () => {
  it("shows the overdue count from getBoard", async () => {
    renderSlot(
      { component: OverdueAccessory },
      {},
      {
        rpc: {
          getBoard: () => ({
            lists: [],
            activeListId: "lst_1",
            today: { day: "2026-08-20", planned: 0, completed: 0, tasks: [] },
            backlog: { total: 0, overdue: 0, tasks: [] },
            totalOverdue: 5,
            serverNow: Date.now(),
          }),
        } as never,
      },
    );
    await waitFor(() => {
      expect(screen.getByText(/5/)).toBeTruthy();
    });
  });

  it("renders nothing when totalOverdue is 0", async () => {
    const { container } = renderSlot(
      { component: OverdueAccessory },
      {},
      {
        rpc: {
          getBoard: () => ({
            lists: [],
            activeListId: "lst_1",
            today: { day: "2026-08-20", planned: 0, completed: 0, tasks: [] },
            backlog: { total: 0, overdue: 0, tasks: [] },
            totalOverdue: 0,
            serverNow: Date.now(),
          }),
        } as never,
      },
    );
    await waitFor(() => {
      expect(container.textContent).toBe("");
    });
  });

  it("never throws when getBoard rejects", async () => {
    renderSlot(
      { component: OverdueAccessory },
      {},
      {
        rpc: {
          getBoard: () => {
            throw new Error("boom");
          },
        } as never,
      },
    );
    await waitFor(() => {
      // Still mounted, no crash.
      expect(document.body).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// hooks/useCompleteWithUndo
// ---------------------------------------------------------------------------

function CompleteHarness({ onChanged }: { onChanged: () => void }) {
  const complete = useCompleteWithUndo(onChanged);
  return (
    <button onClick={() => complete({ id: "tsk_1", title: "Standup" })}>
      Complete
    </button>
  );
}

describe("useCompleteWithUndo", () => {
  it("completes, toasts with an Undo action, and calls onChanged", async () => {
    const onChanged = vi.fn();
    const view = renderSlot(
      { component: CompleteHarness },
      { onChanged },
      {
        rpc: {
          completeTask: () => ({ completedIds: ["tsk_1", "tsk_2"] }),
          restoreTasks: () => ({ ok: true as const }),
        } as never,
      },
    );

    fireEvent.click(screen.getByRole("button", { name: /complete/i }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
    expect(
      view.inspection.rpcCalls.some((c) => c.method === "completeTask"),
    ).toBe(true);
    expect(toast).toHaveBeenCalledWith(
      "Done · Standup",
      expect.objectContaining({
        duration: 8000,
        action: expect.objectContaining({ label: "Undo" }),
      }),
    );

    // Fire the Undo action with the exact server-reported completedIds.
    const call = (toast as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as { action: { onClick: () => void } };
    call.action.onClick();

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(2);
    });
    const restoreCall = view.inspection.rpcCalls.find(
      (c) => c.method === "restoreTasks",
    );
    expect(restoreCall?.input).toEqual({ ids: ["tsk_1", "tsk_2"] });
  });

  it("surfaces a completeTask failure via toast.error, never silently", async () => {
    const onChanged = vi.fn();
    renderSlot(
      { component: CompleteHarness },
      { onChanged },
      {
        rpc: {
          completeTask: () => {
            throw new Error("nope");
          },
          restoreTasks: () => ({ ok: true as const }),
        } as never,
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /complete/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(onChanged).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// components/ArchivePanel
// ---------------------------------------------------------------------------

describe("ArchivePanel", () => {
  it("fetches the archive for the given list on open", async () => {
    const view = renderSlot(
      { component: ArchivePanel },
      {
        listId: "lst_1",
        open: true,
        onOpenChange: vi.fn(),
        onChanged: vi.fn(),
      },
      {
        rpc: {
          getArchive: () => ({
            groups: [
              { day: "2026-08-20", tasks: [makeTask()] },
            ],
            total: 1,
            hasMore: false,
          }),
          getBoard: () => ({
            lists: [
              { id: "lst_1", name: "Work", sortOrder: 1000, openCount: 0, overdueCount: 0 },
            ],
            activeListId: "lst_1",
            today: { day: "2026-08-20", planned: 0, completed: 0, tasks: [] },
            backlog: { total: 0, overdue: 0, tasks: [] },
            totalOverdue: 0,
            serverNow: Date.now(),
          }),
        } as never,
      },
    );

    await waitFor(() => {
      expect(screen.getByText("Archive · Work")).toBeTruthy();
    });
    expect(
      view.inspection.rpcCalls.some((c) => c.method === "getArchive"),
    ).toBe(true);
    expect(screen.getByText("Standup")).toBeTruthy();
  });

  it("restore calls restoreTasks with the row's id", async () => {
    const onChanged = vi.fn();
    const view = renderSlot(
      { component: ArchivePanel },
      {
        listId: "lst_1",
        open: true,
        onOpenChange: vi.fn(),
        onChanged,
      },
      {
        rpc: {
          getArchive: () => ({
            groups: [{ day: "2026-08-20", tasks: [makeTask()] }],
            total: 1,
            hasMore: false,
          }),
          getBoard: () => ({
            lists: [
              { id: "lst_1", name: "Work", sortOrder: 1000, openCount: 0, overdueCount: 0 },
            ],
            activeListId: "lst_1",
            today: { day: "2026-08-20", planned: 0, completed: 0, tasks: [] },
            backlog: { total: 0, overdue: 0, tasks: [] },
            totalOverdue: 0,
            serverNow: Date.now(),
          }),
          restoreTasks: () => ({ ok: true as const }),
        } as never,
      },
    );

    await waitFor(() => screen.getByText("Standup"));
    fireEvent.click(screen.getByRole("button", { name: /restore standup/i }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    const restoreCall = view.inspection.rpcCalls.find(
      (c) => c.method === "restoreTasks",
    );
    expect(restoreCall?.input).toEqual({ ids: ["tsk_1"] });
  });

  it("clearArchive fires only after confirming in the AlertDialog", async () => {
    const onChanged = vi.fn();
    const view = renderSlot(
      { component: ArchivePanel },
      {
        listId: "lst_1",
        open: true,
        onOpenChange: vi.fn(),
        onChanged,
      },
      {
        rpc: {
          getArchive: () => ({
            groups: [{ day: "2026-08-20", tasks: [makeTask()] }],
            total: 1,
            hasMore: false,
          }),
          getBoard: () => ({
            lists: [
              { id: "lst_1", name: "Work", sortOrder: 1000, openCount: 0, overdueCount: 0 },
            ],
            activeListId: "lst_1",
            today: { day: "2026-08-20", planned: 0, completed: 0, tasks: [] },
            backlog: { total: 0, overdue: 0, tasks: [] },
            totalOverdue: 0,
            serverNow: Date.now(),
          }),
          clearArchive: () => ({ deleted: 1 }),
        } as never,
      },
    );

    await waitFor(() => screen.getByText("Standup"));

    fireEvent.click(screen.getByRole("button", { name: /^clear all$/i }));
    expect(
      view.inspection.rpcCalls.some((c) => c.method === "clearArchive"),
    ).toBe(false);

    const confirmButton = await screen.findByRole("button", {
      name: /delete 1 item/i,
    });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(
        view.inspection.rpcCalls.some((c) => c.method === "clearArchive"),
      ).toBe(true);
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows a friendly empty state with nothing archived", async () => {
    renderSlot(
      { component: ArchivePanel },
      {
        listId: "lst_1",
        open: true,
        onOpenChange: vi.fn(),
        onChanged: vi.fn(),
      },
      {
        rpc: {
          getArchive: () => ({ groups: [], total: 0, hasMore: false }),
          getBoard: () => ({
            lists: [
              { id: "lst_1", name: "Work", sortOrder: 1000, openCount: 0, overdueCount: 0 },
            ],
            activeListId: "lst_1",
            today: { day: "2026-08-20", planned: 0, completed: 0, tasks: [] },
            backlog: { total: 0, overdue: 0, tasks: [] },
            totalOverdue: 0,
            serverNow: Date.now(),
          }),
        } as never,
      },
    );

    await waitFor(() => {
      expect(screen.getByText(/nothing archived yet/i)).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// components/TaskRow — inline actions (calendar, plus, "..." menu)
// ---------------------------------------------------------------------------

// `TaskRow` requires the tag members of `BoardActions` (the picker always
// renders, even when a test doesn't care about tags), so this fixture
// supplies harmless stand-ins for them alongside the pre-existing fields.
function makeActions(overrides: Partial<BoardActions> = {}): BoardActions {
  return {
    now: Date.now(),
    overId: null,
    onToggleComplete: vi.fn(),
    onRenameTask: vi.fn(),
    onSetDue: vi.fn(),
    onDeleteTask: vi.fn(),
    onCreateTask: vi.fn(),
    tagCatalog: [],
    onSetTaskTags: vi.fn(),
    onCreateTag: vi.fn(async (name: string, color: TagDto["color"]) => ({
      id: "tag_new",
      name,
      color,
      sortOrder: 1000,
      taskCount: 0,
    })),
    ...overrides,
  };
}

describe("TaskRow inline actions", () => {
  it("the calendar button opens the due date popover", async () => {
    renderSlot(
      { component: TaskRow },
      { task: makeTask({ title: "Q3 planning doc" }), actions: makeActions() },
      {},
    );

    expect(screen.queryByText("Today 6pm")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: 'Set due date for "Q3 planning doc"' }),
    );
    await waitFor(() => {
      expect(screen.getByText("Today 6pm")).toBeTruthy();
    });
  });

  it("the plus button reveals an inline subtask input on a top-level row", async () => {
    renderSlot(
      { component: TaskRow },
      { task: makeTask({ title: "Q3 planning doc" }), actions: makeActions() },
      {},
    );

    expect(screen.queryByPlaceholderText("add subtask")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: 'Add a subtask to "Q3 planning doc"' }),
    );
    await waitFor(() => {
      expect(screen.getByPlaceholderText("add subtask")).toBeTruthy();
    });
  });

  it("the plus button is absent on subtask rows", () => {
    renderSlot(
      { component: TaskRow },
      {
        task: makeTask({ id: "tsk_sub", title: "Pull last quarter's numbers", parentId: "tsk_1" }),
        actions: makeActions(),
        indent: true,
      },
      {},
    );

    expect(
      screen.queryByRole("button", {
        name: 'Add a subtask to "Pull last quarter\'s numbers"',
      }),
    ).toBeNull();
  });

  it("shows an age chip alongside the due chip on a rendered row", async () => {
    const NOON = new Date(2026, 7, 20, 12, 0, 0, 0).getTime();
    const HOUR = 60 * 60 * 1000;
    renderSlot(
      { component: TaskRow },
      {
        task: makeTask({
          title: "Ship the invoice fix",
          createdAt: NOON - 3 * HOUR,
          dueAt: NOON + 22 * 60 * 1000,
          hasDueTime: false,
        }),
        actions: makeActions({ now: NOON }),
      },
      {},
    );

    expect(screen.getByText("added 3h ago")).toBeTruthy();
    expect(screen.getByText("in 22 min")).toBeTruthy();
  });

  it("the \"...\" menu contains Delete only, no Set due date or Add subtask", async () => {
    renderSlot(
      { component: TaskRow },
      { task: makeTask({ title: "Q3 planning doc" }), actions: makeActions() },
      {},
    );

    const trigger = screen.getByRole("button", {
      name: 'More actions for "Q3 planning doc"',
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /delete/i })).toBeTruthy();
    });
    expect(screen.queryByRole("menuitem", { name: /set due date/i })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /add subtask/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The full board nav panel, loaded from the real app.tsx (owned by another
// agent working in parallel). These assert the documented behaviour from
// docs/SPEC.md; if `app.tsx` hasn't registered the `board` navPanel yet, they
// fail loudly rather than silently passing.
// ---------------------------------------------------------------------------

describe("board nav panel (app.tsx)", () => {
  it("registers a navPanel with id 'board' and a headerContent + sidebar accessory", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const board = app.navPanels.find((p) => p.id === "board");
    expect(board, "app.tsx has not registered the 'board' navPanel yet").toBeTruthy();
    expect(board?.headerContent).toBeTruthy();
    expect(board?.experimental_sidebarAccessory).toBeTruthy();
  });

  it("renders both Backlog and Today sections from stubbed rpc", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const board = app.navPanels.find((p) => p.id === "board");
    if (!board) {
      throw new Error("app.tsx has not registered the 'board' navPanel yet");
    }
    renderSlot(
      { component: board.component },
      { subPath: "" },
      {
        rpc: {
          getBoard: () => ({
            lists: [
              { id: "lst_1", name: "Work", sortOrder: 1000, openCount: 1, overdueCount: 0 },
            ],
            activeListId: "lst_1",
            today: {
              day: "2026-08-20",
              planned: 1,
              completed: 0,
              tasks: [makeTask({ status: "open", bucket: "today" })],
            },
            backlog: { total: 0, overdue: 0, tasks: [] },
            totalOverdue: 0,
            serverNow: Date.now(),
            tags: [],
          }),
        } as never,
      },
    );

    await waitFor(() => {
      expect(screen.getByText(/backlog/i)).toBeTruthy();
      expect(screen.getByText(/today/i)).toBeTruthy();
    });
  });

  it("the add row calls createTask", async () => {
    const app = await loadPluginApp(() => import("./app"));
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
              { id: "lst_1", name: "Work", sortOrder: 1000, openCount: 0, overdueCount: 0 },
            ],
            activeListId: "lst_1",
            today: { day: "2026-08-20", planned: 0, completed: 0, tasks: [] },
            backlog: { total: 0, overdue: 0, tasks: [] },
            totalOverdue: 0,
            serverNow: Date.now(),
            tags: [],
          }),
          createTask: (input: unknown) => ({
            task: makeTask({ status: "open", ...(input as object) }),
          }),
        } as never,
      },
    );

    // The board's first paint is async (useRpc().call returns a Promise), so
    // wait for the add row to exist before typing into it.
    // Both sections render an add row, so scope the query to one of them
    // rather than matching /add to (today|backlog)/ and hitting two elements.
    const input = await screen.findByPlaceholderText(/add to today/i);
    fireEvent.change(input, { target: { value: "New task" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(
        view.inspection.rpcCalls.some((c) => c.method === "createTask"),
      ).toBe(true);
    });
  });

  it("ticking a checkbox calls completeTask", async () => {
    const app = await loadPluginApp(() => import("./app"));
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
              { id: "lst_1", name: "Work", sortOrder: 1000, openCount: 1, overdueCount: 0 },
            ],
            activeListId: "lst_1",
            today: {
              day: "2026-08-20",
              planned: 1,
              completed: 0,
              tasks: [makeTask({ id: "tsk_open", status: "open" })],
            },
            backlog: { total: 0, overdue: 0, tasks: [] },
            totalOverdue: 0,
            serverNow: Date.now(),
            tags: [],
          }),
          completeTask: () => ({ completedIds: ["tsk_open"] }),
        } as never,
      },
    );

    // Same here: wait for the row to paint before clicking its checkbox.
    const checkbox = await screen.findByRole("checkbox", { name: /standup/i });
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(
        view.inspection.rpcCalls.some((c) => c.method === "completeTask"),
      ).toBe(true);
    });
  });
});
