// @vitest-environment jsdom
// Behaviour of multiline titles and links across the capture row, the task
// row (tasks and subtasks), breadcrumbs, and Archive.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { AddTaskRow } from "./AddTaskRow";
import { TaskRow } from "./TaskRow";
import { TaskText } from "./TaskText";
import { TrailLine } from "./TrailLine";
import { ParentGroupHeader } from "./ParentGroupHeader";
import ArchivePanel from "./ArchivePanel";
import { SHORTCUT_HINT } from "./GrowingTextarea";
import { TooltipProvider } from "./ui/tooltip";
import type { TaskDto } from "../contract";
import type { BoardActions } from "./Section";

const archiveTasks: TaskDto[] = [];

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: () => undefined,
  useRpc: () => ({
    call: async (method: string) => {
      if (method === "getBoard") return { lists: [{ id: "lst_1", name: "Work" }] };
      return {
        groups: [{ day: "2026-08-20", tasks: archiveTasks }],
        total: archiveTasks.length,
        hasMore: false,
      };
    },
  }),
}));

afterEach(() => {
  cleanup();
  archiveTasks.length = 0;
});

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

function makeActions(overrides: Partial<BoardActions> = {}): BoardActions {
  return {
    now: 0,
    overId: null,
    onToggleComplete: vi.fn(),
    onRenameTask: vi.fn(),
    onUpdateTask: vi.fn().mockResolvedValue(undefined),
    onSetDue: vi.fn(),
    onDeleteTask: vi.fn(),
    onCreateTask: vi.fn(),
    tagCatalog: [],
    onSetTaskTags: vi.fn(),
    onCreateTag: vi.fn(),
    onStartTask: vi.fn(),
    onParkTask: vi.fn(),
    ...overrides,
  };
}

function renderRow(task: TaskDto, actions: BoardActions, indent = false) {
  return render(
    <TooltipProvider>
      <DndContext>
        <TaskRow task={task} actions={actions} indent={indent} />
      </DndContext>
    </TooltipProvider>,
  );
}

const ENTER = { key: "Enter" };
const SHIFT_ENTER = { key: "Enter", shiftKey: true };

