# bb-plugin-todo — implementation spec (single source of truth)

An ADHD-friendly daily to-do plugin for BB. One page in the sidebar ("Todo") with
user-created tabs (Work, Personal, +), each tab holding a **Backlog** section and a
**Today** section in ONE drag-and-drop surface, one level of subtasks, humanised due
chips, progress graphs, and an Archive with undo.

Do not invent surfaces or fields beyond this spec. If something here is impossible
against the real SDK, say so in your report rather than silently substituting.

## Product rules (non-negotiable)

1. **The Backlog is the complete, always-true list.** Every open top-level
   task in the active list appears there, always, undimmed, fully
   interactive — no bucket filter, no exceptions. **Today is a filtered,
   project-grouped view over those same rows**, not a second place things
   live: it renders in the same single dnd context, side by side with the
   Backlog, and any item can be dragged Backlog -> Today, Today -> Backlog,
   or reordered within either.
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
   total = all rows with `day = today` in this list (open + done), generalized
   to cover auto-included tasks too: `completeTask` stamps `day = today` at the
   moment of completion for any row that was a Today member by the shared
   predicate (rule 7) but never had `day` written (because it was never
   manually scheduled). Only `day` is stamped, never `bucket` — a historical
   marker, not a reschedule. So completing 5 of 10 shows 5/10 even though
   those 5 are gone from the list, whether they got there by being dragged in
   or by falling due.
6. **Everything is per-list.** Overdue counts, archive, clear-archive: scoped to the
   active list. The sidebar accessory shows the total overdue across all lists.
