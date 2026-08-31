# UX reference (build to this)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⛯ Todo                                                            [Archive] [+ Tab]  │  host title bar + headerContent
├──────────────────────────────────────────────────────────────────────────────────────┤
│  Work │ Personal │ +                                                     ② overdue   │  TabStrip
├───────────────────────────────────────────────┬──────────────────────────────────────┤
│ BACKLOG · 12                    ◔ 3 overdue   │ TODAY · Thu 20 Aug      ◕ 5/10 done  │  sticky column headers (Section)
├───────────────────────────────────────────────┼──────────────────────────────────────┤
│ ▾ ● Q3 Launch            4 open · 1 today ＋⋯ │ ▾ ● Q3 Launch                        │  ProjectGroup + ProjectHeader
│  ⠿ ☐ Rewrite onboarding email  ●urgent 2d late│  ⠿ ☐ Get legal sign-off  carried 1×  │  TaskRow — undimmed, fully interactive
│      ↳ ☐ Draft the copy                       │        › Rewrite onboarding email    │  TrailLine: orphan subtask → parent trail
│      ↳ ☐ Get legal sign-off       · today     │                                      │  TaskRow: today marker
│  ⠿ ☐ Q3 planning doc  ◕2/5       Fri 9:00am   │ ▾ ● Personal errands                 │
│  + add to Q3 Launch                           │  ⠿ ☐ Renew the domain    ⌁ due today │  ⌁ = auto-included marker
│                                               │                                      │
│ ▸ ● Personal errands              3 open  ＋⋯ │ ▾  Unfiled                           │  Today: empty groups hidden
│                                               │  ⠿ ☐ Ship the invoice fix  in 22 min │
│ ⠿ ☐ Renew the domain     ⌁ today    in 3 days │                                      │
│ + add to backlog                              │ + add to today                       │
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
draggable/editable (Backlog) or a read-only label (Today — see "Projects"
below).

Below the container breakpoint (narrow bb nav panel, independent of browser
viewport — see "Two-column layout" below), this falls back to the existing
stacked layout, sticky collapsible section headers, **Today first** — when
space is scarce, execution beats planning.

Row reading order, left to right after the title: tag chips (if any, `TagChips`)
-> subtask ring (if any) -> carried badge (if any) -> today marker (if any,
see "The today marker" below — no longer either/or with the carried badge; a
row can show both) -> AgeChip ("added N ago", always muted, hidden below `sm`
if a narrow row needs the room) -> DueChip (always visible, tone-coded) -> the
four action icons below. A Today row additionally gets a second line —
`TrailLine`, described below — directly under it, whenever it has one.

## Projects (`ProjectGroup` / `ProjectHeader`)

Both columns render one card per project, each project's tasks nested under
its own header, followed by every unfiled ("loose") task with no group header
of its own — the migration path for every task that predates projects. In
the Today column the loose group is labelled `Unfiled` (see the mockup
above).

```
▾ ● Q3 Launch                              4 open · 1 today   ＋ ⋯
```

- `▾`/`▸` toggles collapse, persisted server-side via `setProjectCollapsed`
  (single-user local plugin — worth one column, costs nothing on reload).
  Collapsed renders the header alone. Collapse works in both columns and is
  the one piece of header interaction Today keeps.
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
written. In the **Today** column an empty project group renders nothing at
all: Today is an ephemeral view of what's due or scheduled right now, not a
durable container, so a project with nothing in play today simply doesn't
appear there. The Backlog never hides an empty group; Today always does.

**Today's project headers are read-only, non-draggable labels.** The name and
colour badge render and collapse still works, but rename / recolour / delete
/ `＋` and project reordering live in the Backlog only — one editing surface
per concept, and two independently-draggable orderings of the same
`projects.sort_order` would fight each other for the same value.

The Backlog's own add-row (`+ add to backlog`) doubles as the inline project
creation entry point: typing `#Name` and pressing Enter creates a project
instead of a loose task. (Dragging one task onto another to group them into a
new project is deliberately out of scope for this change.)

## The trail line (`TrailLine`)

A task's home never moves — Today is a filtered view over the Backlog's own
rows, not a place a task relocates to (see the design doc's Core decision).
`TrailLine` renders for exactly one live case: **a Today row whose parent is
not also in Today.** Inside a project group it shows the parent segment
only — the group header already names the project, so repeating it would be
redundant:

```
⠿ ☐  Get legal sign-off                    added 1w ago   carried 1×  ▤ 🏷   ⋯
     › Rewrite the onboarding email
```

In the loose/`Unfiled` group there is no header naming a project, so
`TrailLine` keeps both segments:

```
⠿ ☐  Get legal sign-off                    added 1w ago   carried 1×  ▤ 🏷   ⋯
     ● Q3 Launch › Rewrite the onboarding email
```

- Renders only when there is context to show — a Today row whose parent is
  also in Today, or a loose top-level task, gets no second line, so most
  rows never gain height for nothing.
- Truncates from the **left**, so the nearest ancestor (the most useful
  segment) survives: `● Q3 Launch › …boarding email`.
- Each segment (the project badge, the parent title) is independently
  clickable: it scrolls the Backlog to that source row and flashes it.
- Below `md` it collapses to the project badge alone (`● Q3 Launch`) when
  both segments are present, mirroring how `TagChips` already degrades —
  never JS measurement.
- Archive's use of `TrailLine`/`buildTrail` is unchanged by any of this — an
  archived row still shows its full trail regardless of what's "in Today".

## The today marker

Ghost rows are gone. A task that belongs to Today — whether dragged in or
included automatically because it's due today or overdue — stays a **normal,
undimmed, fully-interactive Backlog row**. The only visible sign is a subtle
marker, rendered in the slot the carried badge already occupies:

```
⠿ ☐  Renew the domain                       ⌁ today       added 3d ago  in 3 days  ▤ 🏷 ＋ ⋯
⠿ ☐  Get legal sign-off  carried 1×  ⌁ today               added 1w ago            ▤ 🏷   ⋯
```

- It is no longer either/or with the carried badge — a row can show **both**
  `carried 1×` and the today marker at once, since a stalled task can also be
  scheduled or due right now.
- There are two visually distinct reasons a task carries the marker:
  **manually scheduled** (dragged into Today) versus **auto-included**
  (due today or overdue, no drag involved — `⌁ due today` / `⌁ overdue` in
  the mockups above). The distinction matters because only the manual case
  has a `bucket` to flip back; see the design doc for how removal is wired
  for each.
- Clicking the marker removes the task from Today: a manually-scheduled task
  snaps back to `bucket='backlog'` (nothing about its Backlog slot moves,
  since it never left); an auto-included task stays exactly as it is and is
  simply excluded from the Today view until its due date or dismissal state
  changes.

## Two-column layout

Wide (default): Backlog left, Today right, each independently scrollable —
scrolling one never moves the other. Both columns sit inside a `@container`
wrapper and share the single `DndContext` in `TodoPage.tsx`, so a drag
between them is one continuous gesture, not a handoff between two surfaces.

Narrow (below the container breakpoint): falls back to the stacked layout —
sticky collapsible section headers, **Today first** — when space is scarce,
execution beats planning.

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

All four action buttons sit muted (`text-muted-foreground`) at rest and
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