describe("AddTaskRow", () => {
  function setup() {
    const onSubmit = vi.fn();
    render(<AddTaskRow placeholder="add task" onSubmit={onSubmit} />);
    const box = screen.getByLabelText("add task") as HTMLTextAreaElement;
    return { onSubmit, box };
  }

  it("is a textarea", () => {
    expect(setup().box.tagName).toBe("TEXTAREA");
  });

  it("Enter adds the task, clears the box, and keeps focus", () => {
    const { onSubmit, box } = setup();
    box.focus();
    fireEvent.change(box, { target: { value: "  Buy milk  " } });
    fireEvent.keyDown(box, ENTER);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Buy milk");
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);
  });

  it("Enter on an empty box adds nothing", () => {
    const { onSubmit, box } = setup();
    fireEvent.change(box, { target: { value: " \n " } });
    fireEvent.keyDown(box, ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Shift+Enter leaves the key to the browser, so it inserts a newline", () => {
    const { onSubmit, box } = setup();
    fireEvent.change(box, { target: { value: "line one" } });
    // fireEvent returns false when the handler called preventDefault().
    const notPrevented = fireEvent.keyDown(box, SHIFT_ENTER);
    expect(notPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box.value).toBe("line one");
  });

  it("keeps pasted lines in one task and normalises CRLF", () => {
    const { onSubmit, box } = setup();
    fireEvent.change(box, { target: { value: "first\r\n\r\nsecond\r\nhttps://a.dev" } });
    expect(box.value).toBe("first\n\nsecond\nhttps://a.dev");
    fireEvent.keyDown(box, ENTER);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("first\n\nsecond\nhttps://a.dev");
  });

  it("ignores Enter while an IME composition is active", () => {
    const { onSubmit, box } = setup();
    fireEvent.change(box, { target: { value: "にほん" } });
    fireEvent.keyDown(box, { ...ENTER, isComposing: true });
    fireEvent.keyDown(box, { ...ENTER, keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box.value).toBe("にほん");
  });

  it("Escape blurs without clearing", () => {
    const { onSubmit, box } = setup();
    box.focus();
    fireEvent.change(box, { target: { value: "draft" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(document.activeElement).not.toBe(box);
    expect(box.value).toBe("draft");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("describes the shortcuts with aria-describedby, visible only while focused", () => {
    const { box } = setup();
    const id = box.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const hint = document.getElementById(id as string) as HTMLElement;
    expect(hint.textContent).toBe(SHORTCUT_HINT);
    expect(SHORTCUT_HINT).toBe("Enter: add/save · Shift+Enter: new line");
    // Unfocused: visually hidden, so it adds no height.
    expect(hint.className).toContain("sr-only");
    fireEvent.focus(box);
    expect(hint.className).not.toContain("sr-only");
    fireEvent.blur(box);
    expect(hint.className).toContain("sr-only");
  });
});

describe("TaskRow editing", () => {
  function startEditing(task: TaskDto, actions = makeActions(), indent = false) {
    renderRow(task, actions, indent);
    // The title button's text spans every line, so match it by full content.
    fireEvent.click(
      screen.getByText((_, el) => el?.tagName === "BUTTON" && el.textContent === task.title),
    );
    return {
      actions,
      box: screen.getByLabelText("Task title") as HTMLTextAreaElement,
    };
  }

  it("shows the whole multiline title with its line breaks, wrapped", () => {
    const task = makeTask({ id: "t1", title: "line one\nline two\n\nline four" });
    renderRow(task, makeActions());
    const button = screen.getByText(/line one/);
    expect(button.textContent).toBe("line one\nline two\n\nline four");
    expect(button.className).toContain("whitespace-pre-wrap");
    expect(button.className).toContain("[overflow-wrap:anywhere]");
    expect(button.className).not.toContain("truncate");
  });

  it("edits in a textarea seeded with the full title", () => {
    const { box } = startEditing(makeTask({ id: "t1", title: "a\nb\nc" }));
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.value).toBe("a\nb\nc");
  });

  it("Enter saves once, with newlines kept", () => {
    const { actions, box } = startEditing(makeTask({ id: "t1", title: "old" }));
    fireEvent.change(box, { target: { value: "new one\r\nnew two" } });
    fireEvent.keyDown(box, ENTER);
    expect(actions.onRenameTask).toHaveBeenCalledTimes(1);
    expect(actions.onRenameTask).toHaveBeenCalledWith("t1", "new one\nnew two");
    expect(screen.queryByLabelText("Task title")).toBeNull();
  });

  it("Enter then a blur in the same event saves only once", () => {
    const { actions, box } = startEditing(makeTask({ id: "t1", title: "old" }));
    fireEvent.change(box, { target: { value: "new" } });
    // Runs after React's handler but before the textarea unmounts.
    const blurAfter = () => box.blur();
    document.addEventListener("keydown", blurAfter, { once: true });
    box.focus();
    fireEvent.keyDown(box, ENTER);
    expect(actions.onRenameTask).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter inserts a newline and does not save", () => {
    const { actions, box } = startEditing(makeTask({ id: "t1", title: "old" }));
    const notPrevented = fireEvent.keyDown(box, SHIFT_ENTER);
    expect(notPrevented).toBe(true);
    expect(actions.onRenameTask).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Task title")).toBe(box);
  });

  it("Escape cancels the edit and restores the title", () => {
    const task = makeTask({ id: "t1", title: "keep me" });
    const { actions, box } = startEditing(task);
    fireEvent.change(box, { target: { value: "changed" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(actions.onRenameTask).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Task title")).toBeNull();
    expect(screen.getByText("keep me")).toBeTruthy();
  });

  it("Escape cannot be followed by a blur that saves", () => {
    const { actions, box } = startEditing(makeTask({ id: "t1", title: "keep me" }));
    box.focus();
    fireEvent.change(box, { target: { value: "changed" } });
    // The browser can blur the textarea as it unmounts. Fire that blur
    // after React's Escape handler, before the unmount, to prove the
    // cancel is final.
    document.addEventListener("keydown", () => box.blur(), { once: true });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(actions.onRenameTask).not.toHaveBeenCalled();
  });

  it("saves on blur", () => {
    const { actions, box } = startEditing(makeTask({ id: "t1", title: "old" }));
    fireEvent.change(box, { target: { value: "blurred\nsave" } });
    fireEvent.blur(box);
    expect(actions.onRenameTask).toHaveBeenCalledWith("t1", "blurred\nsave");
  });

  it("does not rename when the text is unchanged or empty", () => {
    const { actions, box } = startEditing(makeTask({ id: "t1", title: "same" }));
    fireEvent.keyDown(box, ENTER);
    expect(actions.onRenameTask).not.toHaveBeenCalled();

    const second = startEditing(makeTask({ id: "t2", title: "other" }));
    fireEvent.change(second.box, { target: { value: " \n " } });
    fireEvent.keyDown(second.box, ENTER);
    expect(second.actions.onRenameTask).not.toHaveBeenCalled();
  });

  it("ignores Enter during IME composition", () => {
    const { actions, box } = startEditing(makeTask({ id: "t1", title: "old" }));
    fireEvent.change(box, { target: { value: "にほん" } });
    fireEvent.keyDown(box, { ...ENTER, isComposing: true });
    fireEvent.keyDown(box, { ...ENTER, keyCode: 229 });
    fireEvent.keyDown(box, { key: "Escape", isComposing: true });
    expect(actions.onRenameTask).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Task title")).toBe(box);
  });

  it("shows the shortcut hint while editing, wired with aria-describedby", () => {
    const { box } = startEditing(makeTask({ id: "t1", title: "old" }));
    const hint = document.getElementById(box.getAttribute("aria-describedby") as string);
    expect(hint?.textContent).toBe(SHORTCUT_HINT);
  });

  it("gives subtasks the same shortcuts", () => {
    const sub = makeTask({ id: "s1", parentId: "t1", title: "sub\nline" });
    const { actions, box } = startEditing(sub, makeActions(), true);
    expect(box.tagName).toBe("TEXTAREA");
    expect(fireEvent.keyDown(box, SHIFT_ENTER)).toBe(true);
    expect(actions.onRenameTask).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "sub\nline\nthree" } });
    fireEvent.keyDown(box, ENTER);
    expect(actions.onRenameTask).toHaveBeenCalledWith("s1", "sub\nline\nthree");
  });

  it("uses a one-line name in aria-labels for a multiline title", () => {
    renderRow(makeTask({ id: "t1", title: "one\ntwo" }), makeActions());
    expect(screen.getByLabelText('Mark "one two" done')).toBeTruthy();
    expect(screen.getByLabelText('Reorder "one two"')).toBeTruthy();
  });
});

describe("TaskRow links", () => {
  const URL_TITLE = "Read the notes\nhttps://example.com/release.";

  it("renders a safe anchor and leaves the trailing period outside it", () => {
    renderRow(makeTask({ id: "t1", title: URL_TITLE }), makeActions());
    const link = screen.getByRole("link", { name: "https://example.com/release" });
    expect(link.getAttribute("href")).toBe("https://example.com/release");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.className).toContain("underline");
    expect(link.className).toContain("text-primary");
    expect(link.className).toContain("focus-visible:ring-1");
  });

  it("opens through the host and does not edit, complete, or rename", () => {
    const onOpenUrl = vi.fn(() => true);
    const actions = makeActions({ onOpenUrl });
    renderRow(makeTask({ id: "t1", title: URL_TITLE }), actions);
    const link = screen.getByRole("link");
    const notPrevented = fireEvent.click(link);
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/release");
    // The host handled it, so the anchor's own navigation is cancelled.
    expect(notPrevented).toBe(false);
    expect(screen.queryByLabelText("Task title")).toBeNull();
    expect(actions.onToggleComplete).not.toHaveBeenCalled();
    expect(actions.onRenameTask).not.toHaveBeenCalled();
  });

  it("falls back to the anchor when the host declines or is absent", () => {
    const declined = vi.fn(() => false);
    renderRow(makeTask({ id: "t1", title: URL_TITLE }), makeActions({ onOpenUrl: declined }));
    expect(fireEvent.click(screen.getByRole("link"))).toBe(true);
    expect(declined).toHaveBeenCalled();
    expect(screen.queryByLabelText("Task title")).toBeNull();
  });

  it("leaves modifier clicks to the browser", () => {
    const onOpenUrl = vi.fn(() => true);
    renderRow(makeTask({ id: "t1", title: URL_TITLE }), makeActions({ onOpenUrl }));
    expect(fireEvent.click(screen.getByRole("link"), { metaKey: true })).toBe(true);
    expect(onOpenUrl).not.toHaveBeenCalled();
  });

  it("starts an edit when the text beside a link is clicked", () => {
    renderRow(makeTask({ id: "t1", title: URL_TITLE }), makeActions());
    fireEvent.click(screen.getByText(/Read the notes/));
    expect(screen.getByLabelText("Task title")).toBeTruthy();
  });

  it("keeps the link outside any button", () => {
    renderRow(makeTask({ id: "t1", title: URL_TITLE }), makeActions());
    expect(screen.getByRole("link").closest("button")).toBeNull();
  });

  it("gives a URL-only task a visible, keyboard-reachable edit button", () => {
    renderRow(makeTask({ id: "t1", title: "www.example.com/a_very_long_path" }), makeActions());
    const edit = screen.getByRole("button", { name: 'Edit "www.example.com/a_very_long_path"' });
    expect(edit.tagName).toBe("BUTTON");
    expect(edit.getAttribute("type")).toBe("button");
    expect(edit.className).not.toContain("opacity-0");
    edit.focus();
    expect(document.activeElement).toBe(edit);
    fireEvent.click(edit);
    expect(screen.getByLabelText("Task title")).toBeTruthy();
  });

  it("reveals the edit button on hover or focus for mixed text", () => {
    renderRow(makeTask({ id: "t1", title: URL_TITLE }), makeActions());
    const edit = screen.getByRole("button", { name: /^Edit "/ });
    expect(edit.className).toContain("opacity-0");
    expect(edit.className).toContain("focus-visible:opacity-100");
  });

  it("wraps a long URL inside the row", () => {
    renderRow(makeTask({ id: "t1", title: `https://example.com/${"a".repeat(200)}` }), makeActions());
    const wrapper = screen.getByRole("link").parentElement as HTMLElement;
    expect(wrapper.className).toContain("[overflow-wrap:anywhere]");
    expect(wrapper.className).toContain("whitespace-pre-wrap");
  });

  it("shows HTML-like text as plain text", () => {
    const title = '<img src=x onerror="alert(1)"> <b>bold</b>';
    const { container } = renderRow(makeTask({ id: "t1", title }), makeActions());
    expect(screen.getByText(title)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("never makes an anchor for a javascript: URL", () => {
    renderRow(makeTask({ id: "t1", title: "javascript:alert(1) and data:text/html,x" }), makeActions());
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("links inside subtasks too", () => {
    renderRow(
      makeTask({ id: "s1", parentId: "t1", title: "see www.example.com" }),
      makeActions(),
      true,
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://www.example.com");
  });
});

describe("TaskText", () => {
  it("renders every line and link from one plain string", () => {
    const { container } = render(<TaskText title={"a\nhttps://x.dev\nb"} />);
    expect(container.textContent).toBe("a\nhttps://x.dev\nb");
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });
});

describe("compact parent breadcrumbs", () => {
  const MULTI = "Ship it\nwith the second line\nhttps://x.dev";

  it("TrailLine shows the first line and exposes the full title", () => {
    render(
      <TrailLine
        trail={{
          projectId: null,
          projectName: null,
          projectColor: null,
          parentId: "p1",
          parentTitle: MULTI,
        }}
      />,
    );
    const button = screen.getAllByRole("button", {
      name: "Ship it with the second line https://x.dev",
    })[0] as HTMLElement;
    expect(button.getAttribute("title")).toBe("Ship it with the second line https://x.dev");
    expect(button.textContent).toBe("Ship it");
    expect(button.querySelector("a")).toBeNull();
  });

  it("TrailLine keeps a single-line title exactly as it was", () => {
    render(
      <TrailLine
        trail={{
          projectId: null,
          projectName: null,
          projectColor: null,
          parentId: "p1",
          parentTitle: "Plain parent",
        }}
      />,
    );
    const button = screen.getAllByRole("button", { name: "Plain parent" })[0] as HTMLElement;
    expect(button.hasAttribute("title")).toBe(false);
    expect(button.hasAttribute("aria-label")).toBe(false);
  });

  it("ParentGroupHeader shows the first line and exposes the full title", () => {
    render(<ParentGroupHeader parentId="p1" parentTitle={MULTI} />);
    const button = screen.getByRole("button", { name: "Ship it with the second line https://x.dev" });
    expect(button.textContent).toBe("Ship it");
    expect(button.getAttribute("title")).toBe("Ship it with the second line https://x.dev");
  });
});

describe("Archive", () => {
  it("shows the full multiline title with a link, and one-line action names", async () => {
    archiveTasks.push(
      makeTask({
        id: "a1",
        status: "done",
        completedAt: 1,
        title: "Archived thing\nsecond line\nhttps://example.com/done",
      }),
    );
    const onOpenUrl = vi.fn(() => true);
    render(
      <ArchivePanel
        listId="lst_1"
        open
        onOpenChange={() => undefined}
        onChanged={() => undefined}
        onOpenUrl={onOpenUrl}
      />,
    );
    const link = await waitFor(() => screen.getByRole("link", { name: "https://example.com/done" }));
    const text = link.parentElement as HTMLElement;
    expect(text.textContent).toBe("Archived thing\nsecond line\nhttps://example.com/done");
    expect(text.className).toContain("whitespace-pre-wrap");
    expect(text.className).not.toContain("truncate");
    expect(
      screen.getByRole("button", {
        name: "Restore Archived thing second line https://example.com/done",
      }),
    ).toBeTruthy();
    fireEvent.click(link);
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/done");
  });
});