7. **Today membership is derived, not stored as a place.** A task's home is
   `(project_id, parent_id, sort_order)` and it never leaves — Today is a
   lens over the Backlog's own rows, not a second location with its own
   copy. Membership is one predicate, defined once
   (`TODAY_MEMBERSHIP_SQL` / `isTodayMember` in `lib/db.ts`) and evaluated
   the same way everywhere it's needed:

   ```
   member = (bucket = 'today' AND day = today)                       -- manually scheduled
         OR (due_at IS NOT NULL AND due_at < startOfTomorrow          -- due today or overdue
             AND (today_dismissed_day IS NULL OR today_dismissed_day <> today))
   ```

   Dragging a task into Today sets `bucket='today'` + `day` and nothing else
   about its identity — `parent_id` and `project_id` stay untouched. A task
   whose due date lands today or earlier is *auto-included* with no write at
   all — pure derivation from `due_at`. Either way the task renders as a
   normal, undimmed, fully-interactive Backlog row (see the Storage section's
   `TaskDto.inToday`), never dimmed and never duplicated with a different
   visual treatment. Scheduling a subtask never schedules its parent, and
   scheduling a parent never drags its subtasks along. Depth stays capped at
   one level (rule 2); a project is a container, not a task, so this adds a
   third level of context without a third level of nesting.

   Removing a task from Today never mutates a fact the user didn't touch: a
   manually-scheduled task flips back to `bucket='backlog'` (the existing
   `moveTask` transition) and stamps `today_dismissed_day = today`; an
   auto-included task (never `bucket='today'`) has no flag to clear, so
   `dismissFromToday` stamps `today_dismissed_day` alone, touching nothing
   else. `today_dismissed_day` is self-expiring — it only suppresses
   membership while it equals today, so a still-overdue task returns
   tomorrow with no rollover write and nothing to clean up.

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
-- 10
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  list_id    TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  collapsed  INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL,
  created_at INTEGER NOT NULL
);
-- 11
CREATE INDEX IF NOT EXISTS projects_list_idx ON projects (list_id, sort_order);
-- 12
ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id);
-- 13
ALTER TABLE tasks ADD COLUMN today_order REAL;
-- 14
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (list_id, project_id, sort_order);
-- 15
UPDATE tasks SET today_order = sort_order WHERE bucket = 'today';
-- 16
ALTER TABLE tasks ADD COLUMN today_dismissed_day TEXT;
-- 17
ALTER TABLE projects ADD COLUMN today_collapsed INTEGER NOT NULL DEFAULT 0;
```

`projects.color` reuses `TAG_COLORS`/`lib/tag-colors.ts`, exactly like
`tags.color`. Migration 12 deliberately declares no `ON DELETE` clause — with
`PRAGMA foreign_keys = ON` (see below), the implicit behaviour is `NO ACTION`
(delete rejected), not a cascade, so `deleteProject` explicitly releases its
tasks to `project_id = NULL` inside its own transaction rather than relying
on the FK. Migration 15 is a one-time backfill: every existing Today row
keeps its exact current position (`today_order = sort_order`) on first load,
and it is not re-runnable — get it right against a pre-migration fixture DB
before shipping a change to it. Migration 16 is purely additive and
backfills nothing: `today_dismissed_day IS NULL` means "never explicitly
removed from Today", which is already correct for every existing row.
Migration 17 is likewise purely additive with no backfill needed: collapse
state is per-column — `projects.collapsed` (migration 10) is now
specifically the BACKLOG column's collapse state, and `today_collapsed` is
Today's. Both columns render the same `ProjectDto` at once, so a single
shared bit meant collapsing a project in one column silently collapsed it
in the other; `0` (expanded) is already the correct starting state for
Today on every existing project.

`project_id = NULL` means "loose" (unfiled); every task predating this
feature gets that value automatically and renders exactly as before, below
every project, with no group header. `sort_order` means "position within its
project (or the loose group), under its parent" — the *only* order column
either view reads. **`today_order` is abandoned, not dropped**: nothing
reads or writes it anymore (`writeOrder` narrows to `sort_order` alone, and
a source-scanning test in `lib/db.test.ts` asserts zero `today_order` writes
anywhere in `lib/db.ts`), but the column stays in the schema as a rollback
escape hatch and the revivable answer if shared ordering between Backlog and
Today ever turns out to grate. Today now inherits `sort_order`, so
reordering a task in the Today view reorders it in the Backlog too — that is
the intended meaning of "Today is a filtered view", not a bug. `parent_id`
is never cleared by a bucket change (dragging into Today is a flag, not a
relocation — see the Core decision below); a subtask's `project_id` always
mirrors its parent's, enforced inside the move/create transaction.
`today_dismissed_day` records the local day (`YYYY-MM-DD`) a task was last
explicitly removed from the Today view — see rule 7. It is never sent on the
wire; the client only ever sees its effect via `TaskDto.inToday`.

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

// Denormalized breadcrumb for a task's home, computed server-side in the
// same pass that denormalizes tags. null for a loose top-level task.
TrailDto = {
  projectId: string|null, projectName: string|null, projectColor: TagColor|null,
  parentId: string|null, parentTitle: string|null,
}

TaskDto = {
  id, listId, parentId: string|null, title, notes: string|null,
  bucket: 'backlog'|'today', day: string|null, sortOrder: number,
  dueAt: number|null, hasDueTime: boolean, status: 'open'|'done',
  completedAt: number|null, carriedCount: number,
  createdAt, updatedAt,
  subtasks: TaskDto[]          // present on top-level rows only, always [] on subtasks
  subtaskCounts: { total: number, done: number }   // done counts done subtasks
  tags: TagRefDto[]            // ordered by tag sortOrder; populated on subtasks too
  projectId: string|null       // NULL = loose (not filed into a project)
  trail: TrailDto|null
  inToday: boolean             // computed server-side by the shared membership
                                // predicate (rule 7); the one bit the client
                                // cannot reconstruct on its own. `today_dismissed_day`
                                // itself is never sent.
}
ListDto = { id, name, sortOrder, openCount, overdueCount }
ProjectDto = {
  id, listId, name, color: TagColor, sortOrder: number,
  collapsed: boolean,       // Backlog column's collapse state
  todayCollapsed: boolean,  // Today column's collapse state, independent of the above
  openCount: number, todayCount: number, overdueCount: number,
}
```

`color` is validated against `TAG_COLORS` at the contract boundary
(`z.enum(TAG_COLORS)`); an unknown key is an `invalid_input` error, not a
silent fallback.

