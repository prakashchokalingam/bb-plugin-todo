# bb-plugin-todo — implementation spec (single source of truth)

An ADHD-friendly daily to-do plugin for BB. One page in the sidebar ("Todo") with
user-created tabs (Work, Personal, +), each tab holding a **Backlog** section and a
**Today** section in ONE drag-and-drop surface, one level of subtasks, humanised due
chips, progress graphs, and an Archive with undo.

Do not invent surfaces or fields beyond this spec. If something here is impossible
against the real SDK, say so in your report rather than silently substituting.

## Product rules (non-negotiable)

1. **Two sections, one list.** Backlog and Today render in a single dnd context.
   Any item can be dragged Backlog -> Today, Today -> Backlog, or reordered within
   either.
2. **Subtasks are exactly one level deep.** A task with `parent_id` cannot itself
   have children. Dropping a top-level task onto another top-level task makes it a
   subtask (its own subtasks are promoted to top-level siblings at the drop point).
   Dragging a subtask into a section makes it top-level. Dragging a parent moves its
   subtasks with it.
3. **Done vanishes immediately.** Completing sets `status='done'` + `completed_at`.
   The row leaves Backlog/Today at once and appears in Archive. An 8s sonner toast
   offers Undo; Archive offers restore forever. Completing a parent completes its
   open subtasks (and undo restores exactly the set it completed — pass the ids
   back through the undo call).
4. **Carry-forward.** At day rollover, every `status='open' AND bucket='today' AND
   day < today` row gets `day = today` and `carried_count + 1`. Backlog rows are
   never auto-promoted. Rollover is idempotent and runs BOTH on a cron
   (`5 0 * * *`) and lazily at the start of every `getBoard` / `getArchive` call,
   so a slept machine can never desync.
5. **Today's progress survives the vanish.** The Today ring reads `done/total` where
   total = all rows with `day = today` in this list (open + done). So completing 5
   of 10 shows 5/10 even though those 5 are gone from the list.
6. **Everything is per-list.** Overdue counts, archive, clear-archive: scoped to the
   active list. The sidebar accessory shows the total overdue across all lists.

## Storage — SQLite via `bb.storage.database()`

`bb.storage.migrate(db, [...])` is APPEND-ONLY by statement index. Ship exactly these
statements in this order (add new ones only at the end, never edit these):

```sql
-- 0
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order REAL NOT NULL,
  created_at INTEGER NOT NULL
);
-- 1
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  bucket TEXT NOT NULL CHECK (bucket IN ('backlog','today')),
  day TEXT,
  sort_order REAL NOT NULL,
  due_at INTEGER,
  has_due_time INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  completed_at INTEGER,
  carried_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 2
CREATE INDEX IF NOT EXISTS tasks_board_idx
  ON tasks (list_id, status, bucket, parent_id, sort_order);
-- 3
CREATE INDEX IF NOT EXISTS tasks_archive_idx
  ON tasks (list_id, status, completed_at DESC);
-- 4
CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks (status, due_at);
-- 5
CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_id);
-- 6
CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  sort_order REAL NOT NULL,
  created_at INTEGER NOT NULL
);
-- 7
CREATE UNIQUE INDEX IF NOT EXISTS tags_name_unique ON tags (name COLLATE NOCASE);
-- 8
CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
-- 9
CREATE INDEX IF NOT EXISTS task_tags_tag_idx ON task_tags (tag_id);
```

