# UX reference (build to this)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⛯ Todo                                                            [Archive] [+ Tab]  │  host title bar + headerContent
├──────────────────────────────────────────────────────────────────────────────────────┤
│  Work │ Personal │ +                                                     ② overdue   │  TabStrip
├───────────────────────────────────────────────┬──────────────────────────────────────┤
│ ▾ BACKLOG · 12                  ◔ 3 overdue ⇤ │ ▾ IN PROGRESS         ◕ 5/10 done  ⇥ │  sticky column headers (Section)
├───────────────────────────────────────────────┼──────────────────────────────────────┤
│ ▾ ● Q3 Launch          4 open           ＋⋯   │ ▾ ● Q3 Launch                        │  ProjectGroup + ProjectHeader
│  ⠿ ☐ Rewrite onboarding email  ●urgent 2d late│  Rewrite onboarding email            │  ParentGroupHeader: names the non-qualifying parent
│                                       Move to▶│   ↳ ☐ Get legal sign-off carried 1d ◀│  TaskRow, indented under its parent group
│      ↳ ☐ Draft the copy                       │                                      │
│      ↳ ☐ Get legal sign-off       Move to  ▶  │ ▾ ● Personal errands                 │
│  ⠿ ☐ Q3 planning doc  ◕2/5       Fri 9:00am   │  ⠿ ☐ Renew the domain    in 3 days ◀│
│  + add to Q3 Launch                           │                                      │
│                                               │ ▾  Unfiled                           │  In Progress: empty groups hidden
│ ▸ ● Personal errands              3 open  ＋⋯ │  ⠿ ☐ Ship the invoice fix  in 22 min◀│
│                                               │                                      │
│ ⠿ ☐ Renew the domain              in 3 days ▶ │ + add to in progress                 │
│ + add to backlog                              │                                      │
└───────────────────────────────────────────────┴──────────────────────────────────────┘
      ← independent scroll                            independent scroll →