Methods:
- `getBoard({ listId: string|null })` -> `{ lists: ListDto[], activeListId: string,
  today: { day: string, planned: number, completed: number },
  backlog: { total: number, overdue: number, tasks: TaskDto[] },
  totalOverdue: number, serverNow: number, tags: TagDto[], projects: ProjectDto[] }`
  - `activeListId` falls back to the first list when the argument is null or unknown.
  - **`today` carries no `tasks` array.** The Backlog is comprehensive (see
    below), so every field a Today row needs — `bucket`, `day`, `dueAt`,
    `inToday`, `projectId`, `parentId`, `trail` — already sits on every
    `TaskDto` in `backlog.tasks`. The client derives the grouped Today view
    from that single tree via the pure `lib/todayView.ts`, rather than
    trusting a second, independently-built server traversal that could
    disagree with the first. This is safe **only** because `backlog.tasks`
    is comprehensive — see the note below and the design doc.
  - `backlog.tasks` are top-level rows only, ordered by `sort_order`, each
    with its `subtasks` nested and ordered — **every open task in the list,
    unconditionally**. There is no bucket filter here at all: a task's
    presence in the Backlog no longer depends on whether it's also in Today.
  - `backlog.overdue` counts overdue rows across the *whole* list, not just
    a `bucket='backlog'` subset — overdue-ness is a Backlog fact now, since
    the Backlog is the only place it's authoritatively surfaced.
  - `planned` = `completed` (see below) plus every currently-open row
    satisfying the Today membership predicate (rule 7); `completed` = rows
    with `day = today AND status='done'`. Both count top-level rows AND
    subtasks. Because `completeTask` stamps `day` for auto-included rows too
    (rule 5), the ring's two halves can never disagree with what's actually
    in play.
  - `tags` is the full tag catalog with usage counts, so the picker needs no
    extra fetch. `getArchive`'s output is **not** extended with this catalog —
    archived rows carry `TaskDto.tags` like any other row, but the archive
    panel renders no picker, so it needs no catalog.
  - `projects` is every project in the active list, in `sort_order`; each
    `ProjectDto.todayCount` uses the same membership predicate as the board,
    so a project's "N today" badge picks up an auto-included task too, not
    only one someone dragged in.
  - Tag lookups for every row on the board are done with **one** query
    (`loadTagMap` in `lib/db.ts`), never a per-task query — see the N+1 note
    below.

  > **Tripwire.** Deriving Today client-side from `backlog.tasks` is correct
  > only while the Backlog stays comprehensive and unpaged. If the Backlog
  > is ever virtualized or lazily paged, Today silently goes blind to
  > anything outside the loaded window — see README's Known gaps and
  > `docs/design/2026-08-31-today-as-view.md`.
- `getArchive({ listId: string, limit: number (<=200, default 100), offset: number })`
  -> `{ groups: [{ day: string, tasks: TaskDto[] }], total: number, hasMore: boolean }`
  grouped by the local day of `completed_at`, newest first. Subtasks appear nested
  under their parent when the parent is in the same group, otherwise as their own row.
- `createTask({ listId, bucket, title, parentId: string|null, dueAt: number|null,
  hasDueTime: boolean, position: 'top'|'bottom', projectId?: string|null })`
  -> `{ task: TaskDto }`
  - Rejects an empty/whitespace title (`invalid_input`) and a `parentId` that is
    itself a subtask.
  - `projectId` is optional, defaulting to loose (`null`) when omitted — there
    is no prior row to leave "unchanged" for a brand-new task, unlike
    `moveTask`'s `projectId` below.
- `updateTask({ id, title?, notes?, dueAt?, hasDueTime? })` -> `{ task: TaskDto }`
  (`dueAt: null` clears the due date).
