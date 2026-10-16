// @vitest-environment jsdom
// Image attachments in the UI: pasting into the add row and the task editor,
// thumbnails with removal and preview, and the failure/race paths — a slow
// read, a slow or failing save, Escape, unmount, double Enter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { AddTaskRow } from "./AddTaskRow";
import { TaskRow } from "./TaskRow";
import { TooltipProvider } from "./ui/tooltip";
import { IMAGE_LIMITS, type ImageDto, type TaskDto } from "../contract";
import type { BoardActions } from "./Section";
import ArchivePanel from "./ArchivePanel";

const archiveTasks: TaskDto[] = [];

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: () => undefined,
  useRpc: () => ({
    call: async (method: string) => {
      if (method === "getBoard") return { lists: [{ id: "lst_1", name: "Work" }] };
      return { groups: [{ day: "2026-08-20", tasks: archiveTasks }], total: archiveTasks.length, hasMore: false };
    },
  }),
}));

// ---------------------------------------------------------------------------
// A FileReader we can hold open, to test what happens while a read is slow.
// ---------------------------------------------------------------------------

class SlowFileReader {
  static pending: SlowFileReader[] = [];
  static auto = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | null = null;
  private file: File | null = null;

  readAsDataURL(file: File) {
    this.file = file;
    if (SlowFileReader.auto) queueMicrotask(() => this.finish());
    else SlowFileReader.pending.push(this);
  }
  finish() {
    this.result = `data:${this.file?.type};base64,QUJD`;
    this.onload?.();
  }
  static async flush() {
    const batch = SlowFileReader.pending.splice(0);
    await act(async () => {
      for (const r of batch) r.finish();
    });
  }
}

const RealFileReader = globalThis.FileReader;
beforeEach(() => {
  SlowFileReader.pending = [];
  SlowFileReader.auto = false;
  (globalThis as any).FileReader = SlowFileReader;
});
afterEach(() => {
  cleanup();
  (globalThis as any).FileReader = RealFileReader;
  vi.restoreAllMocks();
});

function pngFile(name = "shot.png", type = "image/png", size = 8): File {
  return new File([new Uint8Array(size)], name, { type });
}

function clipboard(files: File[], text = "") {
  return {
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
    files,
    getData: (kind: string) => (kind === "text/plain" ? text : ""),
  };
}

function paste(box: HTMLElement, files: File[], text = "") {
  return fireEvent.paste(box, { clipboardData: clipboard(files, text) });
}

const ENTER = { key: "Enter" };

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeImage(id: string): ImageDto {
  return { id, mime: "image/png", size: 10, createdAt: 1, url: `/api/v1/plugins/todo/http/image?id=${id}` };
}

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "t1",
    listId: "lst_1",
    parentId: null,
    title: "Write report",
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

function renderRow(task: TaskDto, actions: BoardActions) {
  return render(
    <TooltipProvider>
      <DndContext>
        <TaskRow task={task} actions={actions} />
      </DndContext>
    </TooltipProvider>,
  );
}

function startEditing(task: TaskDto, actions = makeActions()) {
  const view = renderRow(task, actions);
  fireEvent.click(screen.getByText(task.title));
  const box = screen.getByLabelText("Task title") as HTMLTextAreaElement;
  return { ...view, actions, box };
}

// ---------------------------------------------------------------------------