```
            ┌──────────────────────────────┐
            │ ✓ Done · Standup      [Undo] │  sonner, 8s
            └──────────────────────────────┘

Both columns render the identical `ProjectGroup` → `TaskRow` tree, wired
through one `DndContext` that spans both. A row is **undimmed and fully
interactive in both columns** — same checkbox, tags, due picker,
add-subtask, menu; the only difference is whether the project header is
draggable/editable (Backlog) or a read-only label (In Progress — see
"Projects" below).

Membership in In Progress is decided by **the user alone** — dragging a
task across, or clicking its stage-toggle button (`Move to In Progress` /
`Move to Backlog`, shown as `▶`/`◀` in the mockup above). A due date is
purely informational: it renders its chip wherever the task happens to be,
and an overdue task's red "late" text and the Backlog's overdue ring are
the only signals — an overdue task never pulls itself into In Progress.

Below the container breakpoint (narrow bb nav panel, independent of browser
viewport — see "Two-column layout" below), this falls back to the existing
stacked layout, sticky collapsible section headers, **In Progress first** —
when space is scarce, execution beats planning.

Row reading order, left to right after the title: tag chips (if any, `TagChips`)
-> subtask ring (if any) -> carried badge (if any, "carried Nd", only once
`carriedDays >= 1` — there is no separate "in progress" marker anymore; a
row's presence in a column is shown purely by which column it's rendered
in) -> AgeChip ("added N ago", always muted, hidden below `sm` if a narrow
row needs the room) -> DueChip (always visible, tone-coded) -> the action
icons, ending in the always-visible stage-toggle button described in "The
stage toggle" below. A row never grows a second line of its own in In
Progress — see "Parent grouping" below for how a subtask whose parent isn't
also in In Progress gets its context instead.

Each column can also be **collapsed as a whole** — see "Collapsible panels"
near the end of this document — independently of any of the above.

## Projects (`ProjectGroup` / `ProjectHeader`)

Both columns render one card per project, each project's tasks nested under
its own header, followed by every unfiled ("loose") task with no group header
of its own — the migration path for every task that predates projects. In
the In Progress column the loose group is labelled `Unfiled` (see the
mockup above), and its tasks are further grouped by **parent task**
(`ParentGroupHeader`) — the Backlog's card always renders a flat list.

```
▾ ● Q3 Launch                                     4 open        ＋ ⋯
```

- `▾`/`▸` toggles collapse, persisted server-side via `setProjectCollapsed`
  (single-user local plugin — worth one column, costs nothing on reload).
  Collapsed renders the header alone. Collapse works in both columns and is
  the one piece of header interaction In Progress keeps — but **each
  column's collapse state is independent**: the Backlog and In Progress
  columns render the same `ProjectDto` side by side, so collapsing a
  project in In Progress has no effect on its Backlog card, and vice versa.
  Two server-side bits back this (`ProjectDto.collapsed` for the Backlog,
  `.inProgressCollapsed` for In Progress), and `setProjectCollapsed`'s
  `column` argument says which one a given toggle writes. (This is a
  different, per-project mechanism from the whole-column "Collapsible
  panels" described near the end of this document — see that section for
  how the two are kept from ever being confused.)
- `●` opens the same `ColorSwatchPicker` tags already use; the colour reuses
  `TAG_COLORS`/`lib/tag-colors.ts`, so a project badge is legible in both
  themes with no new colour code.
- The name is inline-editable, double-click to rename — same mechanics as
  `TabStrip`'s tab rename.
- `＋` reveals (expanding a collapsed project first, if needed) and focuses
  the project's own `AddTaskRow` — `+ add to <project>` — the same
  reveal-and-focus pattern the row's own add-subtask affordance already uses.
- `⋯` -> Rename / Change colour / Delete, the last behind the existing
  `AlertDialog`: deleting a project releases its tasks to loose (`project_id
  = NULL`); nothing is deleted.

An empty (expanded) project in the **Backlog** shows only its add-row —
projects are never auto-deleted, so an empty one just reads as a plan not yet
written. In the **In Progress** column an empty project group renders
nothing at all: In Progress is an ephemeral view of what's currently in
play, not a durable container, so a project with nothing moved into In
Progress simply doesn't appear there. The Backlog never hides an empty
group; In Progress always does.

**In Progress's project headers are read-only, non-draggable labels.** The
name and colour badge render and collapse still works, but rename / recolour
/ delete / `＋` and project reordering live in the Backlog only — one editing
surface per concept, and two independently-draggable orderings of the same
`projects.sort_order` would fight each other for the same value.

The Backlog's own add-row (`+ add to backlog`) doubles as the inline project
creation entry point: typing `#Name` and pressing Enter creates a project
instead of a loose task. (Dragging one task onto another to group them into a
new project is deliberately out of scope for this change.)

## Parent grouping (`ParentGroupHeader`)

A task's home never moves — In Progress is a filtered view over the
Backlog's own rows, not a place a task relocates to (see
`docs/design/2026-09-01-two-blocks.md`'s Core decision, which supersedes
`docs/design/2026-08-31-today-as-view.md`'s). Inside a project card (or the
loose/`Unfiled` group), a task's own **parent** is the grouping axis that
carries the most meaning — it's the plan the task already belongs to,
independent of whatever tags happen to be on it that week — so that's what
In Progress groups by, not the task's tags: tags stay a per-row label
(`TagChips`), never a grouping key, anywhere in this column.

`ParentGroupHeader` renders for exactly one case: **a top-level task that
is not itself in In Progress but has one or more subtasks that are.**
There's no real parent row here to nest those subtasks under — the parent
didn't qualify — so they're pulled out under a synthetic header naming the
parent, with the qualifying subtasks rendered right underneath it, indented
exactly as they would be if they were nested under a real parent row:

```
   Rewrite onboarding email
   ↳ ☐ Get legal sign-off                  added 1w ago   carried 1d  ▤ 🏷  ◀
```