- `moveTask({ id, bucket, parentId: string|null, beforeId: string|null,
  afterId: string|null, projectId?: string|null })` -> `{ ok: true }`
  - `beforeId`/`afterId` are the sibling ids the item lands between, in the target
    group. Both null = only item / append.
  - `projectId` is the task's target home; **omitting it leaves the task's
    current project unchanged** — this is what keeps a task's home
    `(project_id, parent_id, sort_order)` untouched by scheduling it into
    Today, and what makes unscheduling it snap back to that exact slot
    regardless of where it's dropped. Only a drop directly onto a
    *different* project re-homes a task, by passing that project's id.
  - The `today -> backlog` transition additionally stamps
    `today_dismissed_day = today` (see rule 7) — unconditional, and harmless
    on a row with no due date. This is what stops a manually-scheduled *and*
    overdue task from boomeranging straight back into Today the instant its
    `bucket` flips away from `'today'`. Entering Today (`backlog -> today`)
    clears any stale `today_dismissed_day` from an earlier day.
  - Making a task a subtask promotes that task's own children to top-level siblings
    placed immediately after it, in their existing order.
  - Rejects a move that would create a cycle or a depth > 1.
  - A subtask's `project_id` always mirrors its (possibly new) parent's,
    enforced in the same transaction.
- `completeTask({ id })` -> `{ completedIds: string[] }`. Also stamps `day`
  per rule 5 for any completed row that was an auto-included Today member
  with no `day` of its own yet.
- `dismissFromToday({ id })` -> `{ ok: true }`. The counterpart to
  `moveTask`'s dismissal stamp, for a task that was never manually scheduled
  (`bucket='backlog'`) but renders in Today purely because it's due today or
  overdue — there's no `moveTask` transition to hang the stamp off, so this
  is a single-column write of `today_dismissed_day`, touching nothing else
  about the task.
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
- `createProject({ listId, name, color: TagColor })` -> `{ project: ProjectDto }`.
- `updateProject({ id, name?, color?: TagColor })` -> `{ project: ProjectDto }`.
- `deleteProject({ id })` -> `{ ok: true }`. Releases the project's tasks to
  loose (`project_id = NULL`) inside the transaction; never cascades into
  the bin, and never touches `parent_id`/`bucket`/`day`.
- `reorderProjects({ listId, ids: string[] })` -> `{ projects: ProjectDto[] }`.
  Renumbers to `1000, 2000, …`, mirroring `reorderLists`/`reorderTags`.
- `setProjectCollapsed({ id, collapsed: boolean, column: 'backlog'|'today' })`
  -> `{ ok: true }`. Server-side so collapse state survives a reload —
  single-user local plugin, no cost. **Per-column, not shared**: `column`
  says which of `ProjectDto.collapsed` (backlog) / `todayCollapsed` (today)
  this call writes; the other field is never touched by the same call. This
  matters because the Backlog and Today columns render the same
  `ProjectDto` at once — without a discriminator, collapsing a project in
  one column would silently collapse it in the other too.

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

Layout: tab strip, then two side-by-side columns — Backlog left, Today right —
each independently scrollable, inside a `@container` wrapper that degrades to
a stacked layout (Today first) on narrow panels via Tailwind v4 native
container queries, **never** viewport media queries (a bb nav panel's width
is independent of the browser viewport — a maximized window with a narrow
panel must still stack). See the ASCII in `docs/UX.md`.

### Components (one component per file, under `components/`)
- `TodoPage.tsx` — data fetching (`useRpc`, `useRealtime("board")`), the single
  `DndContext` spanning both columns, keyboard sensor included, and the
  `@container` wrapper around both columns.
- `TabStrip.tsx` — list tabs; double-click to rename inline, `+` to create, context
  menu (dropdown) to delete with an AlertDialog confirm, drag to reorder.
- `Section.tsx` — header (label, count, `ProgressRing`) + droppable body +
  `AddTaskRow`, one per column. The header ring shows Today's
  `completed/planned` in the primary tone, and Backlog's overdue share in the
  destructive tone. Both columns render the identical shape: one
  `ProjectGroup` per project (a nested `SortableContext` per project, plus an
  outer one over the project ids for header reordering — Backlog only, see
  `ProjectGroup.tsx`), followed by every loose top-level task with no group
  header. `#Name` + Enter in the Backlog's own `AddTaskRow` creates a project
  inline instead of a task.
- `ProjectGroup.tsx` — a project's card: `ProjectHeader` + a droppable body
  (append-to-project / re-home drop target) + a per-project `AddTaskRow`.
  Collapsed renders the header alone; an empty expanded project renders the
  header plus its add-row only in the Backlog. In the Today column, an empty
  project group renders nothing at all — Today is an ephemeral view, so a
  project with nothing due or scheduled simply doesn't appear there, unlike
  the Backlog where an empty project is a durable, always-visible container.