`tags` is global (no `list_id`) — one catalog shared by every list. `task_tags`
is a pure join with no payload, keyed `(task_id, tag_id)`. The
`tags_name_unique` index makes name uniqueness a database constraint, case
insensitively, on top of the application check in `lib/db.ts` (the
application check exists for a readable error message; the index exists so a
race can't defeat it). Both foreign keys cascade: deleting a tag removes its
`task_tags` rows and leaves tasks untouched; deleting a task removes its
`task_tags` rows and leaves tags untouched. Neither cascade fires unless
`PRAGMA foreign_keys = ON` is set (below) — `server.ts` sets it once, do not
add a second pragma call.

`tags.color` stores a palette key (`"violet"`, one of `TAG_COLORS`), never a
hex. The plugin renders in both light and dark mode via shadcn tokens, and a
stored hex is guaranteed to be unreadable in one of them; the key is resolved
to static Tailwind classes client-side by `lib/tag-colors.ts`.

Enable `PRAGMA foreign_keys = ON` on the handle before use (better-sqlite3 defaults
it off, so ON DELETE CASCADE is inert without this).

Seed on first load only (when `lists` is empty): `Work` (sort_order 1000) then
`Personal` (2000).

Ids: `lst_` / `tsk_` + 22 chars of `crypto.randomUUID()` with dashes stripped.

`bb.storage.kv`: only `rollover:lastDay` (string `YYYY-MM-DD`). Nothing else.

### Fractional ordering (`order.ts`, pure + unit-tested)
- `nextOrder(prev: number | null, next: number | null): number` — midpoint;
  `prev + 1000` when next is null; `next - 1000` when prev is null; `1000` when both
  are null.
- If `Math.abs(next - prev) < 0.0001`, the caller REBALANCES the affected sibling
  group to `1000, 2000, 3000, …` in a transaction and recomputes. Test this path.

### Day handling
- "Today" is the **server-local** day, formatted `YYYY-MM-DD`. Put
  `localDay(date: Date): string` in one place and use it everywhere; never build a
  day string from `toISOString()` (that is UTC and will be wrong in the evening).
- Moving a task to `bucket='today'` sets `day = localDay(now)`. Moving to
  `bucket='backlog'` sets `day = NULL`.
- Subtasks always mirror their parent's `bucket` and `day`; enforce that in the
  move/create queries, not in the UI.

## RPC contract (`contract.ts`) — implement EXACTLY this

Use zod 4. All objects `.strict()`. Ids are `z.string().min(1)`.

```
TAG_COLORS = ["slate", "red", "amber", "green", "teal", "blue", "violet", "pink"] as const
TagColor = (typeof TAG_COLORS)[number]

TagRefDto = { id, name, color: TagColor }          // denormalized form, embedded in every TaskDto
TagDto = TagRefDto & { sortOrder: number, taskCount: number }   // catalog form; taskCount is global, not per-list

TaskDto = {
  id, listId, parentId: string|null, title, notes: string|null,
  bucket: 'backlog'|'today', day: string|null, sortOrder: number,
  dueAt: number|null, hasDueTime: boolean, status: 'open'|'done',
  completedAt: number|null, carriedCount: number,
  createdAt, updatedAt,
  subtasks: TaskDto[]          // present on top-level rows only, always [] on subtasks
  subtaskCounts: { total: number, done: number }   // done counts done subtasks
  tags: TagRefDto[]            // ordered by tag sortOrder; populated on subtasks too
}
ListDto = { id, name, sortOrder, openCount, overdueCount }
```

`color` is validated against `TAG_COLORS` at the contract boundary
(`z.enum(TAG_COLORS)`); an unknown key is an `invalid_input` error, not a
silent fallback.

Methods:
- `getBoard({ listId: string|null })` -> `{ lists: ListDto[], activeListId: string,
  today: { day: string, planned: number, completed: number, tasks: TaskDto[] },
  backlog: { total: number, overdue: number, tasks: TaskDto[] },
  totalOverdue: number, serverNow: number, tags: TagDto[] }`
  - `activeListId` falls back to the first list when the argument is null or unknown.
  - `tasks` are top-level rows only, ordered by `sort_order`, each with its
    `subtasks` nested and ordered.
  - `planned` = rows with `day = today`; `completed` = those with `status='done'`.
    Both count top-level rows AND subtasks.
  - `tags` is the full tag catalog with usage counts, so the picker needs no
    extra fetch. `getArchive`'s output is **not** extended with this catalog —
    archived rows carry `TaskDto.tags` like any other row, but the archive
    panel renders no picker, so it needs no catalog.
  - Tag lookups for every row on the board are done with **one** query
    (`loadTagMap` in `lib/db.ts`), never a per-task query — see the N+1 note
    below.
- `getArchive({ listId: string, limit: number (<=200, default 100), offset: number })`
  -> `{ groups: [{ day: string, tasks: TaskDto[] }], total: number, hasMore: boolean }`
  grouped by the local day of `completed_at`, newest first. Subtasks appear nested
  under their parent when the parent is in the same group, otherwise as their own row.
- `createTask({ listId, bucket, title, parentId: string|null, dueAt: number|null,
  hasDueTime: boolean, position: 'top'|'bottom' })` -> `{ task: TaskDto }`
  - Rejects an empty/whitespace title (`invalid_input`) and a `parentId` that is
    itself a subtask.
- `updateTask({ id, title?, notes?, dueAt?, hasDueTime? })` -> `{ task: TaskDto }`
  (`dueAt: null` clears the due date).
- `moveTask({ id, bucket, parentId: string|null, beforeId: string|null,
  afterId: string|null })` -> `{ ok: true }`
  - `beforeId`/`afterId` are the sibling ids the item lands between, in the target
    group. Both null = only item / append.
  - Making a task a subtask promotes that task's own children to top-level siblings
    placed immediately after it, in their existing order.
  - Rejects a move that would create a cycle or a depth > 1.
- `completeTask({ id })` -> `{ completedIds: string[] }`
- `restoreTasks({ ids: string[] })` -> `{ ok: true }` (undo AND archive restore)
- `deleteTask({ id })` -> `{ ok: true }` (cascades subtasks)
- `createList({ name })` / `renameList({ id, name })` / `deleteList({ id })` /
  `reorderLists({ ids: string[] })` -> `{ lists: ListDto[] }` (or `{ list }` for
  create). `deleteList` refuses to delete the last remaining list.
- `clearArchive({ listId })` -> `{ deleted: number }` — hard-deletes every
  `status='done'` row in that list.
- `createTag({ name, color: TagColor })` -> `{ tag: TagDto }`.
- `updateTag({ id, name?, color?: TagColor })` -> `{ tag: TagDto }`. Renaming a
  tag to its own current name, in any casing, is a no-op on the uniqueness
  check, not a collision.
- `deleteTag({ id })` -> `{ ok: true }`. Cascades `task_tags`; tasks survive.
- `reorderTags({ ids: string[] })` -> `{ tags: TagDto[] }`. Renumbers to
  `1000, 2000, …`, mirroring `reorderLists`. `ids` must be a complete,
  duplicate-free permutation of the current tag catalog — a partial list
  (e.g. a stale client whose catalog predates a concurrently-created tag)
  is rejected rather than silently renumbering only the given ids, which
  would collide `sort_order` between an omitted tag and a renumbered one
  and make their relative order in `TaskDto.tags` undefined. All validation
  runs inside the transaction, so a rejected call never partially applies.
  Throws `invalid_input: duplicate tag ids in reorder list` on a repeated
  id, `invalid_input: tag not found` on an id absent from `tags`, and
  `invalid_input: reorder list must include every tag` when the catalog has
  a tag missing from `ids`.
- `setTaskTags({ taskId, tagIds: string[] })` -> `{ task: TaskDto }`. **A
  full-set replace, not add/remove pairs** — implemented as one transaction:
  `DELETE FROM task_tags WHERE task_id = ?` then insert each id. Idempotent
  under retry. Duplicate ids in the input are deduped, not an error; an id
  that doesn't name a real tag throws `invalid_input: tag not found`.

Tag name uniqueness is case-insensitive: `createTag`/`updateTag` throw
`invalid_input: a tag named "…" already exists` on a collision, and
`invalid_input: name must not be empty` on an empty-after-trim name.

Every mutation calls `bb.realtime.publish("board", { listId })` after committing.
The frontend refetches on that signal (do not try to patch state from the payload).
Tag mutations publish with `listId: null` (`publish(null)`) instead of a
specific list, since tags are global and every list's board is potentially
affected; `setTaskTags` publishes the affected task's own `listId`.

### The N+1 constraint on `getBoard` / `getArchive`

Both build their DTO tree through per-row helpers (`buildTopLevelDto`,
`getArchive`'s `dtoFor`). Tag lookups must never happen inside those
per-row helpers — that would be one query per task per board load. Instead
each read call materializes the whole `task_tags` join once, up front
(`loadTagMap` in `lib/db.ts`), and threads the resulting map down. The
single-DTO mutation returns (`createTask`, `updateTask`, `setTaskTags`) are
the one exception: a targeted per-task query (`getTaskTags`) is correct and
cheap there, since exactly one task's tags are needed.

## Frontend

`app.tsx` registers ONE surface:

```
app.slots.navPanel({
  id: "board", title: "Todo", icon: "ListTodo" (a valid BB icon name),
  path: "todo", component: TodoPage,
  headerContent: TodoHeaderActions,          // Archive button, + Tab button
  experimental_sidebarAccessory: OverdueAccessory,
})
```
- The host renders the title bar; do NOT repeat an `<h1>Todo</h1>` inside the page.
- `subPath` is the active list id (deep link `/plugins/todo/todo/<listId>`); navigate
  with `useBbNavigate().toPluginPanel("todo", { subPath: listId })`.
- Archive opens as an in-page overlay (`Dialog`, which the host renders as a bottom
  drawer on compact viewports) — NOT a second nav panel.

Layout, top to bottom: tab strip -> BACKLOG section -> TODAY section. See the ASCII
in `docs/UX.md`. The tab strip keeps its own tight spacing; the gap between the
Backlog and Today sections is much larger (`gap-8`, ~2rem, whitespace only, no
divider) since they are two distinct drop zones, not one continuous list.

### Components (one component per file, under `components/`)
- `TodoPage.tsx` — data fetching (`useRpc`, `useRealtime("board")`), the single
  `DndContext`, keyboard sensor included, and both sections.
- `TabStrip.tsx` — list tabs; double-click to rename inline, `+` to create, context
  menu (dropdown) to delete with an AlertDialog confirm, drag to reorder.
- `Section.tsx` — header (label, count, `ProgressRing`) + droppable body +
  `AddTaskRow`. The header ring shows Today's `completed/planned` in the primary
  tone, and Backlog's overdue share in the destructive tone.
- `TaskRow.tsx` — grip, checkbox, title (click to edit inline), `ProgressRing` when
  it has subtasks, a "carried Nx" badge, `AgeChip`, `DueChip`, then always-visible
  inline icon actions in this order: a calendar button (opens `DueDatePicker`
  directly, one click), a plus button on top-level rows only (reveals the inline
  add-subtask input directly, focused — not shown on subtask rows, since depth is
  capped at 1), and a `⋯` menu holding Delete only (behind the existing AlertDialog
  confirm). Renders its subtasks indented. Right-hand reading order: title -> ring
  -> carried badge -> age -> due -> actions.
- `AddTaskRow.tsx` — a borderless input; Enter creates and keeps focus for the next
  one, Escape blurs. This is the primary capture path — no modal. The placeholder
  and the leading `Plus` icon sit muted at `text-muted-foreground/50` at rest and
  lift to full `text-muted-foreground` on focus, so an idle add-row recedes until
  used. The same softened-placeholder treatment applies to every other text input
  in the tree (inline subtask input, tab rename/create input).
- `DueChip.tsx` — humanised, live-ticking, tone-coded.
- `AgeChip.tsx` — humanised "added N ago" context, rendered on every task row
  (top-level and subtasks) immediately before `DueChip`. Always
  `text-muted-foreground` — never tone-coded, since it's background context, not
  urgency, unlike `DueChip`. Hidden below the `sm` breakpoint if a narrow row needs
  the room (`DueChip` is always visible; `AgeChip` is the first thing to go).
- `ProgressRing.tsx` — inline SVG donut. Optional `tone` (`"primary" |
  "destructive"`, default `"primary"`) colors the arc via host tokens
  (`text-primary` / `text-destructive`); the track stays muted regardless of tone.
  Optional `label` overrides the default `done/total` text and optional `ariaLabel`
  overrides the accessible name (used by `Section` for e.g. "3/12 overdue" instead
  of "N of M subtasks done"). Used both inline on a task row (subtask progress) and
  in the `Section` header (Today/Backlog progress — this replaced `SectionBar`).
- `ArchivePanel.tsx` — day groups, restore per row, `Clear all` behind an
  AlertDialog confirm, paginated "Load more".
- `OverdueAccessory.tsx` — total overdue count; renders nothing at 0. Presentational
  only: no controls, no portals, clipped to one line ~4rem x 1.25rem.
- `TagChip.tsx` — one tag: colored dot, optionally paired with its name;
  dot-only renders a `Tooltip` carrying the name (`compact` prop).
- `TagChips.tsx` — a row's tag list: breakpoint pair with independent overflow
  caps (3 full chips at `md`+, 5 dots below it), renders nothing for `[]`.
- `ColorSwatchPicker.tsx` — the 8-swatch palette grid; controlled (`value`,
  `onChange`), shared by the inline create row and the tag manager.
- `TagPicker.tsx` — the row's 🏷 Popover: filters/creates tags, checkboxes
  apply the full `setTaskTags` set, hands off to the manager.
- `TagManagerDialog.tsx` — the `Manage tags…` surface: rename, recolor,
  delete (behind an AlertDialog confirm), and drag-reorder the global
  catalog; mounts once in `TodoPage`, opened via a `board-bus` command.

### `lib/humanize.ts` (pure, heavily unit-tested)
`formatDue(dueAt: number, now: number, hasDueTime: boolean)` ->
`{ text: string, tone: 'neutral' | 'soon' | 'late', tickMs: number }`

| condition | text |
|---|---|
| > 0 and < 60s | `in 10 seconds` (singular at 1) |
| < 60m | `in 22 min` |
| < 24h and same local day | `in 3 hours` |
| next local day | `tomorrow` + ` 9:00 am` when hasDueTime |
| within 7 days | `Fri` + ` 9:00 am` when hasDueTime |
| beyond | `Fri 22 Aug` (`+ year` if a different year) |
| past < 60s | `just now` |
| past < 60m | `12 min late` |
| past < 24h | `3 hours late` |
| past >= 24h | `2 days late` |

Tone: `late` when past due, `soon` when within 60 minutes, else `neutral`.
`tickMs`: 1000 under a minute out, 30000 under an hour, else 60000. A shared
`useNow(tickMs)` hook drives re-render; never one interval per row — compute the
minimum tickMs across visible chips in the page and run ONE interval.

`formatAge(createdAt: number, now: number)` -> `{ text: string, title: string }`.
`text` is compact and always prefixed with the word "added" so it can never be
mistaken for a due date; `title` is the full absolute local date/time (tooltip).
No tone — age is context, not urgency, so `AgeChip` never carries a tone class.

| age | text |
|---|---|
| < 60s | `added just now` |
| < 60m | `added 12m ago` |
| < 24h | `added 5h ago` |
| < 7d | `added 3d ago` |
| < 5 weeks | `added 2w ago` |
| beyond | `added 3mo ago` |

Whole units, no decimals. The existing shared `useNow` tick is reused (an age
chip changing once a minute is plenty) — `AgeChip` never starts its own interval.

### Styling
Host theme tokens only (`bg-card`, `text-muted-foreground`, `border-border`,
`text-destructive`, `bg-primary`, …). No hardcoded grays, no `oklch(...)`, no custom
`@theme` colors. Tone colors: neutral = `text-muted-foreground`, soon =
`text-amber-600 dark:text-amber-500`, late = `text-destructive`.
Rows are compact (min-h-8), the whole page must work at 420px wide. Placeholders
read as hints, not content: `placeholder:text-muted-foreground/50` at rest,
lifting to `text-muted-foreground` on focus (opacity modifiers on the `placeholder:`
variant only — never dim the input's typed text, which stays full `text-foreground`).

### Accessibility
Checkbox and every icon-only button need an accessible name. dnd-kit's keyboard
sensor must be wired so a task can be moved without a mouse. Announce completion
via the toast text.

## Testing (required, not optional)
- `order.test.ts`, `humanize.test.ts`, `rollover.test.ts` — pure unit tests.
- `server.test.ts` via `createFakePluginHost()` from `@get-bb/plugin-sdk/testing`:
  seeding, create/move/complete/restore/delete, subtask depth enforcement, cycle
  rejection, rollover idempotence, today counts after completion, archive grouping,
  clearArchive, list CRUD + last-list refusal, realtime publish on mutation.
- `app.test.tsx` via `loadPluginApp` + `renderSlot` from
  `@get-bb/plugin-sdk/testing/app`: board renders sections, add row calls
  `createTask`, checkbox calls `completeTask`, archive dialog calls `getArchive`,
  accessory shows the overdue count, a task row shows an `AgeChip` alongside its
  `DueChip`.
- `components/leaf.test.tsx`: `AgeChip` renders the expected text, exposes the
  absolute date via `title`, and is always muted (never a tone class).
- `npm test` (vitest) must pass with zero failures, and `npx tsc --noEmit` clean.