- One header per non-qualifying parent, not one per subtask — a parent
  with three qualifying subtasks gets a single header over all three, so
  the old per-row `Project > Parent` breadcrumb (once rendered by
  `TrailLine` as a second line under every such row) doesn't repeat itself
  three times for information the reader already has after the first line.
- No colour dot: unlike a tag or a project, a parent task has no `TagColor`
  to draw one from.
- No count chip: "how many subtasks share this tag" was a useful
  filter-shaped question when grouping was by tag; "how many subtasks does
  this parent have" isn't the equivalent question when the reader is
  already looking straight at the members of the group.
- Not collapsible — grouping by parent carries over the same choice tag
  subgrouping made: collapse was out of scope there too, so there's no new
  server-side state to add here either.
- The parent's title is a button: clicking it scrolls the Backlog to that
  parent row and flashes it, the same navigate-to-source affordance the old
  trail breadcrumb offered per segment.
- Rows still interleave in the Backlog's own order — a project card mixes
  ordinary In Progress tasks and these parent groups in whatever order
  their parents appear in the Backlog, not sorted to the top or bottom.

`TrailLine` (the muted `# Project > Parent` second line) and `TaskRow`'s
`showTrail` prop still exist, but neither renders anywhere in the In
Progress column anymore — the parent-group header above already names the
parent, and the card header already names the project, so a repeated
breadcrumb line under the row itself would be pure duplication. Archive's
use of `TrailLine`/`buildTrail` is unchanged by any of this — an archived
row still shows its full trail regardless of what's "in In Progress".

## The stage toggle

Ghost rows are gone, and so is the old per-row "In Progress marker" that
used to sit next to the carried badge. A task belongs to In Progress for
exactly one reason — **someone put it there**, by dragging or by clicking
the stage toggle — and that fact is now shown purely by *which column the
row is rendered in*, not by any marker glyph on the row itself. The row
stays a **normal, undimmed, fully-interactive Backlog row** either way; the
carried badge (`carried Nd`, only once `carriedDays >= 1`) is the only
thing left in that slot:

```
⠿ ☐  Renew the domain                       added 3d ago  in 3 days  ▤ 🏷 ＋ ⋯ ▶
⠿ ☐  Get legal sign-off  carried 1d                        added 1w ago      ▤ 🏷   ⋯ ◀
```

- The last icon in a row's action list is **always visible** (not
  hover-revealed, unlike everything before it) — this is the primary way to
  move work between the two blocks, alongside dragging, so it can't be
  discoverable-only-on-hover.
- `▶` **Move to In Progress** appears on a Backlog-column row and calls
  `setTaskStage(id, "in_progress")`. `◀` **Move to Backlog** appears on an
  In Progress-column row and calls `setTaskStage(id, "pending")`. Which one
  shows is gated purely on *which column this rendered instance is in*
  (`inProgressColumn`), never on a guess about the task's "true" state —
  so a task visible in both columns at once shows the matching affordance
  in each.
- Clicking **Move to Backlog** snaps the task back to exactly the Backlog
  slot it never left (its home is `(project_id, parent_id, sort_order)`,
  untouched by a stage flip) and clears its carried-days clock back to 0 —
  parking a task is a fresh start, not a paused scoreboard. Clicking
  **Move to In Progress** starts that clock and places the row at the top
  of its project (or the loose group).
