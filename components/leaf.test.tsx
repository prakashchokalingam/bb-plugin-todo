// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { AgeChip } from "./AgeChip";
import { DueChip } from "./DueChip";
import { ProgressRing } from "./ProgressRing";
import { TagChip } from "./TagChip";
import { TagChips } from "./TagChips";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import { TrailLine } from "./TrailLine";
import { ParentGroupHeader } from "./ParentGroupHeader";
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

function makeProject(overrides: Partial<ProjectDto> & { id: string }): ProjectDto {
  return {
    listId: "lst_1",
    name: "Q3 Launch",
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

/** TaskRow/ProjectGroup use dnd-kit's `useSortable`/`useDroppable`, which
 * need a live DndContext provider to resolve refs/listeners. Every raw
 * `<DndContext>` in this file (including this helper's own) is also
 * wrapped in a `TooltipProvider`: TaskRow's ▶/◀ stage-toggle button (added
 * alongside the one-click stage toggle feature) renders a Radix `Tooltip`,
 * which throws if mounted outside one — `TodoPage` supplies that context at
 * the real app's root, so every standalone leaf render that can reach a
 * TaskRow needs the same. */
function renderWithDnd(ui: React.ReactElement) {
  return render(
    <TooltipProvider>
      <DndContext>{ui}</DndContext>
    </TooltipProvider>,
  );
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

  it("hideProject suppresses the project badge, keeping the parent segment", () => {
    const trail: TrailDto = {
      projectId: "prj_1",
      projectName: "Q3 Launch",
      projectColor: "teal",
      parentId: "tsk_1",
      parentTitle: "Rewrite the onboarding email",
    };
    render(<TrailLine trail={trail} hideProject />);
    expect(screen.queryByText("Q3 Launch")).toBeNull();
    expect(screen.getAllByText("Rewrite the onboarding email").length).toBeGreaterThan(0);
  });

  it("hideProject with no parent context renders nothing (nothing left to show)", () => {
    const trail: TrailDto = {
      projectId: "prj_1",
      projectName: "Q3 Launch",
      projectColor: "teal",
      parentId: null,
      parentTitle: null,
    };
    const { container } = render(<TrailLine trail={trail} hideProject />);
    expect(container.innerHTML).toBe("");
  });

  it("defaults hideProject to false — Archive's existing usage is unaffected", () => {
    const trail: TrailDto = {
      projectId: "prj_1",
      projectName: "Q3 Launch",
      projectColor: "teal",
      parentId: "tsk_1",
      parentTitle: "Rewrite the onboarding email",
    };
    render(<TrailLine trail={trail} />);
    expect(screen.getAllByText("Q3 Launch").length).toBeGreaterThan(0);
  });
});

describe("ProjectHeader", () => {
  it("renders counts as 'N open · M in progress'", () => {
    render(
      <ProjectHeader
        project={makeProject({ id: "prj_1", openCount: 4, inProgressCount: 1 })}
        onToggleCollapsed={() => {}}
        onRename={() => {}}
        onChangeColor={() => {}}
        onDelete={() => {}}
        onAddTask={() => {}}
      />,
    );
    expect(screen.getByText("4 open · 1 in progress")).toBeTruthy();
  });

  it("omits the in-progress segment when inProgressCount is 0", () => {
    render(
      <ProjectHeader
        project={makeProject({ id: "prj_1", openCount: 3, inProgressCount: 0 })}
        onToggleCollapsed={() => {}}
        onRename={() => {}}
        onChangeColor={() => {}}
        onDelete={() => {}}
        onAddTask={() => {}}
      />,
    );
    expect(screen.getByText("3 open")).toBeTruthy();
    expect(screen.queryByText(/in progress/)).toBeNull();
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

  it("variant='in_progress' renders a read-only label: no colour picker, rename, add, or menu", () => {
    render(
      <ProjectHeader
        project={makeProject({ id: "prj_1", name: "Q3 Launch", openCount: 3, inProgressCount: 2 })}
        variant="in_progress"
        onToggleCollapsed={() => {}}
      />,
    );
    expect(screen.getByText("Q3 Launch")).toBeTruthy();
    expect(screen.getByText("3 open · 2 in progress")).toBeTruthy();
    expect(screen.queryByLabelText('Change color for project "Q3 Launch"')).toBeNull();
    expect(screen.queryByLabelText('Add task to "Q3 Launch"')).toBeNull();
    expect(screen.queryByLabelText('More actions for project "Q3 Launch"')).toBeNull();
    // The name is no longer an editable button — double-click does nothing.
    fireEvent.doubleClick(screen.getByText("Q3 Launch"));
    expect(screen.queryByLabelText("Rename project Q3 Launch")).toBeNull();
  });

  it("variant='in_progress' still lets collapse work", () => {
    const onToggleCollapsed = vi.fn();
    render(
      <ProjectHeader
        project={makeProject({ id: "prj_1", collapsed: false })}
        variant="in_progress"
        onToggleCollapsed={onToggleCollapsed}
      />,
    );
    fireEvent.click(screen.getByLabelText('Collapse "Q3 Launch"'));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("draggable=false renders a non-grab cursor on the header", () => {
    const { container } = render(
      <ProjectHeader
        project={makeProject({ id: "prj_1" })}
        draggable={false}
        onToggleCollapsed={() => {}}
      />,
    );
    expect(container.querySelector(".cursor-default")).toBeTruthy();
  });
});

describe("ProjectGroup", () => {
  it("collapsed renders the header only — no body, no add-row", () => {
    render(
      <TooltipProvider>
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
      </DndContext>
      </TooltipProvider>,
    );
    expect(screen.getByText("Q3 Launch")).toBeTruthy();
    expect(screen.queryByText("Draft the copy")).toBeNull();
    expect(screen.queryByPlaceholderText(/add to/)).toBeNull();
  });

  it("empty (expanded) project shows the header and only its add-row", () => {
    render(
      <TooltipProvider>
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
      </DndContext>
      </TooltipProvider>,
    );
    expect(screen.getByText("Q3 Launch")).toBeTruthy();
    expect(screen.getByPlaceholderText("add to Q3 Launch")).toBeTruthy();
  });

  it("renders every task as a normal row, marking only the inProgress ones", () => {
    render(
      <TooltipProvider>
      <DndContext>
        <ProjectGroup
          project={makeProject({ id: "prj_1", collapsed: false, openCount: 2 })}
          tasks={[
            makeTask({ id: "tsk_1", title: "Draft the copy", stage: "pending" }),
            makeTask({
              id: "tsk_2",
              title: "Get legal sign-off",
              stage: "in_progress",
              inProgress: true,
            }),
          ]}
          actions={makeActions()}
          onToggleCollapsed={() => {}}
          onRenameProject={() => {}}
          onChangeProjectColor={() => {}}
          onDeleteProject={() => {}}
          onAddTaskToProject={() => {}}
        />
      </DndContext>
      </TooltipProvider>,
    );
    expect(screen.getByText("Draft the copy")).toBeTruthy();
    expect(screen.getByText("Get legal sign-off")).toBeTruthy();
    // Both rows keep a real, interactive checkbox — no ghost swap.
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    // No more "Remove from In Progress" marker button — membership is
    // signalled by column alone now. Instead, each row's own ▶/◀ stage
    // toggle carries the accessible name, keyed off stage/inProgress via
    // `taskDragId`'s `inProgressColumn` (both rows render in this same
    // Backlog `ProjectGroup`, so both read "Move to In Progress").
    expect(
      screen.getAllByRole("button", { name: "Move to In Progress" }),
    ).toHaveLength(2);
  });

  it("variant='in_progress' hides rename/colour/delete/add and skips the drag handle", () => {
    render(
      <TooltipProvider>
      <DndContext>
        <ProjectGroup
          project={makeProject({ id: "prj_1", collapsed: false })}
          variant="in_progress"
          tasks={[
            makeTask({ id: "tsk_1", title: "Get legal sign-off", stage: "in_progress", inProgress: true }),
          ]}
          actions={makeActions()}
          onToggleCollapsed={() => {}}
        />
      </DndContext>
      </TooltipProvider>,
    );
    expect(screen.getByText("Q3 Launch")).toBeTruthy();
    expect(screen.queryByLabelText('Add task to "Q3 Launch"')).toBeNull();
    expect(screen.queryByLabelText('More actions for project "Q3 Launch"')).toBeNull();
    expect(screen.queryByLabelText('Change color for project "Q3 Launch"')).toBeNull();
    expect(screen.queryByPlaceholderText(/add to/)).toBeNull();
  });

  it("variant='in_progress' renders nothing when there are no tasks or orphan subtasks", () => {
    render(
      <TooltipProvider>
      <DndContext>
        <ProjectGroup
          project={makeProject({ id: "prj_1", collapsed: false })}
          variant="in_progress"
          tasks={[]}
          actions={makeActions()}
          onToggleCollapsed={() => {}}
        />
      </DndContext>
      </TooltipProvider>,
    );
    // No project content at all — only dnd-kit's own hidden a11y scaffolding
    // (DndContext's live region/instructions) is present.
    expect(screen.queryByText("Q3 Launch")).toBeNull();
    expect(document.querySelector("[data-project-id]")).toBeNull();
  });

  it("variant='in_progress' still renders an empty project's header in the Backlog (unaffected)", () => {
    render(
      <TooltipProvider>
      <DndContext>
        <ProjectGroup
          project={makeProject({ id: "prj_1", collapsed: false })}
          tasks={[]}
          actions={makeActions()}
          onToggleCollapsed={() => {}}
          onRenameProject={() => {}}
          onChangeProjectColor={() => {}}
          onDeleteProject={() => {}}
          onAddTaskToProject={() => {}}
        />
      </DndContext>
      </TooltipProvider>,
    );
    expect(screen.getByText("Q3 Launch")).toBeTruthy();
    expect(screen.getByPlaceholderText("add to Q3 Launch")).toBeTruthy();
  });

  it("variant='in_progress' renders orphanSubtasks standalone, after the nested tasks, with a trail", () => {
    const trail: TrailDto = {
      projectId: "prj_1",
      projectName: "Q3 Launch",
      projectColor: "teal",
      parentId: "tsk_parent",
      parentTitle: "Rewrite the onboarding email",
    };
    render(
      <TooltipProvider>
      <DndContext>
        <ProjectGroup
          project={makeProject({ id: "prj_1", collapsed: false })}
          variant="in_progress"
          tasks={[
            makeTask({ id: "tsk_nested", title: "Q3 planning doc", stage: "in_progress", inProgress: true }),
          ]}
          orphanSubtasks={[
            makeTask({
              id: "tsk_orphan",
              title: "Get legal sign-off",
              parentId: "tsk_parent",
              stage: "in_progress",
              inProgress: true,
              trail,
            }),
          ]}
          actions={makeActions()}
          onToggleCollapsed={() => {}}
        />
      </DndContext>
      </TooltipProvider>,
    );
    expect(screen.getByText("Q3 planning doc")).toBeTruthy();
    expect(screen.getByText("Get legal sign-off")).toBeTruthy();
    // The orphan's trail shows only the parent segment: hideProject
    // suppresses the project badge since this group's own header already
    // names "Q3 Launch". (TrailLine renders the parent segment twice —
    // once per responsive breakpoint sibling — so use getAllByText.)
    expect(screen.getAllByText("Rewrite the onboarding email").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Q3 Launch")).toHaveLength(1); // the group header only
  });

  it("forwards a new-task title to onAddTaskToProject with the project id", () => {
    const onAddTaskToProject = vi.fn();
    render(
      <TooltipProvider>
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
      </DndContext>
      </TooltipProvider>,
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
        <TooltipProvider>
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
      </TooltipProvider>
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
      <TooltipProvider>
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
      </DndContext>
      </TooltipProvider>,
    );

    const input = screen.getByPlaceholderText("add to Q3 Launch");
    input.blur();
    expect(document.activeElement).not.toBe(input);

    fireEvent.click(screen.getByLabelText('Add task to "Q3 Launch"'));

    expect(document.activeElement).toBe(screen.getByPlaceholderText("add to Q3 Launch"));
  });

  // Regression for the reported bug: the Backlog and In Progress columns
  // render the SAME project (and, for a task that's inProgress, the same
  // task) at once — a task visible in both columns is exactly the shape
  // `taskDragId` exists for (see the design doc's "Why taskDragId's
  // dual-id mechanism survived ghost removal"). Collapse state used to be a
  // single server column shared by both renders, so toggling the chevron
  // in one column's instance silently toggled the other's too. This
  // harness renders both instances of one project side by side, each with
  // its own collapse field (`collapsed` for backlog, `inProgressCollapsed`
  // for in_progress), and proves they're now independent.
  it("collapsing a project in the In Progress column leaves the Backlog column's same project expanded, and vice versa", () => {
    function Harness() {
      const [collapsed, setCollapsed] = useState(false);
      const [inProgressCollapsed, setInProgressCollapsed] = useState(false);
      const project = makeProject({ id: "prj_1", collapsed, inProgressCollapsed, openCount: 1, inProgressCount: 1 });
      const task = makeTask({ id: "tsk_1", title: "Shared task", stage: "in_progress", inProgress: true });
      return (
        <TooltipProvider>
      <DndContext>
          <div data-testid="backlog-column">
            <ProjectGroup
              project={project}
              tasks={[task]}
              actions={makeActions()}
              variant="backlog"
              onToggleCollapsed={() => setCollapsed((c) => !c)}
              onRenameProject={() => {}}
              onChangeProjectColor={() => {}}
              onDeleteProject={() => {}}
              onAddTaskToProject={() => {}}
            />
          </div>
          <div data-testid="in_progress-column">
            <ProjectGroup
              project={project}
              tasks={[task]}
              actions={makeActions()}
              variant="in_progress"
              onToggleCollapsed={() => setInProgressCollapsed((c) => !c)}
            />
          </div>
        </DndContext>
      </TooltipProvider>
      );
    }
    render(<Harness />);

    const backlogColumn = screen.getByTestId("backlog-column");
    const inProgressColumn = screen.getByTestId("in_progress-column");

    // Both columns start expanded — the shared task's title is visible twice.
    expect(screen.getAllByText("Shared task")).toHaveLength(2);

    // Collapse In Progress only.
    fireEvent.click(within(inProgressColumn).getByLabelText('Collapse "Q3 Launch"'));
    // In Progress's row is gone; the Backlog's identical row is untouched.
    expect(within(inProgressColumn).queryByText("Shared task")).toBeNull();
    expect(within(backlogColumn).getByText("Shared task")).toBeTruthy();
    expect(within(backlogColumn).getByLabelText('Collapse "Q3 Launch"')).toBeTruthy(); // still expanded

    // Re-expand In Progress, then collapse Backlog instead — the mirror case.
    fireEvent.click(within(inProgressColumn).getByLabelText('Expand "Q3 Launch"'));
    fireEvent.click(within(backlogColumn).getByLabelText('Collapse "Q3 Launch"'));
    expect(within(backlogColumn).queryByText("Shared task")).toBeNull();
    expect(within(inProgressColumn).getByText("Shared task")).toBeTruthy();
  });

  // Feature: parent-task grouping inside In Progress project cards. `rows`
  // (built by `lib/inProgressView`'s `selectInProgressView`) is the ONLY
  // thing that switches `ProjectGroup` into this rendering — passing it
  // renders a bare `TaskRow` per `"task"` row and a `ParentGroupHeader` +
  // indented children per `"parentGroup"` row, replacing tag subgrouping.
  it("variant='in_progress' with rows renders a plain TaskRow for a 'task' row and a ParentGroupHeader + indented children for a 'parentGroup' row", () => {
    const qualifying = makeTask({
      id: "tsk_qualifying",
      title: "Get legal sign-off",
      stage: "in_progress",
      inProgress: true,
      tags: [{ id: "tag_urgent", name: "urgent", color: "red" }],
    });
    const child = makeTask({
      id: "tsk_child",
      title: "Q3 planning doc",
      stage: "in_progress",
      inProgress: true,
    });
    render(
      <TooltipProvider>
        <DndContext>
          <ProjectGroup
            project={makeProject({ id: "prj_1", collapsed: false })}
            variant="in_progress"
            tasks={[qualifying]}
            rows={[
              { kind: "task", task: qualifying },
              {
                kind: "parentGroup",
                parentId: "tsk_parent",
                parentTitle: "Non-qualifying parent",
                tasks: [child],
              },
            ]}
            actions={makeActions()}
            onToggleCollapsed={() => {}}
          />
        </DndContext>
      </TooltipProvider>,
    );
    // Tags still render inline on the task row regardless of grouping.
    expect(screen.getByText("urgent")).toBeTruthy();
    expect(screen.getByText("Get legal sign-off")).toBeTruthy();
    // The parentGroup's header names the parent, and its child renders below it.
    expect(screen.getByText("Non-qualifying parent")).toBeTruthy();
    expect(screen.getByText("Q3 planning doc")).toBeTruthy();
    // No tag-subgroup count text ("· N") anywhere — that header is gone.
    expect(screen.queryByText(/^· \d+$/)).toBeNull();
  });

  // The Backlog must NEVER group by parent task — `rows` is simply never
  // passed for `variant="backlog"` (see `TodoPage.tsx`'s
  // `backlogProjectGroups`, which never sets it), so even a task that DOES
  // carry a tag still renders through the original flat task list, with no
  // tag-subgroup or parent-group header anywhere in the DOM.
  it("variant='backlog' (rows omitted) never renders a tag-subgroup or parent-group header, even for a tagged task", () => {
    const task = makeTask({
      id: "tsk_1",
      title: "Draft the copy",
      tags: [{ id: "tag_urgent", name: "urgent", color: "red" }],
    });
    render(
      <TooltipProvider>
        <DndContext>
          <ProjectGroup
            project={makeProject({ id: "prj_1", collapsed: false })}
            tasks={[task]}
            actions={makeActions()}
            onToggleCollapsed={() => {}}
            onRenameProject={() => {}}
            onChangeProjectColor={() => {}}
            onDeleteProject={() => {}}
            onAddTaskToProject={() => {}}
          />
        </DndContext>
      </TooltipProvider>,
    );
    expect(screen.getByText("Draft the copy")).toBeTruthy();
    // "urgent" still renders exactly once — from the row's own `TagChips`
    // chip, unaffected by any of this. A SECOND "urgent" would mean a
    // subgroup header rendered too, which the Backlog must never do; there
    // is no "· N" count text anywhere (only a subgroup header renders
    // one), and no "Untagged" bucket either.
    expect(screen.getAllByText("urgent")).toHaveLength(1);
    expect(screen.queryByText(/^· \d+$/)).toBeNull();
    expect(screen.queryByText("Untagged")).toBeNull();
  });
});

describe("TaskRow — In Progress membership is column-only (ghost rows and the old marker are both gone)", () => {
  it("an inProgress row keeps a real, interactive checkbox — never a ghost swap", () => {
    const task = makeTask({
      id: "tsk_1",
      title: "Get legal sign-off",
      stage: "in_progress",
      inProgress: true,
    });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} />);
    expect(screen.getByRole("checkbox")).toBeTruthy();
    const row = screen.getByText("Get legal sign-off").closest("[data-task-id]");
    expect(row).toBeTruthy();
    expect(row?.className).not.toContain("opacity-60");
  });

  it("renders no '· in progress' chip and no 'Remove from In Progress' control — membership is signalled by column alone", () => {
    const task = makeTask({
      id: "tsk_1",
      title: "Get legal sign-off",
      stage: "in_progress",
      inProgress: true,
    });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} />);
    expect(screen.queryByText(/in progress/)).toBeNull();
    expect(screen.queryByLabelText(/Remove .* from In Progress/)).toBeNull();
  });

  it("never renders the old '⌁ due today' auto-included marker for an overdue pending task — due dates no longer auto-include", () => {
    const task = makeTask({
      id: "tsk_1",
      title: "Renew the domain",
      stage: "pending",
      dueAt: NOON - 14 * HOUR,
    });
    renderWithDnd(<TaskRow task={task} actions={makeActions({ now: NOON })} />);
    expect(screen.queryByText(/due today/)).toBeNull();
    expect(screen.queryByText("⌁")).toBeNull();
    // The due-date text itself must still render — only the dead auto-marker
    // branch is gone.
    expect(screen.getByText("14 hours late")).toBeTruthy();
  });

  it("shows the carried badge on its own now that the marker is gone", () => {
    const task = makeTask({
      id: "tsk_1",
      title: "Get legal sign-off",
      stage: "in_progress",
      inProgress: true,
      carriedDays: 2,
    });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} />);
    expect(screen.getByText("carried 2d")).toBeTruthy();
  });

  it("hides the carried badge when carriedDays is 0", () => {
    const task = makeTask({
      id: "tsk_1",
      title: "Get legal sign-off",
      stage: "in_progress",
      inProgress: true,
      carriedDays: 0,
    });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} />);
    expect(screen.queryByText(/^carried /)).toBeNull();
  });

  it("a row not in In Progress renders no membership text either", () => {
    const task = makeTask({ id: "tsk_1", title: "Ship the invoice fix", inProgress: false });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} />);
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.queryByText(/in progress/)).toBeNull();
  });

  // Phase 3: the ▶/◀ stage toggle is the primary way to move work between
  // the two blocks now, so it must be discoverable without hovering —
  // unlike the calendar/tag/menu icons it sits beside, it used to be
  // `opacity-0 group-hover:opacity-100`. Assert it's present and clickable
  // with no hover/focus simulated at all.
  describe("the ▶/◀ stage toggle", () => {
    it("is always visible (no hover needed) on a Backlog-column row, labeled 'Move to In Progress'", () => {
      const task = makeTask({ id: "tsk_1", title: "Draft the copy", stage: "pending" });
      renderWithDnd(<TaskRow task={task} actions={makeActions()} inProgressColumn={false} />);
      const button = screen.getByRole("button", { name: "Move to In Progress" });
      expect(button).toBeTruthy();
      expect(button.className).not.toContain("opacity-0");
      expect(button.getAttribute("title")).toBe("Move to In Progress");
    });

    it("is always visible (no hover needed) on an In Progress-column row, labeled 'Move to Backlog'", () => {
      const task = makeTask({
        id: "tsk_1",
        title: "Get legal sign-off",
        stage: "in_progress",
        inProgress: true,
      });
      renderWithDnd(<TaskRow task={task} actions={makeActions()} inProgressColumn />);
      const button = screen.getByRole("button", { name: "Move to Backlog" });
      expect(button).toBeTruthy();
      expect(button.className).not.toContain("opacity-0");
      expect(button.getAttribute("title")).toBe("Move to Backlog");
    });

    it("clicking it on a Backlog-column row calls onStartTask with the task id", () => {
      const onStartTask = vi.fn();
      const task = makeTask({ id: "tsk_1", title: "Draft the copy", stage: "pending" });
      renderWithDnd(
        <TaskRow task={task} actions={makeActions({ onStartTask })} inProgressColumn={false} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Move to In Progress" }));
      expect(onStartTask).toHaveBeenCalledWith("tsk_1");
    });

    it("clicking it on an In Progress-column row calls onParkTask with the task id", () => {
      const onParkTask = vi.fn();
      const task = makeTask({
        id: "tsk_1",
        title: "Get legal sign-off",
        stage: "in_progress",
        inProgress: true,
      });
      renderWithDnd(
        <TaskRow task={task} actions={makeActions({ onParkTask })} inProgressColumn />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Move to Backlog" }));
      expect(onParkTask).toHaveBeenCalledWith("tsk_1");
    });
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
      stage: "in_progress",
      inProgress: true,
      trail,
    });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} showTrail />);
    expect(screen.getByText("Rewrite the onboarding email")).toBeTruthy();
  });

  it("renders no trail line for a loose task even when showTrail is set", () => {
    const task = makeTask({ id: "tsk_1", title: "Ship the invoice fix", stage: "in_progress" });
    const { container } = renderWithDnd(
      <TaskRow task={task} actions={makeActions()} showTrail />,
    );
    // No trail content anywhere in the rendered row.
    expect(container.querySelector("[dir='rtl']")).toBeNull();
  });

  it("hideProject forwards to TrailLine, suppressing the project segment", () => {
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
      stage: "in_progress",
      inProgress: true,
      trail,
    });
    renderWithDnd(<TaskRow task={task} actions={makeActions()} showTrail hideProject />);
    expect(screen.getAllByText("Rewrite the onboarding email").length).toBeGreaterThan(0);
    expect(screen.queryByText("Q3 Launch")).toBeNull();
  });
});