describe("AddTaskRow images", () => {
  function setup(onSubmit = vi.fn()) {
    const view = render(<AddTaskRow placeholder="add task" onSubmit={onSubmit} />);
    const box = screen.getByLabelText("add task") as HTMLTextAreaElement;
    return { ...view, onSubmit, box };
  }

  it("leaves a text paste alone", () => {
    const { box, onSubmit } = setup();
    const notPrevented = fireEvent.paste(box, { clipboardData: clipboard([], "just text") });
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps text paste when the clipboard also carries a rendered image", () => {
    const { box } = setup();
    const notPrevented = paste(box, [pngFile()], "A1\tB1");
    expect(notPrevented).toBe(true);
    expect(SlowFileReader.pending).toHaveLength(0);
  });

  it("attaches a pasted image and sends it with the title", async () => {
    SlowFileReader.auto = true;
    const { box, onSubmit } = setup(vi.fn().mockResolvedValue(undefined));
    paste(box, [pngFile()]);
    await screen.findByLabelText(/Preview image 1 of 1/);
    fireEvent.change(box, { target: { value: "Buy milk" } });
    fireEvent.keyDown(box, ENTER);
    await waitFor(() => expect(box.value).toBe(""));
    expect(onSubmit).toHaveBeenCalledWith("Buy milk", [{ data: "QUJD" }]);
    expect(screen.queryByLabelText(/Preview image/)).toBeNull();
  });

  it("removes a pending thumbnail before submit", async () => {
    SlowFileReader.auto = true;
    const { box, onSubmit } = setup();
    paste(box, [pngFile()]);
    fireEvent.click(await screen.findByLabelText(/Remove image 1 of 1/));
    expect(screen.queryByLabelText(/Preview image/)).toBeNull();
    fireEvent.change(box, { target: { value: "no image" } });
    fireEvent.keyDown(box, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("no image"); // text-only path, one argument
  });

  it("keeps text and images and shows the error when the upload fails", async () => {
    SlowFileReader.auto = true;
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("image 1 is larger than 5 MB")).mockResolvedValue(undefined);
    const { box } = setup(onSubmit);
    paste(box, [pngFile()]);
    await screen.findByLabelText(/Preview image 1 of 1/);
    fireEvent.change(box, { target: { value: "keep me" } });
    fireEvent.keyDown(box, ENTER);
    expect((await screen.findByRole("alert")).textContent).toContain("larger than 5 MB");
    expect(box.value).toBe("keep me");
    expect(box.readOnly).toBe(false);
    expect(screen.getByLabelText(/Preview image 1 of 1/)).toBeTruthy();

    fireEvent.keyDown(box, ENTER); // retry works
    await waitFor(() => expect(box.value).toBe(""));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("blocks edits, paste, and a second submit while the upload is in flight", async () => {
    SlowFileReader.auto = true;
    const gate = deferred();
    const onSubmit = vi.fn().mockReturnValue(gate.promise);
    const { box } = setup(onSubmit);
    paste(box, [pngFile()]);
    await screen.findByLabelText(/Preview image 1 of 1/);
    fireEvent.change(box, { target: { value: "slow one" } });

    fireEvent.keyDown(box, ENTER);
    fireEvent.keyDown(box, ENTER); // same tick: must not submit twice
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(box.readOnly).toBe(true);

    paste(box, [pngFile("two.png")]); // ignored while busy
    expect(screen.queryByLabelText(/Preview image 2/)).toBeNull();
    expect(screen.queryByLabelText(/Remove image/)).toBeNull();

    await act(async () => gate.resolve());
    await waitFor(() => expect(box.value).toBe(""));
    expect(screen.queryByLabelText(/Preview image/)).toBeNull();
    expect(box.readOnly).toBe(false);
  });

  it("ignores Enter while an image is still being read, then submits it", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { box } = setup(onSubmit);
    paste(box, [pngFile()]);
    fireEvent.change(box, { target: { value: "wait for it" } });
    expect(screen.getByRole("status", { name: "Reading image" })).toBeTruthy();
    fireEvent.keyDown(box, ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box.value).toBe("wait for it");

    await SlowFileReader.flush();
    fireEvent.keyDown(box, ENTER);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("wait for it", [{ data: "QUJD" }]));
  });

  it("does not set state when a read finishes after unmount", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { box, unmount } = setup();
    paste(box, [pngFile()]);
    unmount();
    await SlowFileReader.flush();
    expect(errors).not.toHaveBeenCalled();
  });

  it("asks for a title when only an image is present", async () => {
    SlowFileReader.auto = true;
    const { box, onSubmit } = setup();
    paste(box, [pngFile()]);
    await screen.findByLabelText(/Preview image 1 of 1/);
    fireEvent.keyDown(box, ENTER);
    expect((await screen.findByRole("alert")).textContent).toMatch(/title/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses unsupported and oversized files with a visible reason", async () => {
    const { box } = setup();
    paste(box, [pngFile("logo.svg", "image/svg+xml")]);
    expect((await screen.findByRole("alert")).textContent).toMatch(/PNG, JPEG, GIF, or WebP/);
    paste(box, [pngFile("huge.png", "image/png", IMAGE_LIMITS.maxBytes + 1)]);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/larger than 5 MB/));
    expect(SlowFileReader.pending).toHaveLength(0);
  });

  it("stops at the per-task image limit", async () => {
    SlowFileReader.auto = true;
    const { box } = setup();
    paste(box, Array.from({ length: IMAGE_LIMITS.maxPerTask + 2 }, (_, i) => pngFile(`${i}.png`)));
    await waitFor(() => expect(screen.getAllByLabelText(/Preview image/)).toHaveLength(IMAGE_LIMITS.maxPerTask));
    expect(screen.getByRole("alert").textContent).toMatch(/at most 10/);
  });
});

// ---------------------------------------------------------------------------