- Kept visually quiet — the same muted `text-muted-foreground` treatment as
  the calendar/tag icons beside it, brightening only on hover/focus — so it
  reads as one of the row's ordinary icon actions rather than shouting.
  There is no keyboard binding of its own (dnd-kit's `KeyboardSensor`
  already owns the arrow keys on the row's drag handle); its `aria-label`
  ("Move to In Progress"/"Move to Backlog") and normal tab stop keep it
  usable without a mouse.

## Two-column layout

Wide (default): Backlog left, In Progress right, each independently
scrollable — scrolling one never moves the other. Both columns sit inside a
`@container` wrapper and share the single `DndContext` in `TodoPage.tsx`,
so a drag between them is one continuous gesture, not a handoff between two
surfaces.

Narrow (below the container breakpoint): falls back to the stacked layout —
sticky collapsible section headers, **In Progress first** — when space is
scarce, execution beats planning.

The breakpoint is a Tailwind v4 **container query** (`@container` /
`@3xl:flex-row` or similar), never a viewport media query
(`useMediaQuery`/browser width). A bb nav panel's width is independent of the
browser viewport: a maximized window with a narrow panel must still stack,
and a small window with a wide panel must still go side by side. The whole
page must keep working at a 420px floor as one column, and two columns need
roughly 2×340–380px plus a gap to be worth the split.

Tag chips collapse responsively, mirroring the `hidden md:flex` / `flex
md:hidden` breakpoint pair `AgeChip` already uses (two sibling elements, one
visible per breakpoint — never JS measurement):

  ≥ md    ●urgent ●bug ●deep-work       full chips: dot + name, `TagChip`
  < md    ● ● ●                         bare dots, name in a `Tooltip`
  > 3 (md) / > 5 (below md)   +2        overflow counter; its tooltip lists the hidden names

The overflow cap is 3 full chips at `md`+ and 5 bare dots below `md` — each
side caps independently, since a dot takes far less width than a name. A row
with no tags renders nothing here (`TagChips` returns `null` for `[]`) — the
row's width never depends on whether tags exist.

▤ calendar → opens `DueDatePicker` directly on click (one click, no menu hop).
   The popover keeps the "clear due date" affordance internally.
🏷 tags     → opens the `TagPicker` popover directly on click (see below).
   Shown on every row, top-level and subtask alike — unlike the plus button,
   tags are not depth-limited, so there's no affordance to withhold.
＋ plus     → reveals the inline add-subtask input directly under the row,
   focused. Top-level rows only — never shown on a subtask (depth is capped
   at 1, so the affordance would lie).
⋯ menu     → Delete only, still behind the existing AlertDialog confirm.
▶/◀ stage  → the always-visible "Move to In Progress"/"Move to Backlog"
   toggle described in "The stage toggle" above — the one action icon that
   is never hover-only.

All action buttons sit muted (`text-muted-foreground`) at rest and
brighten (`text-foreground`) on hover AND keyboard focus, so a ten-row list
doesn't read as a control panel. Rows stay `min-h-8`; the icon buttons are
compact (~`size-6`, `size-4` glyphs) and never grow the row.

Every input placeholder (add-task rows, inline subtask input, tab
rename/create input) sits at `placeholder:text-muted-foreground/50` at rest —
a hint, not content — and lifts to full `text-muted-foreground` on focus. The
typed text itself is always full `text-foreground`; only the placeholder
softens. The `AddTaskRow`'s leading `Plus` icon follows the same idea: muted
at `/50` at rest, lifting to `text-muted-foreground` when its input has focus,
so an idle add-row recedes until used.

Archive (Dialog / bottom drawer on compact):
┌── Archive · Work ───────────────────── [Clear all] ──┐
│  Thu 20 Aug · 5                                      │
│    ☑ Standup                              ↺ restore  │
│  Wed 19 Aug · 8                                      │
│    ☑ Deploy the hotfix                    ↺ restore  │
│                     [ Load more ]                    │
└──────────────────────────────────────────────────────┘
```

## The 🏷 picker (`TagPicker`, a Popover)

Anchored to the row's 🏷 button, same `anchor`/`open`/`onOpenChange` wiring as
`DueDatePicker`. The search input filters case-insensitively; a `Create "…"`
row appears only when the trimmed query is non-empty and does not exactly
match an existing name.

```
   idle                              typing a new name
┌──────────────────────────┐  ┌──────────────────────────┐
│ ⌕ filter or create…      │  │ ⌕ design▮                │
├──────────────────────────┤  ├──────────────────────────┤
│ ☑ ● urgent            12 │  │ ＋ Create "design"   ● ▾  │
│ ☑ ● bug                8 │  ├──────────────────────────┤
│ ☐ ● deep-work          3 │  │ ☐ ● design-review     2  │
│ ☐ ● waiting            1 │  └──────────────────────────┘
├──────────────────────────┤
│ ⚙ Manage tags…           │
└──────────────────────────┘

   empty state (no tags exist yet)     the swatch popover (● ▾ in the create row)
┌──────────────────────────┐  ┌──────────────────────┐
│ ⌕ filter or create…      │  │  ● ● ● ●             │
├──────────────────────────┤  │  ● ● ● ●             │
│  No tags yet.            │  │ slate red amber green│
│  Type a name to create   │  │ teal blue violet pink│
│  your first one.         │  └──────────────────────┘
├──────────────────────────┤
│ ⚙ Manage tags…           │
└──────────────────────────┘
```

Behaviour, verified against `components/TagPicker.tsx`:

- Toggling a checkbox (`Checkbox`, not a raw click target) fires `setTaskTags`
  with the task's full new tag-id set — never add/remove pairs. The popover
  stays open so several tags can be applied in one pass.
- The create row's swatch defaults to `TAG_COLORS[tags.length % 8]`, so the
  first eight tags a user creates are all visually distinct without them
  picking anything.
- Committing a create (click, or `Enter` when the create row is showing)
  calls `createTag`, then immediately applies the new tag to the current task
  and clears the query. A failure toasts the error and leaves the query
  intact.
- `Escape` closes the popover. `Enter` in the query field commits the create
  row if it is showing, otherwise toggles the first filtered result.
- Counts on the right of each checklist row are `TagDto.taskCount` — global,
  not scoped to the active list.
- The `⌕ filter or create…` input and the `☑/☐` checkboxes both carry
  `aria-label`s naming the tag; the footer button is `aria-label="Manage
  tags"`.
- `Manage tags…` emits the `"open-tag-manager"` board-bus command rather than
  rendering its own dialog — `TagManagerDialog` mounts once, in `TodoPage`.

## `⚙ Manage tags…` → the tag manager (`TagManagerDialog`)

Rendered through the shared `Dialog`/`DialogContent` — centred on desktop, a
bottom drawer on compact, exactly like `ArchivePanel`. Never a hand-rolled
overlay.

```
┌── Manage tags ──────────────────────────────────── [ + New tag ] ──┐
│                                                                    │
│  ⠿   ● ▾   urgent                        12 tasks              🗑   │
│  ⠿   ● ▾   bug                            8 tasks              🗑   │
│  ⠿   ● ▾   deep-work                      3 tasks              🗑   │
│  ⠿   ● ▾   waiting                        1 task               🗑   │
│  ⠿   ● ▾   ▮design                        0 tasks              🗑   │  ← new, focused
│                                                                    │
│  drag ⠿ to reorder · order drives chip order on every row          │
└──────────────────────────────────────────────────────────────────┘

  empty state:  "No tags yet. Create one to start labelling tasks."
                with the [ + New tag ] button as the only affordance.
```

- `+ New tag` calls `createTag` with a placeholder name (`"New tag"`) and the
  next unused palette color, then opens that row in rename mode immediately
  — the "new, focused" row above.
- Click the name → inline rename (a plain `<input>`, not `TagPicker`'s
  search box), `Enter` commits, `Escape` reverts to the prior name. Blur also
  commits, same as `TabStrip`'s rename.
- Click `● ▾` → the same eight-swatch popover shown under the picker's
  create row (`ColorSwatchPicker`, a 4×2 grid, `slate red amber green` /
  `teal blue violet pink`).
- Drag `⠿` → reorder, committed via `reorderTags`. The dialog owns its own
  `DndContext`, separate from `TodoPage`'s board-level one — the dialog
  renders through a portal, so sharing sensors would have the two contexts
  fighting over the same pointer/keyboard events.
- Click `🗑` → an `AlertDialog` confirm, worded with the live count:

```
        ┌────────────────────────────────────────┐
        │  Delete "urgent"?                      │
        │  It will be removed from 12 tasks.     │
        │  This cannot be undone.                │
        │              [ Cancel ]  [ Delete ]    │
        └────────────────────────────────────────┘
```

  When `taskCount` is 0 the description reads "This cannot be undone." alone
  — no "removed from" line.

Every row mutation (rename, recolor, delete, reorder) is optimistic against
the dialog's local copy of the catalog and reverts with a toast on failure;
each success also calls the `onChanged` callback so `TodoPage` refetches the
board and every open row's chips update.

## Collapsible panels (`CollapsedRail`, `hooks/usePanelCollapse.ts`)

Each column's own header — not a project's, the whole Backlog or In
Progress block — carries a collapse control: a chevron next to the heading
(the whole heading row is clickable) plus a dedicated icon button on the
header's far right (⇤ on Backlog, ⇥ on In Progress, pointing toward the
edge that panel collapses to). Clicking either collapses that entire
column.