- `ProjectHeader.tsx` — in the Backlog: collapse chevron, colour badge (opens
  the shared `ColorSwatchPicker`), inline-editable name (double-click, same
  mechanics as `TabStrip`'s tab rename), a `+` that reveals and focuses the
  project's add-row, and a `⋯` menu (Rename / Change colour / Delete, the
  last behind the existing `AlertDialog`). In the Today column the header is
  a read-only, non-draggable label: the name and colour badge render, and
  collapse still works, but rename/colour/delete/`+`/reordering are Backlog
  only — one editing surface per concept, and two draggable orderings of one
  `projects.sort_order` would fight each other.
- `TrailLine.tsx` — a Today row's muted second line, `# Project > Parent`.
  Renders for exactly one live case: a Today row whose *parent* is not also
  in Today. Inside a project group it shows the parent segment only (the
  group header already names the project); in the loose/`Unfiled` group it
  keeps both segments. Renders null with no context to show; truncates from
  the left so the nearest ancestor survives; each segment is independently
  clickable (scrolls the Backlog to the source row and flashes it); collapses
  to the project badge alone below `md`. Archive's use of `TrailLine` is
  unaffected by any of this.
- `TaskRow.tsx` — grip, always-real checkbox (no ghost swap), title (click to
  edit inline), `ProgressRing` when it has subtasks, a "carried Nx" badge, a
  subtle today marker whenever `task.inToday` — no longer either/or with the
  carried badge; a row can show both at once — `AgeChip`, `DueChip`, then
  always-visible inline icon actions in this order: a calendar button (opens
  `DueDatePicker` directly, one click), a plus button on top-level rows only
  (reveals the inline add-subtask input directly, focused — not shown on
  subtask rows, since depth is capped at 1), and a `⋯` menu holding Delete
  only (behind the existing AlertDialog confirm). Renders its subtasks
  indented. Right-hand reading order: title -> ring -> carried badge ->
  today marker -> age -> due -> actions, with `TrailLine` as an optional
  second line under a Today row. The same task can render at once in both
  columns whenever `inToday` is true, so its dnd-kit sortable id is prefixed
  (`taskDragId`) to stay unique within the single shared `DndContext` — this
  is not ghost machinery and is *more* load-bearing after ghosts than before,
  since every `inToday` task now renders twice, not just scheduled ones.
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
  absolute date via `title`, and is always muted (never a tone class);
  `ProjectHeader`/`ProjectGroup`/`TrailLine`/`TaskRow` rendering and
  callbacks, presentational and fixture-driven, including the `variant`
  differences between a Backlog and a Today `ProjectHeader`/`ProjectGroup`
  and the today marker's rendering alongside a carried badge.
- `lib/todayView.test.ts`: table-driven pure tests of `selectTodayView`
  against `backlog.tasks` fixtures — manual-only, auto-only, both, dismissed
  today (excluded), dismissed yesterday (reappears), orphan-subtask
  grouping, empty-project suppression.
- `lib/drag.test.ts`: the full drag matrix (backlog<->today, reorder, nest,
  project filing/re-homing, project header reorder) as table-driven pure
  tests against `computeTaskMove`/`computeProjectReorder`/`applyMoveToBoard`
  — no DOM, no dnd-kit runtime.
- `components/TodoPage.test.tsx`: end-to-end proof spanning the drag layer
  AND the board's rendering together, through a REAL dnd-kit gesture (the
  same `stubSequentialRects` keyboard-drag technique as the base
  reorder/optimistic tests) — a subtask dragged from its project into Today
  keeps its parent and the Today row shows its trail; the subtask stays
  visible, undimmed and fully interactive, in its project, marked; dragging
  it back to the Backlog snaps it home regardless of drop position; a
  carried task still renders its full trail; the project header's `+`
  reveals and focuses its add-row (Backlog only); a task visible in both
  columns at once (a live `inToday` task) can still be dragged without a
  dnd-kit id collision.
- `npm test` (vitest) must pass with zero failures, and `npx tsc --noEmit` clean.
