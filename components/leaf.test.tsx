// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { AgeChip } from "./AgeChip";
import { DueChip } from "./DueChip";
import { ProgressRing } from "./ProgressRing";
import { TagChip } from "./TagChip";
import { TagChips } from "./TagChips";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import { TrailLine } from "./TrailLine";
import { ProjectHeader } from "./ProjectHeader";
import { ProjectGroup } from "./ProjectGroup";
import { TaskRow } from "./TaskRow";
import { TooltipProvider } from "./ui/tooltip";
import type { ProjectDto, TagRefDto, TaskDto, TrailDto } from "../contract";
import type { BoardActions } from "./Section";

afterEach(() => {
  cleanup();
});

const NOON = new Date(2024, 0, 10, 12, 0, 0, 0).getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("DueChip", () => {
  it("renders nothing when there is no due date", () => {
    const { container } = render(
      <DueChip dueAt={null} hasDueTime={false} now={NOON} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders neutral tone text and classes", () => {
    render(<DueChip dueAt={NOON + 3 * HOUR} hasDueTime={false} now={NOON} />);
    const el = screen.getByText("in 3 hours");
    expect(el.className).toContain("text-muted-foreground");
  });

  it("renders soon tone text and classes", () => {
    render(<DueChip dueAt={NOON + 5 * MINUTE} hasDueTime={false} now={NOON} />);
    const el = screen.getByText("in 5 min");
    expect(el.className).toContain("text-amber-600");
  });

  it("renders late tone text and classes", () => {
    render(<DueChip dueAt={NOON - 3 * HOUR} hasDueTime={false} now={NOON} />);
    const el = screen.getByText("3 hours late");
    expect(el.className).toContain("text-destructive");
  });

  it("includes a title attribute with the absolute date/time", () => {
    render(<DueChip dueAt={NOON + 3 * HOUR} hasDueTime={false} now={NOON} />);
    const el = screen.getByText("in 3 hours");
    const title = el.getAttribute("title");
    expect(title).toBeTruthy();
    expect(title).not.toBe("");
  });
});

describe("AgeChip", () => {
  it("renders the expected 'added N ago' text", () => {
    render(<AgeChip createdAt={NOON - 3 * HOUR} now={NOON} />);
    expect(screen.getByText("added 3h ago")).toBeTruthy();
  });

  it("renders 'added just now' just after creation", () => {
    render(<AgeChip createdAt={NOON - 5 * 1000} now={NOON} />);
    expect(screen.getByText("added just now")).toBeTruthy();
  });

  it("exposes the absolute date via a title attribute", () => {
    render(<AgeChip createdAt={NOON - 2 * DAY} now={NOON} />);
    const el = screen.getByText("added 2d ago");
    const title = el.getAttribute("title");
    expect(title).toBeTruthy();
    expect(title).toContain("2024");
  });

  it("is always muted, never carries a tone class", () => {
    render(<AgeChip createdAt={NOON - 3 * DAY} now={NOON} />);
    const el = screen.getByText("added 3d ago");
    expect(el.className).toContain("text-muted-foreground");
    expect(el.className).not.toContain("text-amber");
    expect(el.className).not.toContain("text-destructive");
  });
});

describe("ProgressRing", () => {
  it("renders nothing when total is 0", () => {
    const { container } = render(<ProgressRing done={0} total={0} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders an accessible label describing progress", () => {
    render(<ProgressRing done={2} total={5} />);
    expect(screen.getByRole("img", { name: "2 of 5 subtasks done" })).toBeTruthy();
    expect(screen.getByText("2/5")).toBeTruthy();
  });

  it("clamps done to total when done exceeds total", () => {
    render(<ProgressRing done={9} total={5} />);
    expect(screen.getByRole("img", { name: "5 of 5 subtasks done" })).toBeTruthy();
  });

  it("defaults to the primary tone arc color", () => {
    const { container } = render(<ProgressRing done={2} total={5} />);
    const arc = container.querySelectorAll("circle")[1] as SVGCircleElement;
    expect(arc.getAttribute("class")).toContain("text-primary");
  });

  it("renders the destructive tone arc color", () => {
    const { container } = render(
      <ProgressRing done={3} total={12} tone="destructive" />,
    );
    const arc = container.querySelectorAll("circle")[1] as SVGCircleElement;
    expect(arc.getAttribute("class")).toContain("text-destructive");
  });

  it("keeps the track muted regardless of tone", () => {
    const { container } = render(
      <ProgressRing done={3} total={12} tone="destructive" />,
    );
    const track = container.querySelectorAll("circle")[0] as SVGCircleElement;
    expect(track.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("overrides the numeric label when `label` is given", () => {
    render(<ProgressRing done={3} total={12} label="3/12 overdue" />);
    expect(screen.getByText("3/12 overdue")).toBeTruthy();
    expect(screen.queryByText("3/12")).toBeNull();
  });

  it("overrides the accessible name when `ariaLabel` is given", () => {
    render(
      <ProgressRing done={3} total={12} ariaLabel="Backlog: 3/12 overdue" />,
    );
    expect(
      screen.getByRole("img", { name: "Backlog: 3/12 overdue" }),
    ).toBeTruthy();
  });
});

const URGENT: TagRefDto = { id: "tag_1", name: "urgent", color: "red" };

describe("TagChip", () => {
  it("renders the name at full width", () => {
    render(
      <TooltipProvider>
        <TagChip tag={URGENT} />
      </TooltipProvider>,
    );
    expect(screen.getByText("urgent")).toBeTruthy();
  });

  it("renders only a tooltip trigger, no visible name, when compact", () => {
    render(
      <TooltipProvider>
        <TagChip tag={URGENT} compact />
      </TooltipProvider>,
    );
    expect(screen.queryByText("urgent")).toBeNull();
    expect(screen.getByLabelText("urgent")).toBeTruthy();
  });

  // Regression test: the compact dot used to be a bare, unfocusable <span>,
  // so a keyboard-only user could never reveal a tag's name below the `md`
  // breakpoint. It stays non-interactive semantically (no button role, no
  // action) — the fix only needs to make it a real focus target so Radix's
  // tooltip opens on focus too.
  it("compact mode is keyboard-focusable, without taking on button semantics", () => {
    render(
      <TooltipProvider>
        <TagChip tag={URGENT} compact />
      </TooltipProvider>,
    );
    const trigger = screen.getByLabelText("urgent");
    expect(trigger.getAttribute("tabindex")).toBe("0");
    expect(trigger.getAttribute("role")).not.toBe("button");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("TagChips", () => {
  const tags: TagRefDto[] = [
    { id: "tag_1", name: "urgent", color: "red" },
    { id: "tag_2", name: "bug", color: "amber" },
    { id: "tag_3", name: "qa", color: "green" },
    { id: "tag_4", name: "design", color: "blue" },
    { id: "tag_5", name: "docs", color: "violet" },
  ];

  it("renders null for an empty array", () => {
    const { container } = render(
      <TooltipProvider>
        <TagChips tags={[]} />
      </TooltipProvider>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders a +N overflow counter past the cap", () => {
    render(
      <TooltipProvider>
        <TagChips tags={tags} />
      </TooltipProvider>,
    );
    // 5 tags, full-width cap is 3 -> 2 hidden.
    expect(screen.getByLabelText("2 more tags")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
  });
});

describe("ColorSwatchPicker", () => {
  it("marks the selected swatch with aria-pressed", () => {
    render(<ColorSwatchPicker value="teal" onChange={() => {}} />);
    const selected = screen.getByRole("button", { name: "Teal" });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    const other = screen.getByRole("button", { name: "Slate" });
    expect(other.getAttribute("aria-pressed")).toBe("false");
  });

  it("fires onChange with the clicked color", () => {
    const onChange = vi.fn();
    render(<ColorSwatchPicker value="teal" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Pink" }));
    expect(onChange).toHaveBeenCalledWith("pink");
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — Projects: TrailLine, ProjectHeader, ProjectGroup, TaskRow ghosts
// ---------------------------------------------------------------------------

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

function makeProject(overrides: Partial<ProjectDto> & { id: string }): ProjectDto {
  return {
    listId: "lst_1",
    name: "Q3 Launch",
    color: "teal",
    sortOrder: 1000,
    collapsed: false,
    openCount: 0,
    todayCount: 0,
    overdueCount: 0,
    ...overrides,
  };
}

function makeActions(overrides: Partial<BoardActions> = {}): BoardActions {
  return {
    now: 0,
    overId: null,
    onToggleComplete: vi.fn(),
    onRenameTask: vi.fn(),
    onSetDue: vi.fn(),
    onDeleteTask: vi.fn(),
    onCreateTask: vi.fn(),
    tagCatalog: [],
    onSetTaskTags: vi.fn(),
    onCreateTag: vi.fn(),
    ...overrides,
  };
}

/** TaskRow/ProjectGroup use dnd-kit's `useSortable`/`useDroppable`, which
 * need a live DndContext provider to resolve refs/listeners. */
function renderWithDnd(ui: React.ReactElement) {
  return render(<DndContext>{ui}</DndContext>);
}

describe("TrailLine", () => {
  it("renders nothing for a loose top-level task (trail is null)", () => {
    const { container } = render(<TrailLine trail={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when trail has neither project nor parent context", () => {
    const trail: TrailDto = {
      projectId: null,
      projectName: null,
      projectColor: null,
      parentId: null,
      parentTitle: null,
    };
    const { container } = render(<TrailLine trail={trail} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the project badge and parent segment when both are present", () => {
    const trail: TrailDto = {
      projectId: "prj_1",
      projectName: "Q3 Launch",
      projectColor: "teal",
      parentId: "tsk_1",
      parentTitle: "Rewrite the onboarding email",
    };
    render(<TrailLine trail={trail} />);
    expect(screen.getAllByText("Q3 Launch").length).toBeGreaterThan(0);
    expect(screen.getByText("Rewrite the onboarding email")).toBeTruthy();
  });

  it("truncates the parent segment from the left (dir=rtl + truncate)", () => {
    const trail: TrailDto = {
      projectId: "prj_1",
      projectName: "Q3 Launch",
      projectColor: "teal",
      parentId: "tsk_1",
      parentTitle: "Rewrite the very long onboarding email sequence for new hires",
    };
    render(<TrailLine trail={trail} />);
    const label = screen.getByText(
      "Rewrite the very long onboarding email sequence for new hires",
    );
    // The title sits inside a <bdi> isolate; the rtl box is its button parent.
    expect(label.tagName).toBe("BDI");
    const parentButton = label.closest("button");
    expect(parentButton).not.toBeNull();
    expect(parentButton?.getAttribute("dir")).toBe("rtl");
    expect(parentButton?.className).toContain("truncate");
  });

  it("isolates the parent title in a <bdi> so rtl truncation cannot reorder punctuation", () => {
    // Without the isolate, dir="rtl" renders "Ship it?" as "?Ship it" and
    // mirrors paired brackets. jsdom cannot lay text out, so assert the
    // isolate is present rather than the glyph order.
    const trail: TrailDto = {
      projectId: "prj_1",
      projectName: "Q3 Launch",
      projectColor: "teal",
      parentId: "tsk_1",
      parentTitle: "Ship it? (urgent)",
    };
    render(<TrailLine trail={trail} />);
    const label = screen.getByText("Ship it? (urgent)");
    expect(label.tagName).toBe("BDI");
    expect(label.closest("button")?.getAttribute("dir")).toBe("rtl");
  });

  it("falls back to the parent segment below md when the parent has no project", () => {
    const trail: TrailDto = {
      projectId: null,
      projectName: null,
      projectColor: null,
      parentId: "tsk_1",
      parentTitle: "Rewrite the onboarding email",
    };
    render(<TrailLine trail={trail} />);
    // Both breakpoint siblings render it, so the compact line is never an
    // empty padded row for a subtask whose parent is loose.
    expect(screen.getAllByText("Rewrite the onboarding email")).toHaveLength(2);
  });

  it("collapses to the project badge alone below md via the hidden/flex sibling pair", () => {
    const trail: TrailDto = {
      projectId: "prj_1",
      projectName: "Q3 Launch",
      projectColor: "teal",
      parentId: "tsk_1",
      parentTitle: "Rewrite the onboarding email",
    };
    const { container } = render(<TrailLine trail={trail} />);
    const fullRow = container.querySelector(".hidden.md\\:flex");
    const compactRow = container.querySelector(".flex.md\\:hidden");
    expect(fullRow).toBeTruthy();
    expect(compactRow).toBeTruthy();
    // Full row carries both segments; compact row carries the badge only.
    expect(fullRow?.textContent).toContain("Rewrite the onboarding email");
    expect(compactRow?.textContent).not.toContain("Rewrite the onboarding email");
    expect(compactRow?.textContent).toContain("Q3 Launch");
  });

  it("fires onNavigateToProject / onNavigateToParent with the segment's id", () => {
    const onNavigateToProject = vi.fn();
    const onNavigateToParent = vi.fn();
    const trail: TrailDto = {
      projectId: "prj_1",
      projectName: "Q3 Launch",
      projectColor: "teal",
      parentId: "tsk_1",
      parentTitle: "Rewrite the onboarding email",
    };
    render(
      <TrailLine
        trail={trail}
        onNavigateToProject={onNavigateToProject}
        onNavigateToParent={onNavigateToParent}
      />,
    );
    fireEvent.click(screen.getAllByText("Q3 Launch")[0]);
    expect(onNavigateToProject).toHaveBeenCalledWith("prj_1");
    fireEvent.click(screen.getByText("Rewrite the onboarding email"));
    expect(onNavigateToParent).toHaveBeenCalledWith("tsk_1");
  });
});

describe("ProjectHeader", () => {
  it("renders counts as 'N open · M today'", () => {
    render(
      <ProjectHeader
        project={makeProject({ id: "prj_1", openCount: 4, todayCount: 1 })}
        onToggleCollapsed={() => {}}
        onRename={() => {}}
        onChangeColor={() => {}}
        onDelete={() => {}}
        onAddTask={() => {}}
      />,
    );
    expect(screen.getByText("4 open · 1 today")).toBeTruthy();
  });

  it("omits the today segment when todayCount is 0", () => {
    render(
      <ProjectHeader
        project={makeProject({ id: "prj_1", openCount: 3, todayCount: 0 })}
        onToggleCollapsed={() => {}}
        onRename={() => {}}
        onChangeColor={() => {}}
        onDelete={() => {}}
        onAddTask={() => {}}
      />,
    );
    expect(screen.getByText("3 open")).toBeTruthy();
    expect(screen.queryByText(/today/)).toBeNull();
  });

  it("fires onToggleCollapsed when the chevron is clicked", () => {
    const onToggleCollapsed = vi.fn();
    render(
      <ProjectHeader
        project={makeProject({ id: "prj_1", collapsed: false })}
        onToggleCollapsed={onToggleCollapsed}
        onRename={() => {}}
        onChangeColor={() => {}}
        onDelete={() => {}}
        onAddTask={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('Collapse "Q3 Launch"'));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("renames via double-click, Enter to commit", () => {
    const onRename = vi.fn();
    render(
      <ProjectHeader
        project={makeProject({ id: "prj_1", name: "Q3 Launch" })}
        onToggleCollapsed={() => {}}
        onRename={onRename}
        onChangeColor={() => {}}
        onDelete={() => {}}
        onAddTask={() => {}}
      />,
    );
    fireEvent.doubleClick(screen.getByText("Q3 Launch"));
    const input = screen.getByLabelText("Rename project Q3 Launch");
    fireEvent.change(input, { target: { value: "Q4 Launch" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("Q4 Launch");
  });

  it("shows the exact delete-confirm copy from the spec", () => {
    render(
      <ProjectHeader
        project={makeProject({ id: "prj_1", name: "Q3 Launch", openCount: 4 })}
        onToggleCollapsed={() => {}}
        onRename={() => {}}
        onChangeColor={() => {}}
        onDelete={() => {}}
        onAddTask={() => {}}
      />,
    );
    fireEvent.pointerDown(screen.getByLabelText('More actions for project "Q3 Launch"'));
    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByText('Delete "Q3 Launch"?')).toBeTruthy();
    expect(
      screen.getByText("4 tasks will move to the Backlog, unfiled. Nothing is deleted."),
    ).toBeTruthy();
  });

  it("fires onDelete when the confirm button is clicked", () => {
    const onDelete = vi.fn();
    render(
      <ProjectHeader
        project={makeProject({ id: "prj_1", name: "Q3 Launch", openCount: 4 })}
        onToggleCollapsed={() => {}}
        onRename={() => {}}
        onChangeColor={() => {}}
        onDelete={onDelete}
        onAddTask={() => {}}
      />,
    );
    fireEvent.pointerDown(screen.getByLabelText('More actions for project "Q3 Launch"'));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getAllByText("Delete").slice(-1)[0]);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("ProjectGroup", () => {
  it("collapsed renders the header only — no body, no add-row", () => {
    render(
      <DndContext>
        <ProjectGroup
          project={makeProject({ id: "prj_1", collapsed: true, openCount: 2 })}
          tasks={[makeTask({ id: "tsk_1", title: "Draft the copy" })]}
          actions={makeActions()}
          onToggleCollapsed={() => {}}
          onRenameProject={() => {}}
          onChangeProjectColor={() => {}}
          onDeleteProject={() => {}}
          onAddTaskToProject={() => {}}
        />
      </DndContext>,
    );
    expect(screen.getByText("Q3 Launch")).toBeTruthy();
    expect(screen.queryByText("Draft the copy")).toBeNull();
    expect(screen.queryByPlaceholderText(/add to/)).toBeNull();
  });

  it("empty (expanded) project shows the header and only its add-row", () => {
    render(
      <DndContext>
        <ProjectGroup
          project={makeProject({ id: "prj_1", collapsed: false, openCount: 0 })}
          tasks={[]}
          actions={makeActions()}
          onToggleCollapsed={() => {}}
          onRenameProject={() => {}}
          onChangeProjectColor={() => {}}
          onDeleteProject={() => {}}
          onAddTaskToProject={() => {}}
        />
      </DndContext>,
    );
    expect(screen.getByText("Q3 Launch")).toBeTruthy();
    expect(screen.getByPlaceholderText("add to Q3 Launch")).toBeTruthy();
  });

  it("renders each task as a TaskRow, ghosting today-flagged tasks", () => {
    render(
      <DndContext>
        <ProjectGroup
          project={makeProject({ id: "prj_1", collapsed: false, openCount: 2 })}
          tasks={[
            makeTask({ id: "tsk_1", title: "Draft the copy", bucket: "backlog" }),
            makeTask({
              id: "tsk_2",
              title: "Get legal sign-off",
              bucket: "today",
              day: "2026-08-27",
            }),
          ]}
          actions={makeActions()}
          onToggleCollapsed={() => {}}
          onRenameProject={() => {}}
          onChangeProjectColor={() => {}}
          onDeleteProject={() => {}}
          onAddTaskToProject={() => {}}
        />
      </DndContext>,
    );
    expect(screen.getByText("Draft the copy")).toBeTruthy();
    expect(screen.getByText("Get legal sign-off")).toBeTruthy();
    expect(screen.getByLabelText('Unschedule "Get legal sign-off"')).toBeTruthy();
    expect(screen.queryByLabelText('Unschedule "Draft the copy"')).toBeNull();
  });

  it("forwards a new-task title to onAddTaskToProject with the project id", () => {
    const onAddTaskToProject = vi.fn();
    render(
      <DndContext>
        <ProjectGroup
          project={makeProject({ id: "prj_1", collapsed: false })}
          tasks={[]}
          actions={makeActions()}
          onToggleCollapsed={() => {}}
          onRenameProject={() => {}}
          onChangeProjectColor={() => {}}
          onDeleteProject={() => {}}
          onAddTaskToProject={onAddTaskToProject}
        />
      </DndContext>,
    );
    const input = screen.getByPlaceholderText("add to Q3 Launch");
    fireEvent.change(input, { target: { value: "New task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAddTaskToProject).toHaveBeenCalledWith("prj_1", "New task");
  });

  // Phase 6 obligation 3: the header's "+" used to be a pass-through prop
  // that focused nothing (ProjectGroup stayed "dumb", per its own doc
  // comment). It must now both reveal (expand a collapsed project) and
  // focus the per-project add-task input.
  it("the header's '+' reveals and focuses the add-row on a collapsed project", () => {
    function Harness() {
      const [collapsed, setCollapsed] = useState(true);
      return (
        <DndContext>
          <ProjectGroup
            project={makeProject({ id: "prj_1", collapsed, openCount: 1 })}
            tasks={[makeTask({ id: "tsk_1", title: "Draft the copy" })]}
            actions={makeActions()}
            onToggleCollapsed={() => setCollapsed(false)}
            onRenameProject={() => {}}
            onChangeProjectColor={() => {}}
            onDeleteProject={() => {}}
            onAddTaskToProject={() => {}}
          />
        </DndContext>
      );
    }
    render(<Harness />);

    expect(screen.queryByPlaceholderText("add to Q3 Launch")).toBeNull();
    fireEvent.click(screen.getByLabelText('Add task to "Q3 Launch"'));

    const input = screen.getByPlaceholderText("add to Q3 Launch");
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it("the header's '+' refocuses the add-row when the project is already expanded", () => {
    render(
      <DndContext>
        <ProjectGroup
          project={makeProject({ id: "prj_1", collapsed: false, openCount: 1 })}
          tasks={[makeTask({ id: "tsk_1", title: "Draft the copy" })]}
          actions={makeActions()}
          onToggleCollapsed={() => {}}
          onRenameProject={() => {}}
          onChangeProjectColor={() => {}}
          onDeleteProject={() => {}}
          onAddTaskToProject={() => {}}
        />
      </DndContext>,
    );

    const input = screen.getByPlaceholderText("add to Q3 Launch");
    input.blur();
    expect(document.activeElement).not.toBe(input);

    fireEvent.click(screen.getByLabelText('Add task to "Q3 Launch"'));

    expect(document.activeElement).toBe(screen.getByPlaceholderText("add to Q3 Launch"));
  });
});

describe("TaskRow — ghost state", () => {
  it("renders dimmed with the ghost glyph and the '· today' marker", () => {
    const task = makeTask({ id: "tsk_1", title: "Get legal sign-off", bucket: "today" });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} ghost />);
    const row = screen.getByText("Get legal sign-off").closest("[data-ghost]");
    expect(row).toBeTruthy();
    expect(row?.className).toContain("opacity-60");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/· today/)).toBeTruthy();
  });

  it("does not show the carry count below the threshold (carriedCount 2)", () => {
    const task = makeTask({
      id: "tsk_1",
      title: "Get legal sign-off",
      bucket: "today",
      carriedCount: 2,
    });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} ghost />);
    const marker = screen.getByLabelText('Unschedule "Get legal sign-off"');
    expect(marker.textContent).not.toContain("~2");
  });

  it("shows the carry count once carriedCount >= 3", () => {
    const task = makeTask({
      id: "tsk_1",
      title: "Get legal sign-off",
      bucket: "today",
      carriedCount: 3,
    });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} ghost />);
    const marker = screen.getByLabelText('Unschedule "Get legal sign-off"');
    expect(marker.textContent).toContain("~3");
  });

  it("clicking the marker calls onUnschedule with the task id", () => {
    const onUnschedule = vi.fn();
    const task = makeTask({ id: "tsk_1", title: "Get legal sign-off", bucket: "today" });
    renderWithDnd(
      <TaskRow task={task} actions={makeActions()} ghost onUnschedule={onUnschedule} />,
    );
    fireEvent.click(screen.getByLabelText('Unschedule "Get legal sign-off"'));
    expect(onUnschedule).toHaveBeenCalledWith("tsk_1");
  });

  it("a non-ghost row keeps the normal checkbox and no marker", () => {
    const task = makeTask({ id: "tsk_1", title: "Ship the invoice fix", bucket: "today" });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} />);
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.queryByText(/· today/)).toBeNull();
  });

  it("renders the trail line when showTrail is set and the task has trail context", () => {
    const trail: TrailDto = {
      projectId: "prj_1",
      projectName: "Q3 Launch",
      projectColor: "teal",
      parentId: "tsk_parent",
      parentTitle: "Rewrite the onboarding email",
    };
    const task = makeTask({
      id: "tsk_1",
      title: "Get legal sign-off",
      bucket: "today",
      trail,
    });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} showTrail />);
    expect(screen.getByText("Rewrite the onboarding email")).toBeTruthy();
  });

  it("renders no trail line for a loose task even when showTrail is set", () => {
    const task = makeTask({ id: "tsk_1", title: "Ship the invoice fix", bucket: "today" });
    const { container } = renderWithDnd(
      <TaskRow task={task} actions={makeActions()} showTrail />,
    );
    // No trail content anywhere in the rendered row.
    expect(container.querySelector("[dir='rtl']")).toBeNull();
  });
});