```
Both expanded (wide):                         One collapsed (wide):
┌───────────────────┬───────────────────┐    ┌──┬────────────────────────┐
│ ▾ BACKLOG      ⇤   │ ▾ IN PROGRESS  ⇥ │    │▸ │ ▾ IN PROGRESS       ⇥ │
│  ...               │  ...               │    │B │  ...                   │
│                    │                    │    │A │                        │
│                    │                    │    │C │                        │
│                    │                    │    │K │                        │
│                    │                    │    │L │                        │
│                    │                    │    │O │                        │
│                    │                    │    │G │                        │
└───────────────────┴───────────────────┘    └──┴────────────────────────┘
                                                ~40px rail, click anywhere
                                                on it to expand
```

- **Collapsing one panel gives the other the full width; both collapsed at
  once is impossible.** State is one value, not two independent booleans —
  `"both"` (neither collapsed), `"backlog"`, or `"in_progress"` — so
  collapsing the currently-expanded-alone panel automatically restores the
  other one; there is no state that can name both as collapsed
  simultaneously.
- A collapsed panel renders as `CollapsedRail` instead of `Section`, in one
  of two shapes depending on the same `@3xl` breakpoint the two-column
  layout itself uses (never a viewport media query):
  - **At/above `@3xl` (side-by-side layout):** a ~40px-wide vertical rail
    spanning the row's full height, its heading rotated to read
    top-to-bottom, an open count, and a chevron pointing outward — the
    conventional "click to bring the sidebar back" affordance.
  - **Below `@3xl` (already-stacked layout):** a full-width, one-line bar —
    heading, count, and an expand chevron, left to right. A 40px vertical
    rail would be nonsense once the columns are already stacked full-width.
  - Either shape is one real `<button>` (`aria-label="Expand BACKLOG"` /
    `"Expand IN PROGRESS"`) — click, or Enter/Space when focused, restores
    the panel.
- **Per-device, not server-persisted.** Unlike the per-project collapse
  above (`setProjectCollapsed`, saved to SQLite so it survives a reload
  anywhere), which panel you like collapsed on *this* device lives in
  `localStorage` under `todo.panel.<listId>` and nowhere else. This is
  deliberate: a round trip to the server before the UI could reflect your
  choice would make the collapse animate late for no real benefit, and
  nobody needs their panel layout to follow them across devices or to sync
  with a collaborator's. Switching tabs (lists) restores that list's own,
  independently-remembered choice.
- This is a wholly separate axis of state from the per-project collapse
  described earlier in this document (`ProjectDto.collapsed` /
  `.inProgressCollapsed`) — collapsing the whole Backlog panel says
  nothing about whether any individual project inside it is expanded or
  collapsed, and vice versa. Don't conflate the two when reading the
  mockups: `▾`/`▸` next to a project name is the per-project toggle; the
  chevron and ⇤/⇥ button next to `BACKLOG`/`IN PROGRESS` themselves are
  the whole-panel toggle described here.
