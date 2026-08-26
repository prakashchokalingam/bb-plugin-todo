// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgeChip } from "./AgeChip";
import { DueChip } from "./DueChip";
import { ProgressRing } from "./ProgressRing";
import { TagChip } from "./TagChip";
import { TagChips } from "./TagChips";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import { TooltipProvider } from "./ui/tooltip";
import type { TagRefDto } from "../contract";

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