describe("TaskRow images", () => {
  it("shows thumbnails on a task row and previews full size", async () => {
    renderRow(makeTask({ images: [makeImage("img_a"), makeImage("img_b")] }), makeActions());
    const thumbs = screen.getAllByLabelText(/Preview image/);
    expect(thumbs).toHaveLength(2);
    expect(screen.queryByLabelText(/Remove image/)).toBeNull(); // read-only outside the editor
    expect(document.querySelector('img[src$="id=img_a"]')).toBeTruthy();

    fireEvent.click(thumbs[1]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Image 2 of 2")).toBeTruthy();
    expect(within(dialog).getByAltText(/Image 2 of 2/).getAttribute("src")).toContain("id=img_b");
  });

  it("renders the same task twice without duplicate element ids", () => {
    const task = makeTask({ images: [makeImage("img_a")] });
    const actions = makeActions();
    render(
      <TooltipProvider>
        <DndContext>
          <TaskRow task={task} actions={actions} />
          <TaskRow task={task} actions={actions} inProgressColumn />
        </DndContext>
      </TooltipProvider>,
    );
    const ids = Array.from(document.querySelectorAll("[id]")).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.includes("img_a"))).toBe(false);
  });

  it("removes an existing image in the editor and saves it with Enter", async () => {
    const task = makeTask({ images: [makeImage("img_a"), makeImage("img_b")] });
    const { actions, box } = startEditing(task);
    fireEvent.click(screen.getAllByLabelText(/Remove image 1 of 2/)[0]);
    expect(screen.getAllByLabelText(/Preview image/)).toHaveLength(1);
    fireEvent.keyDown(box, ENTER);
    await waitFor(() => expect(screen.queryByLabelText("Task title")).toBeNull());
    expect(actions.onUpdateTask).toHaveBeenCalledWith("t1", { removeImageIds: ["img_a"] });
    expect(actions.onRenameTask).not.toHaveBeenCalled();
  });

  it("Escape discards staged removals and pasted images", async () => {
    SlowFileReader.auto = true;
    const task = makeTask({ images: [makeImage("img_a")] });
    const { actions, box } = startEditing(task);
    fireEvent.click(screen.getByLabelText(/Remove image 1 of 1/));
    paste(box, [pngFile()]);
    await screen.findByLabelText(/Preview image 1 of 1/);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(actions.onUpdateTask).not.toHaveBeenCalled();
    // Editing again shows only the stored image.
    fireEvent.click(screen.getByText("Write report"));
    expect(screen.getAllByLabelText(/Preview image/)).toHaveLength(1);
    expect(screen.getByLabelText(/Remove image 1 of 1/)).toBeTruthy();
  });

  it("a read that finishes after Escape does not come back", async () => {
    const { actions, box } = startEditing(makeTask());
    paste(box, [pngFile()]);
    fireEvent.keyDown(box, { key: "Escape" });
    await SlowFileReader.flush();
    fireEvent.click(screen.getByText("Write report"));
    expect(screen.queryByLabelText(/Preview image/)).toBeNull();
    expect(actions.onUpdateTask).not.toHaveBeenCalled();
  });

  for (const how of ["Enter", "blur"] as const) {
    it(`${how} while an image is still being read does not close the editor or lose the image`, async () => {
      const { actions, box } = startEditing(makeTask());
      paste(box, [pngFile()]);
      fireEvent.change(box, { target: { value: "Edited title" } });
      if (how === "Enter") fireEvent.keyDown(box, ENTER);
      else fireEvent.blur(box);
      expect(actions.onUpdateTask).not.toHaveBeenCalled();
      expect(actions.onRenameTask).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Task title")).toBe(box);

      await SlowFileReader.flush();
      expect(screen.getByLabelText(/Preview image 1 of 1/)).toBeTruthy();
      fireEvent.keyDown(box, ENTER);
      await waitFor(() =>
        expect(actions.onUpdateTask).toHaveBeenCalledWith("t1", {
          title: "Edited title",
          addImages: [{ data: "QUJD" }],
        }),
      );
      expect(actions.onRenameTask).not.toHaveBeenCalled();
    });
  }

  it("keeps the editor open with draft and images when saving fails", async () => {
    SlowFileReader.auto = true;
    const onUpdateTask = vi.fn().mockRejectedValueOnce(new Error("a task can have at most 10 images")).mockResolvedValue(undefined);
    const { box } = startEditing(makeTask(), makeActions({ onUpdateTask }));
    paste(box, [pngFile()]);
    await screen.findByLabelText(/Preview image 1 of 1/);
    fireEvent.change(box, { target: { value: "My new text" } });
    fireEvent.keyDown(box, ENTER);
    expect((await screen.findByRole("alert")).textContent).toContain("at most 10 images");
    expect(screen.getByLabelText("Task title")).toBe(box);
    expect(box.value).toBe("My new text");
    expect(box.readOnly).toBe(false);
    expect(screen.getByLabelText(/Preview image 1 of 1/)).toBeTruthy();

    fireEvent.keyDown(box, ENTER); // retry
    await waitFor(() => expect(screen.queryByLabelText("Task title")).toBeNull());
    expect(onUpdateTask).toHaveBeenCalledTimes(2);
  });

  it("locks the editor while a save is in flight, then keeps what was saved", async () => {
    SlowFileReader.auto = true;
    const gate = deferred();
    const onUpdateTask = vi.fn().mockReturnValue(gate.promise);
    const { box } = startEditing(makeTask(), makeActions({ onUpdateTask }));
    paste(box, [pngFile()]);
    await screen.findByLabelText(/Preview image 1 of 1/);
    fireEvent.keyDown(box, ENTER);
    fireEvent.keyDown(box, ENTER); // double Enter
    fireEvent.blur(box); // and a blur
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
    expect(box.readOnly).toBe(true);

    paste(box, [pngFile("two.png")]); // ignored
    fireEvent.keyDown(box, { key: "Escape" }); // cannot cancel a save in flight
    expect(screen.getByLabelText("Task title")).toBe(box);
    expect(screen.queryByLabelText(/Remove image/)).toBeNull();

    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByLabelText("Task title")).toBeNull());
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
  });

  it("does not save when focus moves from the text to a thumbnail button", () => {
    const task = makeTask({ images: [makeImage("img_a")] });
    const { actions, box } = startEditing(task);
    const remove = screen.getByLabelText(/Remove image 1 of 1/);
    fireEvent.blur(box, { relatedTarget: remove });
    expect(actions.onUpdateTask).not.toHaveBeenCalled();
    expect(actions.onRenameTask).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Task title")).toBe(box);
  });

  it("opening the preview from the editor does not save the edit", async () => {
    const task = makeTask({ images: [makeImage("img_a")] });
    const { actions, box } = startEditing(task);
    fireEvent.change(box, { target: { value: "half typed" } });
    fireEvent.click(screen.getByLabelText(/Preview image 1 of 1/));
    await screen.findByRole("dialog");
    fireEvent.blur(box); // focus moves into the dialog
    expect(actions.onRenameTask).not.toHaveBeenCalled();
    expect(actions.onUpdateTask).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Task title") as HTMLTextAreaElement).value).toBe("half typed");
  });

  it("a plain text edit still renames without an image call", () => {
    const { actions, box } = startEditing(makeTask({ images: [makeImage("img_a")] }));
    fireEvent.change(box, { target: { value: "Renamed" } });
    fireEvent.keyDown(box, ENTER);
    expect(actions.onRenameTask).toHaveBeenCalledWith("t1", "Renamed");
    expect(actions.onUpdateTask).not.toHaveBeenCalled();
  });

  it("adds a subtask with an image and stays open until it is accepted", async () => {
    SlowFileReader.auto = true;
    const gate = deferred();
    const onCreateTask = vi.fn().mockReturnValue(gate.promise);
    renderRow(makeTask(), makeActions({ onCreateTask }));
    fireEvent.click(screen.getByLabelText(/Add a subtask/));
    const box = screen.getByLabelText("add subtask");
    paste(box, [pngFile()]);
    await screen.findByLabelText(/Preview image 1 of 1/);
    fireEvent.change(box, { target: { value: "child" } });
    fireEvent.keyDown(box, ENTER);
    expect(onCreateTask).toHaveBeenCalledWith({
      stage: "pending",
      parentId: "t1",
      title: "child",
      images: [{ data: "QUJD" }],
    });
    expect(screen.getByLabelText("add subtask")).toBe(box);
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByLabelText("add subtask")).toBeNull());
  });
});