describe("ParentGroupHeader", () => {
  it("renders the parent title", () => {
    render(
      <ParentGroupHeader parentId="tsk_parent" parentTitle="Rewrite the onboarding email" />,
    );
    expect(screen.getByText("Rewrite the onboarding email")).toBeTruthy();
  });

  it("calls onNavigateToParent with the exact parentId when the title is clicked", () => {
    const onNavigateToParent = vi.fn();
    render(
      <ParentGroupHeader
        parentId="tsk_parent"
        parentTitle="Rewrite the onboarding email"
        onNavigateToParent={onNavigateToParent}
      />,
    );
    fireEvent.click(screen.getByText("Rewrite the onboarding email"));
    expect(onNavigateToParent).toHaveBeenCalledWith("tsk_parent");
  });

  it("renders no count chip or colour dot", () => {
    const { container } = render(
      <ParentGroupHeader parentId="tsk_parent" parentTitle="Rewrite the onboarding email" />,
    );
    expect(container.querySelector(".rounded-full")).toBeNull();
    expect(container.textContent).not.toContain("·");
  });

  it("returns null for an empty or whitespace-only parentTitle", () => {
    const { container: emptyContainer } = render(
      <ParentGroupHeader parentId="tsk_parent" parentTitle="" />,
    );
    expect(emptyContainer.innerHTML).toBe("");

    const { container: whitespaceContainer } = render(
      <ParentGroupHeader parentId="tsk_parent" parentTitle="   " />,
    );
    expect(whitespaceContainer.innerHTML).toBe("");
  });

  it("is safe to render with onNavigateToParent omitted", () => {
    render(<ParentGroupHeader parentId="tsk_parent" parentTitle="Rewrite the onboarding email" />);
    expect(() =>
      fireEvent.click(screen.getByText("Rewrite the onboarding email")),
    ).not.toThrow();
  });
});
