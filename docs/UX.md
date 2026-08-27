# UX reference (build to this)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ⛯ Todo                                                                    [Archive] [+ Tab]  │  host title bar + headerContent
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  Work │ Personal │ +                                                             ② overdue   │  TabStrip
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│                        ↕ gap-8 (~2rem) — two distinct zones                                  │
│  BACKLOG  · 12                                                   ◔ 3/12 overdue              │  Section header + ProgressRing (destructive)
│  ┌────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ ▾ ● Q3 Launch                                          4 open · 1 today       ＋ ⋯      │  │  ProjectGroup header
│  │   ⠿ ☐  Rewrite the onboarding email  ●urgent ●bug    added 2mo ago  2d late    ▤ 🏷 ＋ ⋯ │  │
│  │        ↳ ☐ Draft the copy                             added 1w ago              ▤ 🏷   ⋯ │  │  subtask: no plus
│  │        ↳ ◌ Get legal sign-off              · today    added 1w ago              ▤ 🏷   ⋯ │  │  ghost subtask (scheduled)
│  │   ⠿ ☐  Q3 planning doc  ●deep-work  ◕ 2/5            added 1w ago   Fri 9:00am ▤ 🏷 ＋ ⋯ │  │  ProgressRing (subtasks)
│  │   + add to Q3 Launch                                                                   │  │  per-project AddTaskRow
│  │                                                                                         │  │
│  │ ▸ ● Personal errands                                              3 open       ＋ ⋯      │  │  collapsed: header only
│  │                                                                                         │  │
│  │ ⠿ ☐  Renew the domain                                added 3d ago   in 3 days  ▤ 🏷 ＋ ⋯ │  │  loose task, below every project
│  │ + add to backlog                                                                       │  │  AddTaskRow; `#Name` + Enter files a new project
│  └────────────────────────────────────────────────────────────────────────────────────────┘  │
│                        ↕ gap-8 (~2rem) — two distinct zones                                  │
│  TODAY · Thu 20 Aug                                           ◕ 5/10 done                    │  Section header + ProgressRing (primary)
│  ┌────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ ⠿ ☐  Ship the invoice fix                           added just now  in 22 min  ▤ 🏷 ＋ ⋯ │  │  tone: soon
│  │ ⠿ ☐  Get legal sign-off                              added 1w ago   carried 1× ▤ 🏷   ⋯ │  │  ghost's live copy
│  │        ● Q3 Launch › Rewrite the onboarding email                                      │  │  TrailLine (second line, muted)
│  │ ⠿ ☐  Review Ana's PR  ◕ 1/2                          added 5h ago   tomorrow   ▤ 🏷 ＋ ⋯ │  │
│  │ + add to today                                                                         │  │
│  └────────────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
            ┌──────────────────────────────┐
            │ ✓ Done · Standup      [Undo] │  sonner, 8s
            └──────────────────────────────┘

Row reading order, left to right after the title: tag chips (if any, `TagChips`)
-> subtask ring (if any) -> carried badge (if any, or the ghost's `· today`
marker in its place — see below) -> AgeChip ("added N ago", always muted,
hidden below `sm` if a narrow row needs the room) -> DueChip (always visible,
tone-coded) -> the four action icons below. A Today row additionally gets a
second line — `TrailLine`, described below — directly under it, whenever it
has one.

## Projects (`ProjectGroup` / `ProjectHeader`)

The Backlog renders one card per project, each project's tasks nested under
its own header, followed by every unfiled ("loose") task with no group header
of its own — the migration path for every task that predates projects.

```
▾ ● Q3 Launch                              4 open · 1 today   ＋ ⋯
```

- `▾`/`▸` toggles collapse, persisted server-side via `setProjectCollapsed`
  (single-user local plugin — worth one column, costs nothing on reload).
  Collapsed renders the header alone.
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

An empty (expanded) project shows only its add-row — projects are never
auto-deleted, so an empty one just reads as a plan not yet written.

The Backlog's own add-row (`+ add to backlog`) doubles as the inline project
creation entry point: typing `#Name` and pressing Enter creates a project
instead of a loose task. (Dragging one task onto another to group them into a
new project is deliberately out of scope for this change.)

## The trail line (`TrailLine`)

A scheduled task's home never moves — Today is a flag, not a place (see the
design doc's Core decision). Every Today row whose task has a project and/or
a parent renders a second, muted line under it:

```
⠿ ☐  Get legal sign-off                    added 1w ago   carried 1×  ▤ 🏷   ⋯
     ● Q3 Launch › Rewrite the onboarding email
```

- Renders only when there is context to show — a loose top-level task gets no
  second line, so most rows never gain height for nothing.
- Truncates from the **left**, so the nearest ancestor (the most useful
  segment) survives: `● Q3 Launch › …boarding email`.
- Each segment (the project badge, the parent title) is independently
  clickable: it scrolls the Backlog to that source row and flashes it.
- Below `md` it collapses to the project badge alone (`● Q3 Launch`),
  mirroring how `TagChips` already degrades — never JS measurement.

## Ghost rows

A scheduled task stays visible in its project too, dimmed, its checkbox
swapped for a hollow "ghost" glyph (`◌`) and a `· today` marker in place of
the carried badge:

```
↳ ◌ Get legal sign-off              · today          added 1w ago    ▤ 🏷   ⋯
```

Once a ghost has carried 3 or more times, the marker also shows the count
(`· today ~6`) — the same information a stalled effort's badge shows in
Today, but sitting right next to the project it's stalling, not only in a day
view that gets scrolled past. Clicking the `· today` marker unschedules the
task: it snaps back to exactly the Backlog slot it never actually left,
regardless of where it's dropped if unscheduled by dragging instead.

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