describe("Archive images", () => {
  it("shows an archived task's images as keyboard-reachable, read-only thumbnails with preview", async () => {
    archiveTasks.length = 0;
    archiveTasks.push(makeTask({ id: "t9", title: "Done thing", status: "done", completedAt: 1, images: [makeImage("img_z")] }));
    render(<ArchivePanel listId="lst_1" open onOpenChange={() => undefined} onChanged={() => undefined} />);
    const thumb = await screen.findByLabelText(/Preview image 1 of 1 for "Done thing"/);
    expect(thumb.tagName).toBe("BUTTON"); // Tab reaches it; Enter and Space open it
    expect(thumb.getAttribute("tabindex")).not.toBe("-1");
    expect(screen.queryByLabelText(/Remove image/)).toBeNull();
    fireEvent.click(thumb);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByAltText(/Image 1 of 1/).getAttribute("src")).toContain("id=img_z");
  });
});

describe("keyboard controls", () => {
  it("makes thumbnail preview and remove real, focusable buttons with names", () => {
    startEditing(makeTask({ images: [makeImage("img_a")] }));
    for (const name of [/Preview image 1 of 1/, /Remove image 1 of 1/]) {
      const button = screen.getByLabelText(name);
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.getAttribute("tabindex")).not.toBe("-1");
    }
  });
});
