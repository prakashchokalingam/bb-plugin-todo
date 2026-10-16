# bb-plugin-todo — implementation spec (single source of truth)

An ADHD-friendly daily to-do plugin for BB. One page in the sidebar ("Todo") with
user-created tabs (Work, Personal, +), each tab holding a **Backlog** section and an
**In Progress** section in ONE drag-and-drop surface, one level of subtasks, humanised
due chips, progress graphs, and an Archive with undo.

Do not invent surfaces or fields beyond this spec. If something here is impossible
against the real SDK, say so in your report rather than silently substituting.

## Product rules (non-negotiable)

1. **The Backlog is the complete, always-true list.** Every open top-level
   task in the active list appears there, always, undimmed, fully
   interactive — no stage filter, no exceptions. **In Progress is a
   filtered, project-grouped view over those same rows**, not a second
   place things live: it renders in the same single dnd context, side by
   side with the Backlog, and any item can be dragged Backlog -> In
   Progress, In Progress -> Backlog, or reordered within either.
2. **Subtasks are exactly one level deep.** A task with `parent_id` cannot itself
   have children. Dropping a top-level task onto another top-level task makes it a
   subtask (its own subtasks are promoted to top-level siblings at the drop point).
   Dragging a subtask into a section makes it top-level. Dragging a parent moves its
   subtasks with it.
3. **Done vanishes immediately.** Completing sets `status='done'` + `completed_at`.
   The row leaves Backlog/In Progress at once and appears in Archive. An 8s sonner
   toast offers Undo; Archive offers restore forever. Completing a parent completes
   its open subtasks (and undo restores exactly the set it completed — pass the ids
   back through the undo call).
4. **There is no rollover, no "Today," no calendar-driven membership.** The
   "Today" concept (a day-scoped view superimposed on the stage axis) is
   deleted entirely — see `docs/design/2026-09-01-two-blocks.md`, which
   supersedes `docs/design/2026-08-31-today-as-view.md`. There is no
   `day` column, no `dismissed_day`, no `lib/rollover.ts`, no midnight cron,
   nothing that moves a task in or out of In Progress on its own. A due
   date is purely informational: it renders its humanised, tone-coded chip
   wherever the task happens to be, and an overdue task counts toward the
   overdue ring, but it never pulls itself into In Progress. Only a person
   — by dragging or by the row's own stage toggle — decides what's in
   progress.
5. **In Progress's progress survives the vanish.** The In Progress ring
   reads `completed / (completed + openInProgress)`, where `completed` =
   `status='done' AND stage='in_progress'` and `openInProgress` = every
   currently-open row satisfying the membership predicate (rule 7). This
   needs no special stamping at all: `completeTask` never touches `stage`,
   so a row that was `stage='in_progress'` at the moment it completed
   simply stays `stage='in_progress'` forever after, and the ring's
   `completed` half reads that directly. So completing 5 of 10 shows 5/10
   even though those 5 are gone from the board.
6. **Everything is per-list.** Overdue counts, archive, clear-archive: scoped to the
   active list. The sidebar accessory shows the total overdue across all lists.
7. **In Progress membership is derived, not stored as a place, and is
   SOLELY the `stage` column.** A task's home is `(project_id, parent_id,
   sort_order)` and it never leaves — In Progress is a lens over the
   Backlog's own rows, not a second location with its own copy. Membership
   is one predicate, defined once (`IN_PROGRESS_MEMBERSHIP_SQL` /
   `isInProgressMember` in `lib/db.ts`) and evaluated the same way
   everywhere it's needed:

   ```
   member = (stage = 'in_progress')
   ```

   That is the entire predicate — no `day`, no `due_at`, no dismissal
   state. Dragging a task into In Progress sets `stage='in_progress'` and
   nothing else about its identity — `parent_id` and `project_id` stay
   untouched. The task renders as a normal, undimmed, fully-interactive
   Backlog row (see the Storage section's `TaskDto.inProgress`), never
   dimmed and never duplicated with a different visual treatment.
   Scheduling a subtask never schedules its parent, and scheduling a
   parent never drags its subtasks along. Depth stays capped at one level
   (rule 2); a project is a container, not a task, so this adds a third
   level of context without a third level of nesting.

   Removing a task from In Progress never mutates a fact the user didn't
   touch other than `stage` itself: it flips back to `stage='pending'`
   (via `moveTask` or `setTaskStage`, rule 8 below) and nothing else about
   its identity changes. There is no dismissal state to stamp or expire —
   a `pending` row can never boomerang back into In Progress on its own,
   because nothing but `stage` decides membership.

   Two ways to add/remove a task from In Progress exist side by side: the
   drag gesture (`moveTask`, above) and the one-click **Move to In
   Progress / Move to Backlog** toggle on the row itself (`setTaskStage`,
   rule 8 below) — both funnel through the same `in_progress_since`
   write rule (`nextInProgressSince` in `lib/db.ts`), so neither can leave
   the other's state inconsistent.

8. **The stage toggle is a single-click alternative to dragging, not a
   second membership rule.** **Move to In Progress** (shown on a
   Backlog-column row) and **Move to Backlog** (shown on an In
   Progress-column row) both call `setTaskStage({ id, stage })`. Gated on
   which column the *rendered instance* is in (`inProgressColumn`), never
   on the task's own `inProgress`/`stage` bits, so both of a
   dual-rendered row's instances show the affordance that matches where
   they are, not a guess about the task's "true" state. It is ALWAYS
   visible (not hover-revealed) — this is now the primary way to move
   work between the two blocks, alongside dragging. `setTaskStage("in_progress")`
   stamps `in_progress_since` to now (starting the carried-days clock —
   rule 9 below) and places the row at the top of its home-sibling group
   (mirroring `createTask`'s `position: "top"` idiom, since there's no
   drop position to snap to); `setTaskStage("pending")` clears
   `in_progress_since` back to `NULL` (the carried-days counter RESETS on
   park, by design) and leaves `sort_order` untouched — same snap-home
   rationale as `moveTask`'s leaving-In-Progress branch. There is
   deliberately no keyboard binding for this toggle: dnd-kit's
   `KeyboardSensor` already owns the arrow keys on the row's own drag
   handle once a keyboard drag is picked up (Space/Enter), and inventing a
   second focusable "select this row" target to host new arrow-key
   bindings would risk colliding with that existing vocabulary untested.
   Mouse/touch (click) and screen readers (the button's own tab stop +
   `aria-label` "Move to In Progress"/"Move to Backlog") both already
   work; see `TaskRow.tsx`'s file header comment for the full reasoning.
9. **Carried days reset on park, by design.** `in_progress_since` (epoch
   ms) is stamped the instant `stage` flips `pending -> in_progress` and
   cleared to `NULL` the instant it flips back. `TaskDto.carriedDays` is
   derived at *read time* from it (`localDayDiff` in `lib/day.ts`) — whole
   local-calendar-days since that stamp, 0 for same-day — never stored as
   a durable, ever-incrementing counter. Parking a task back to the
   Backlog and later starting it again begins the clock at 0, not from
   wherever it left off: the product intent is to reward actually dealing
   with a stalled task (even by shelving it), not to keep a permanent
   scoreboard against it. The row's "carried Nd" badge only renders once
   `carriedDays >= 1`. The old `carried_count` column is a read-only
   escape hatch (see migration 20 below) — nothing writes it anymore.

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
-- 18 — the today-as-view rename: `bucket` ('backlog'/'today') becomes
-- `stage` ('pending'/'in_progress'), and its satellite columns rename to
-- match (today_order -> in_progress_order, today_dismissed_day ->
-- dismissed_day). SQLite cannot ALTER a CHECK constraint in place, so this
-- is a full table rebuild, not a rename-in-place like migration 19 below.
ALTER TABLE tasks RENAME TO tasks_old;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('pending','in_progress')),
  day TEXT,
  sort_order REAL NOT NULL,
  due_at INTEGER,
  has_due_time INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  completed_at INTEGER,
  carried_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  project_id TEXT REFERENCES projects(id),
  in_progress_order REAL,
  dismissed_day TEXT
);

INSERT INTO tasks (
  id, list_id, parent_id, title, notes, stage, day, sort_order, due_at,
  has_due_time, status, completed_at, carried_count, created_at,
  updated_at, project_id, in_progress_order, dismissed_day
)
SELECT
  id, list_id, parent_id, title, notes,
  CASE bucket WHEN 'today' THEN 'in_progress' ELSE 'pending' END,
  day, sort_order, due_at, has_due_time, status, completed_at,
  carried_count, created_at, updated_at, project_id, today_order,
  today_dismissed_day
FROM tasks_old
ORDER BY (parent_id IS NOT NULL);

CREATE TABLE task_tags_new (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
INSERT INTO task_tags_new (task_id, tag_id) SELECT task_id, tag_id FROM task_tags;
DROP TABLE task_tags;
ALTER TABLE task_tags_new RENAME TO task_tags;

DROP TABLE tasks_old;

CREATE INDEX IF NOT EXISTS tasks_board_idx
  ON tasks (list_id, status, stage, parent_id, sort_order);
CREATE INDEX IF NOT EXISTS tasks_archive_idx
  ON tasks (list_id, status, completed_at DESC);
CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks (status, due_at);
CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_id);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (list_id, project_id, sort_order);
CREATE INDEX IF NOT EXISTS task_tags_tag_idx ON task_tags (tag_id);
-- 19 — the projects half of the same rename. No CHECK constraint on this
-- column, so unlike migration 18 this is a plain in-place rename.
ALTER TABLE projects RENAME COLUMN today_collapsed TO in_progress_collapsed;
-- 20 — "Today" is deleted entirely: In Progress membership is now SOLELY
-- `stage = 'in_progress'` (see `IN_PROGRESS_MEMBERSHIP_SQL`). A due date is
-- just a due date and never pulls a task into In Progress. That retires
-- `day` (which calendar day a row belonged to In Progress) and
-- `dismissed_day` (the due-date-auto-include refusal stamp) — both
-- meaningless once due dates can't cause membership — and replaces the old
-- `carried_count` mechanic with `in_progress_since` (epoch ms, stamped the
-- instant `stage` flips pending -> in_progress, cleared to NULL the instant
-- it flips back — the counter resets on park, by design). `carriedDays` on
-- the wire is derived from it at read time (`localDayDiff` in
-- `lib/day.ts`) instead of being a durable counter. `carried_count` itself
-- is deliberately KEPT (not dropped) for one release as a read-only escape
-- hatch. Unlike migration 18, nothing here touches a CHECK constraint, so
-- this doesn't need a full table-rebuild: SQLite has supported
-- `ALTER TABLE ... DROP COLUMN` directly since 3.35.0.
ALTER TABLE tasks ADD COLUMN in_progress_since INTEGER;

-- Backfill: preserve every existing "carried Nx" streak as
-- in_progress_since = now - N days, so a task already carried 6 times
-- reads as carried 6d immediately, with no reset.
UPDATE tasks
SET in_progress_since = CAST(strftime('%s','now') AS INTEGER) * 1000 - carried_count * 86400000
WHERE stage = 'in_progress' AND status = 'open';

ALTER TABLE tasks DROP COLUMN day;
ALTER TABLE tasks DROP COLUMN in_progress_order;
ALTER TABLE tasks DROP COLUMN dismissed_day;
```

`projects.color` reuses `TAG_COLORS`/`lib/tag-colors.ts`, exactly like
`tags.color`. Migration 12 deliberately declares no `ON DELETE` clause — with
`PRAGMA foreign_keys = ON` (see below), the implicit behaviour is `NO ACTION`
(delete rejected), not a cascade, so `deleteProject` explicitly releases its
tasks to `project_id = NULL` inside its own transaction rather than relying
on the FK. Migration 15 is a one-time backfill: every existing Today row
kept its exact current position (`today_order = sort_order`) on first load,
and it was not re-runnable. Migration 16 was purely additive and backfilled
nothing: `today_dismissed_day IS NULL` meant "never explicitly removed from
Today", which was already correct for every existing row. Migration 17 was
likewise purely additive with no backfill needed: collapse state is
per-column — `projects.collapsed` (migration 10) is specifically the
BACKLOG column's collapse state, and `today_collapsed` (renamed to
`in_progress_collapsed` by migration 19) is In Progress's. Both columns
render the same `ProjectDto` at once, so a single shared bit meant
collapsing a project in one column silently collapsed it in the other; `0`
(expanded) was already the correct starting state for every existing
project.

**Migration 18's single highest-risk detail:** `task_tags.task_id` carries
`REFERENCES tasks(id) ON DELETE CASCADE` (migration 8), and the connection
runs with `foreign_keys = ON` for the entire migration (`server.ts` sets the
pragma before calling `bb.storage.migrate`, and the migration runner wraps
every statement in this array in one `db.transaction()`). `PRAGMA
foreign_keys` is a documented no-op while a transaction is open — confirmed
empirically, `db.pragma("foreign_keys = OFF")` mid-transaction still reads
back as `1` — so there is no point in the migration where the cascade can be
switched off. With foreign keys on, a plain `DROP TABLE tasks` performs an
implicit `DELETE FROM tasks` first and DOES run the cascade on that implicit
delete, so the naive "create tasks_new, copy in, drop tasks, rename" recipe
would have silently wiped every `task_tags` row the instant `DROP TABLE
tasks` ran (also verified empirically). The fix moves the FK itself rather
than the data under it: (1) `ALTER TABLE tasks RENAME TO tasks_old` —
modern SQLite (`legacy_alter_table = 0`, the default here) rewrites the
`REFERENCES` clause in every *other* table's schema on a rename, so this
retargets `task_tags`'s FK to `tasks_old` without touching a row; (2)
create the new `tasks` under its live final name, with nothing pointed at
it yet so no cascade can fire; (3) copy every row across with an explicit
column list on both sides (never `SELECT *`), translating
`bucket`/`today_order`/`today_dismissed_day` to
`stage`/`in_progress_order`/`dismissed_day`; (4) rebuild `task_tags` itself
so its FK targets the new `tasks`, not `tasks_old`; (5) only now is
`tasks_old` unreferenced by anything, so `DROP TABLE tasks_old` is a plain,
cascade-free removal. See the "migration 18" describe block in
`lib/db.test.ts` for the regression test that builds a pre-18 fixture (with
`task_tags` rows and subtasks) and asserts nothing is lost.

`project_id = NULL` means "loose" (unfiled); every task predating this
feature gets that value automatically and renders exactly as before, below
every project, with no group header. `sort_order` means "position within its
project (or the loose group), under its parent" — the *only* order column
either view reads; there is no separate In Progress ordering column
anymore. `in_progress_order` (introduced by migration 13/renamed by
migration 18 as `today_order`'s successor) was abandoned in an earlier
phase — nothing read or wrote it — and migration 20 finally drops it
outright: In Progress inherits `sort_order` permanently now, so reordering
a task in the In Progress view reorders it in the Backlog too, which is the
intended meaning of "In Progress is a filtered view", not a bug.
`parent_id` is never cleared by a stage change (dragging into In Progress
is a flag, not a relocation — see the Core decision in
`docs/design/2026-09-01-two-blocks.md`, which supersedes
`docs/design/2026-08-31-today-as-view.md`); a subtask's `project_id`
always mirrors its parent's, enforced inside the move/create transaction.
`in_progress_since` (epoch ms, migration 20) is stamped the instant `stage`
flips pending -> in_progress and cleared to `NULL` the instant it flips
back — see rule 9. It is never sent on the wire; the client only ever sees
its effect via `TaskDto.carriedDays`.

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

`bb.storage.kv`: unused. There is no rollover, so nothing needs a
last-run marker; do not add one.

### Fractional ordering (`order.ts`, pure + unit-tested)
- `nextOrder(prev: number | null, next: number | null): number` — midpoint;
  `prev + 1000` when next is null; `next - 1000` when prev is null; `1000` when both
  are null.
- If `Math.abs(next - prev) < 0.0001`, the caller REBALANCES the affected sibling
  group to `1000, 2000, 3000, …` in a transaction and recomputes. Test this path.

### Day handling
- The **server-local** day, formatted `YYYY-MM-DD`, is still used for two
  things and only two: humanising due-date chips ("today", "tomorrow", "Fri
  9:00am" — `lib/humanize.ts`) and grouping the Archive by the local day of
  `completed_at`. Put `localDay(date: Date): string` in one place and use it
  everywhere; never build a day string from `toISOString()` (that is UTC and
  will be wrong in the evening).
- There is no rollover, no midnight cron, and no `bucket`/`stage`-adjacent
  meaning of "day" left at all — `lib/rollover.ts` is deleted along with the
  `day` column it operated on (migration 20). The `stage` axis (In Progress
  membership) is completely independent of the calendar now.
- `carriedDays` is derived from `in_progress_since` via
  `localDayDiff(fromMs, now)` in `lib/day.ts` — whole local-calendar-days
  since the most recent pending -> in_progress flip, 0 for same-day. This is
  the one place "day" still touches the `stage` axis, and it is read-only
  arithmetic on a timestamp, not a stored bucket.
- Subtasks do NOT automatically mirror their parent's `stage` — see rule 7:
  scheduling a subtask never schedules its parent, and scheduling a parent
  never drags its subtasks along. (This reverses what an earlier phase of
  this spec said; `moveTask`/`setTaskStage` never cascade a stage change to
  children.)

## Image attachments

- **Bytes on disk, metadata in SQLite.** Files live in `<plugin data dir>/images/`
  (the directory that holds `data.db`, found as `dirname(conn.name)`; never the
  plugin source). `task_images` holds one row per file. No base64 is stored.
- **Transport.** RPC is JSON, so `createTask.images` and `updateTask.addImages`
  carry base64. The server decodes, checks the magic bytes (PNG, JPEG, GIF,
  WebP only; SVG is refused), writes the file, then inserts the row in the same
  transaction as the task change. Reads use `GET http/image?id=<imageId>`
  (exact-match route, `local` auth, `nosniff`, sandbox CSP). `ImageDto.url` is that path.
- **Limits** (`IMAGE_LIMITS` in `contract.ts`): 5 MB per image, 10 per task,
  16 MB per request.
- **Lifecycle.** Complete and archive keep images. Migration 24 adds a trigger:
  every delete of a `task_images` row, including FK cascades from a task,
  subtask, list, or clear-archive, inserts the file name into `image_cleanup` in
  the same transaction. `ImageStore.processCleanup` unlinks queued files and
  retries failures with exponential backoff. It runs after each deleting RPC, at
  start, and every 5 minutes (`image-cleanup` schedule). Reconciliation queues
  files that have no row and no queue entry, are not in flight in this process,
  and are older than 10 minutes.
- **Frontend.** Pasting an image (with no text on the clipboard) attaches it.
  The add row sends text and images in one `createTask`; the task editor sends
  them in one `updateTask`. On failure the input stays open with its text and
  images and shows the error.

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
  stage: 'pending'|'in_progress', sortOrder: number,
  dueAt: number|null, hasDueTime: boolean, status: 'open'|'done',
  completedAt: number|null, carriedDays: number,
  createdAt, updatedAt,
  subtasks: TaskDto[]          // present on top-level rows only, always [] on subtasks
  subtaskCounts: { total: number, done: number }   // done counts done subtasks
  tags: TagRefDto[]            // ordered by tag sortOrder; populated on subtasks too
  images: ImageDto[]           // oldest first, max 10; populated on subtasks too
  projectId: string|null       // NULL = loose (not filed into a project)
  trail: TrailDto|null
  inProgress: boolean          // computed server-side by the shared membership
                                // predicate (rule 7): true iff stage ===
                                // 'in_progress', full stop. Sent explicitly
                                // anyway so the client never needs its own
                                // copy of the membership rule.
}
// No `day` field — "Today" is gone; a due date is just a due date now.
// `carriedDays` is whole local-calendar-days since `in_progress_since`,
// derived at read time (rule 9), NOT a durable counter — 0 once parked.
ListDto = { id, name, sortOrder, openCount, overdueCount }
ProjectDto = {
  id, listId, name, color: TagColor, sortOrder: number,
  collapsed: boolean,          // Backlog column's collapse state
  inProgressCollapsed: boolean,// In Progress column's collapse state, independent of the above
  openCount: number, inProgressCount: number, overdueCount: number,
}
```

`color` is validated against `TAG_COLORS` at the contract boundary
(`z.enum(TAG_COLORS)`); an unknown key is an `invalid_input` error, not a
silent fallback.

Methods:
- `getBoard({ listId: string|null })` -> `{ lists: ListDto[], activeListId: string,
  inProgress: { planned: number, completed: number },
  backlog: { total: number, overdue: number, tasks: TaskDto[] },
  totalOverdue: number, serverNow: number, tags: TagDto[], projects: ProjectDto[] }`
  - `activeListId` falls back to the first list when the argument is null or unknown.
  - **`inProgress` carries no `tasks` array and no `day` field.** The
    Backlog is comprehensive (see below), so every field an In Progress row
    needs — `stage`, `dueAt`, `inProgress`, `projectId`, `parentId`,
    `trail`, `tags` — already sits on every `TaskDto` in `backlog.tasks`.
    The client derives the grouped In Progress view from that single tree
    via the pure `lib/inProgressView.ts` (`selectInProgressView`), rather
    than trusting a second, independently-built server traversal that could
    disagree with the first. This is safe **only** because `backlog.tasks`
    is comprehensive — see the note below and the design doc.
  - `backlog.tasks` are top-level rows only, ordered by `sort_order`, each
    with its `subtasks` nested and ordered — **every open task in the list,
    unconditionally**. There is no stage filter here at all: a task's
    presence in the Backlog never depends on whether it's also in
    In Progress.
  - `backlog.overdue` counts overdue rows across the *whole* list, not just
    a `stage='pending'` subset — overdue-ness is a Backlog fact, surfaced
    there and there alone; it never affects In Progress membership (rule 4).
  - `inProgress.planned` = `inProgress.completed` (see below) plus every
    currently-open row satisfying the In Progress membership predicate
    (rule 7, `stage='in_progress'`); `inProgress.completed` = rows with
    `status='done' AND stage='in_progress'`. Both count top-level rows AND
    subtasks. Because `completeTask` never touches `stage` (rule 5), the
    ring's two halves can never disagree with what's actually in play — no
    special stamping is needed at completion time anymore.
  - `tags` is the full tag catalog with usage counts, so the picker needs no
    extra fetch. `getArchive`'s output is **not** extended with this catalog —
    archived rows carry `TaskDto.tags` like any other row, but the archive
    panel renders no picker, so it needs no catalog.
  - `projects` is every project in the active list, in `sort_order`; each
    `ProjectDto.inProgressCount` uses the same membership predicate as the
    board, so a project's "N in progress" badge always agrees with the
    column.
  - Tag lookups for every row on the board are done with **one** query
    (`loadTagMap` in `lib/db.ts`), never a per-task query — see the N+1 note
    below.

  > **Tripwire.** Deriving In Progress client-side from `backlog.tasks` is
  > correct only while the Backlog stays comprehensive and unpaged. If the
  > Backlog is ever virtualized or lazily paged, In Progress silently goes
  > blind to anything outside the loaded window — see README's Known gaps
  > and `docs/design/2026-09-01-two-blocks.md`.
- `getArchive({ listId: string, limit: number (<=200, default 100), offset: number })`
  -> `{ groups: [{ day: string, tasks: TaskDto[] }], total: number, hasMore: boolean }`
  grouped by the local day of `completed_at`, newest first. Subtasks appear nested
  under their parent when the parent is in the same group, otherwise as their own row.
- `createTask({ listId, stage, title, parentId: string|null, dueAt: number|null,
  hasDueTime: boolean, position: 'top'|'bottom', projectId?: string|null,
  images?: { data: base64 }[] })`
  -> `{ task: TaskDto }`
  - Rejects an empty/whitespace title (`invalid_input`) and a `parentId` that is
    itself a subtask.
  - `projectId` is optional, defaulting to loose (`null`) when omitted — there
    is no prior row to leave "unchanged" for a brand-new task, unlike
    `moveTask`'s `projectId` below.
- `updateTask({ id, title?, notes?, dueAt?, hasDueTime?, addImages?, removeImageIds? })`
  -> `{ task: TaskDto }` (`dueAt: null` clears the due date). Text, removals, and
  additions commit in one transaction; removals run first.
- `moveTask({ id, stage, parentId: string|null, beforeId: string|null,
  afterId: string|null, projectId?: string|null })` -> `{ ok: true }`
  - `beforeId`/`afterId` are the sibling ids the item lands between, in the target
    group. Both null = only item / append.
  - `projectId` is the task's target home; **omitting it leaves the task's
    current project unchanged** — this is what keeps a task's home
    `(project_id, parent_id, sort_order)` untouched by scheduling it into
    In Progress, and what makes unscheduling it snap back to that exact slot
    regardless of where it's dropped. Only a drop directly onto a
    *different* project re-homes a task, by passing that project's id.
  - The `in_progress -> pending` transition additionally clears
    `in_progress_since` back to `NULL` (see rule 9) — the carried-days
    counter resets on park, by design. Entering In Progress
    (`pending -> in_progress`) stamps `in_progress_since` to now, starting
    the clock. There is no dismissal state to stamp or clear anymore: since
    membership is solely `stage`, a `pending` row can never boomerang back
    into In Progress on its own.
  - Making a task a subtask promotes that task's own children to top-level siblings
    placed immediately after it, in their existing order.
  - Rejects a move that would create a cycle or a depth > 1.
  - A subtask's `project_id` always mirrors its (possibly new) parent's,
    enforced in the same transaction.
- `completeTask({ id })` -> `{ completedIds: string[] }`. Never touches
  `stage` — a row that was `stage='in_progress'` when it completed simply
  stays `stage='in_progress'` forever after, which is all rule 5's ring
  needs. No special stamping happens at completion time anymore.
- `setTaskStage({ id, stage: 'pending'|'in_progress' })` -> `{ ok: true }`.
  The one-click stage toggle in both directions (rule 8) — the always-visible
  **Move to In Progress** / **Move to Backlog** affordance on a row.
  Unlike `moveTask`, there is no `beforeId`/`afterId`: there is no drop
  position to honor, only a direct "set the stage" request. Flipping to
  `'in_progress'` stamps `in_progress_since` to now and places the row at
  the top of its home-sibling group. Flipping to `'pending'` clears
  `in_progress_since` back to `NULL` (carried-days resets) and leaves
  `sort_order` untouched. Never cascades to subtasks either direction — a
  subtask's stage is independent of its parent's, exactly like `moveTask`.
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
  the bin, and never touches `parent_id`/`stage`.
- `reorderProjects({ listId, ids: string[] })` -> `{ projects: ProjectDto[] }`.
  Renumbers to `1000, 2000, …`, mirroring `reorderLists`/`reorderTags`.
- `setProjectCollapsed({ id, collapsed: boolean, column: 'backlog'|'in_progress' })`
  -> `{ ok: true }`. Server-side so collapse state survives a reload —
  single-user local plugin, no cost. **Per-column, not shared**: `column`
  says which of `ProjectDto.collapsed` (backlog) / `inProgressCollapsed`
  (in progress) this call writes; the other field is never touched by the
  same call. This matters because the Backlog and In Progress columns
  render the same `ProjectDto` at once — without a discriminator,
  collapsing a project in one column would silently collapse it in the
  other too.

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

Layout: tab strip, then two side-by-side columns — Backlog left, In Progress
right — each independently scrollable, inside a `@container` wrapper that
degrades to a stacked layout (In Progress first) on narrow panels via
Tailwind v4 native container queries, **never** viewport media queries (a
bb nav panel's width is independent of the browser viewport — a maximized
window with a narrow panel must still stack). See the ASCII in
`docs/UX.md`.

### Components (one component per file, under `components/`)
- `TodoPage.tsx` — data fetching (`useRpc`, `useRealtime("board")`), the single
  `DndContext` spanning both columns, keyboard sensor included, and the
  `@container` wrapper around both columns.
- `TabStrip.tsx` — list tabs; double-click to rename inline, `+` to create, context
  menu (dropdown) to delete with an AlertDialog confirm, drag to reorder.
- `Section.tsx` — header (label, count, `ProgressRing`) + droppable body +
  `AddTaskRow`, one per column, rendered only while that column is
  EXPANDED (see `CollapsedRail.tsx` below for the collapsed shape). The
  header ring shows In Progress's `completed/planned` in the primary tone,
  and Backlog's overdue share in the destructive tone; the Backlog's own
  count reads `N pending`. Both columns render the identical shape: one
  `ProjectGroup` per project (a nested `SortableContext` per project, plus
  an outer one over the project ids for header reordering — Backlog only,
  see `ProjectGroup.tsx`), followed by every loose top-level task with no
  group header. `#Name` + Enter in the Backlog's own `AddTaskRow` creates a
  project inline instead of a task. The header's chevron (clicking the
  whole heading) and its own icon button on the far right both fire
  `onCollapse`, wired to `hooks/usePanelCollapse.ts` by `TodoPage.tsx` — see
  "Panel collapse" below; this is orthogonal to `onToggleProjectCollapsed`,
  which collapses one project's rows, not the whole column.
- `CollapsedRail.tsx` — what a column renders instead of `Section` while
  `usePanelCollapse` says it's collapsed. Two shapes in one component,
  driven by the same `@container`/`@3xl` breakpoint `TodoPage.tsx` already
  uses: below `@3xl` (the already-stacked layout) a full-width, one-line
  bar (label, count, expand chevron); at/above `@3xl` (side-by-side) a
  ~40px vertical rail spanning the row's full height, label rotated to
  read top-to-bottom. The whole shape is one `<button>` — click (or
  Enter/Space) anywhere on it to restore the panel.
- `ProjectGroup.tsx` — a project's card: `ProjectHeader` + a droppable body
  (append-to-project / re-home drop target) + a per-project `AddTaskRow`.
  Collapsed renders the header alone; an empty expanded project renders the
  header plus its add-row only in the Backlog. In the In Progress column, an
  empty project group renders nothing at all — In Progress is an ephemeral
  view, so a project with nothing due or scheduled simply doesn't appear
  there, unlike the Backlog where an empty project is a durable,
  always-visible container. In the In Progress column only, when the group
  has any tasks, its body renders one ordered row per entry (`rows`, from
  `lib/inProgressView.ts`) instead of a flat task list — a bare `TaskRow`
  for a qualifying top-level task, or a `ParentGroupHeader` plus its
  indented children for a non-qualifying parent's qualifying subtasks — the
  Backlog's card always renders the original flat list; see
  `ParentGroupHeader.tsx` below.
- `ParentGroupHeader.tsx` — **In Progress only.** The header for one
  parent-grouped slice of a project card (or the loose/Unfiled group): a
  small muted header naming the parent task, followed by that parent's
  qualifying subtasks, rendered as ordinary `TaskRow`s with the `indent`
  prop so they align with a real parent's nested subtasks. Renders for
  exactly the case where a top-level task is not itself `inProgress` but
  has one or more subtasks that are — grouping by the task's own parent
  is the meaningful axis here (it's the plan the task already belongs to),
  not by tag, so tags are never a grouping key anywhere in this view; they
  stay a per-row `TagChips` label. Unlike a tag, a parent task has no
  `TagColor`, so the header has no colour dot; it also has no count chip
  (the reader is already looking straight at the group's members, so a
  count answers no useful question) and no collapse state (out of scope for
  this feature, same as the tag-grouped header it replaced). The parent
  title is a button that scrolls the Backlog to that parent row and flashes
  it. The Backlog column never renders this component — see `ProjectGroup`'s
  `variant` gating.
- `ProjectHeader.tsx` — in the Backlog: collapse chevron, colour badge (opens
  the shared `ColorSwatchPicker`), inline-editable name (double-click, same
  mechanics as `TabStrip`'s tab rename), a `+` that reveals and focuses the
  project's add-row, and a `⋯` menu (Rename / Change colour / Delete, the
  last behind the existing `AlertDialog`). In the In Progress column the
  header is a read-only, non-draggable label: the name and colour badge
  render, and collapse still works, but rename/colour/delete/`+`/reordering
  are Backlog only — one editing surface per concept, and two draggable
  orderings of one `projects.sort_order` would fight each other.
- `TrailLine.tsx` — a row's muted second line, `# Project > Parent`.
  Renders null with no context to show; truncates from the left so the
  nearest ancestor survives; each segment is independently clickable
  (scrolls the Backlog to the source row and flashes it); collapses to the
  project badge alone below `md`. Still exists and still backs `TaskRow`'s
  `showTrail` prop, but neither is exercised anywhere in the In Progress
  render path anymore — a non-qualifying parent's qualifying subtasks are
  grouped under `ParentGroupHeader` instead (see above), which already
  names the parent, so a repeated per-row breadcrumb would be pure
  duplication once the card header already names the project too.
  Archive's use of `TrailLine` is unaffected by any of this.
- `TaskRow.tsx` — grip, always-real checkbox (no ghost swap), title (click to
  edit inline), `ProgressRing` when it has subtasks, a "carried Nd" badge
  (only when `task.carriedDays >= 1`; the old per-row "In Progress marker"
  is gone entirely — a row's presence in a given column is now shown purely
  by which column it's rendered in) — `AgeChip`, `DueChip`, then
  always-visible inline icon actions in this order: a calendar button
  (opens `DueDatePicker` directly, one click), a plus button on top-level
  rows only (reveals the inline add-subtask input directly, focused — not
  shown on subtask rows, since depth is capped at 1), a `⋯` menu holding
  Delete only (behind the existing AlertDialog confirm), and finally the
  one-click stage toggle, **always visible (not hover-revealed)** since it
  is now the primary way to move work between the two blocks: **Move to In
  Progress** (`aria-label`/`title` "Move to In Progress") on a
  Backlog-column row calls `setTaskStage(id, "in_progress")`; **Move to
  Backlog** on an In Progress-column row calls `setTaskStage(id,
  "pending")`. Gated purely on which column this particular rendered
  instance is in (`inProgressColumn`), independent of the drag gesture. No
  keyboard binding is wired for it — see product rule 8. Renders its
  subtasks indented. Right-hand reading order: title -> tag chips -> ring ->
  carried badge -> age -> due -> actions (calendar, tags, add-subtask, menu,
  stage toggle). `TrailLine`/`showTrail` still exist on this component but
  are never exercised in the In Progress column anymore — see
  `ParentGroupHeader.tsx` above. The same task can render at once in both
  columns whenever
  `inProgress` is true, so its dnd-kit sortable id is prefixed
  (`taskDragId`) to stay unique within the single shared `DndContext` —
  this is not ghost machinery, and it's load-bearing for every
  `inProgress` task, not just ones that happen to also be due.
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
  in the `Section` header (In Progress/Backlog progress — this replaced `SectionBar`).
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

### `hooks/usePanelCollapse.ts` + panel collapse (Phase 4)

Per-device collapse for the two board panels (Backlog / In Progress) —
deliberately separate from, and layered above, the existing per-project
collapse (`ProjectDto.collapsed`/`inProgressCollapsed`, server-persisted via
`setProjectCollapsed`): that feature collapses one project's rows inside a
column; this collapses an entire column.

- State is one value, not two independent booleans, so "both collapsed at
  once" is structurally unrepresentable rather than merely disallowed:
  `"both"` (neither collapsed), `"backlog"`, or `"in_progress"`. Collapsing
  one column while the other is already collapsed automatically restores
  the other one, by construction of the encoding.
- Persisted in `localStorage` under `todo.panel.<listId>` — **deliberately
  NOT server-persisted.** Which panel you like out of the way on THIS
  device is view state, not board data: a round trip to the server before
  the UI could reflect it would make the collapse animate late for no
  benefit, and nobody needs the layout in sync across devices or
  collaborators. Read synchronously on first render (a lazy `useState`
  initializer), not corrected in an effect after painting expanded —
  SSR/first-paint safe (falls back to `"both"` with no `window`) and
  crash-safe if storage is unavailable (private browsing, quota errors).
  Switching tabs (lists) re-reads that list's own independent choice.
- `Section.tsx` renders only while its column is expanded; `TodoPage.tsx`
  renders `CollapsedRail.tsx` instead when `usePanelCollapse` says a column
  is collapsed. See `CollapsedRail.tsx` above for its two shapes.

### `lib/inProgressView.ts` (pure, table-tested)

`selectInProgressView(backlogTasks, projects)` derives the whole grouped
In Progress view — project groups (with each card's own orphan subtasks
and parent-grouped rows), the loose/Unfiled group, and its own
parent-grouped rows — from the same tree the Backlog renders. It **never
recomputes membership**: `task.inProgress` is the sole, authoritative
signal (computed server-side by `IN_PROGRESS_MEMBERSHIP_SQL`, i.e.
`stage === 'in_progress'`, full stop — there is no dismissal state left to
depend on). Its correctness depends entirely on `backlogTasks` being
comprehensive — see the `getBoard` tripwire above.

Grouping inside each card is by **parent task**, never by tag — tags are
not a grouping axis anywhere in this view, only a per-row label the render
layer draws from `task.tags`. For each top-level task in `backlogTasks`:
an `inProgress` task becomes a `{ kind: "task" }` row (its own qualifying
subtasks, `task.subtasks.filter(s => s.inProgress)`, are narrowed onto it
for `TaskRow` to nest exactly as the Backlog does); a task that is *not*
`inProgress` but has one or more qualifying subtasks becomes a
`{ kind: "parentGroup" }` row keyed by that parent's id/title, carrying
just those subtasks (there's no parent row here to nest under, since the
parent didn't qualify); a task with neither contributes no row. The two
row kinds interleave in `backlogTasks`' own order — a card's `rows` (or the
Unfiled group's `looseRows`) walks that order once and appends as it goes,
so there is no separate sort key and no hoisting of one kind above the
other. `tasks` / `orphanSubtasks` / `looseTasks` / `looseOrphanSubtasks`
are still derived alongside `rows`/`looseRows` (same partition, just not
yet re-interleaved) purely to back dnd-kit sortable-id registration and the
hide-empty-project-group check — every task in them also appears, in the
same relative order, inside `rows`/`looseRows`.

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
via the toast text. The stage toggle deliberately has no keyboard binding
of its own (product rule 8); its `aria-label` ("Move to In Progress"/"Move to
Backlog") and normal tab stop are what keep it usable without a mouse. The
panel-collapse controls (`Section`'s heading/chevron, `CollapsedRail`) are
real `<button>`s with their own `aria-label`s ("Collapse …"/"Expand …"), so
they need no separate keyboard wiring either.

## Testing (required, not optional)
- `order.test.ts`, `humanize.test.ts`, `day.test.ts` — pure unit tests.
  There is no `rollover.test.ts` anymore — `lib/rollover.ts` is deleted
  along with the concept it tested.
- `server.test.ts` via `createFakePluginHost()` from `@get-bb/plugin-sdk/testing`:
  seeding, create/move/complete/restore/delete, `setTaskStage` in both
  directions, subtask depth enforcement, cycle rejection, In Progress
  counts after completion, archive grouping, clearArchive, list CRUD +
  last-list refusal, realtime publish on mutation.
- `app.test.tsx` via `loadPluginApp` + `renderSlot` from
  `@get-bb/plugin-sdk/testing/app`: board renders sections, add row calls
  `createTask`, checkbox calls `completeTask`, archive dialog calls `getArchive`,
  accessory shows the overdue count, a task row shows an `AgeChip` alongside its
  `DueChip`.
- `components/leaf.test.tsx`: `AgeChip` renders the expected text, exposes the
  absolute date via `title`, and is always muted (never a tone class);
  `ProjectHeader`/`ProjectGroup`/`TrailLine`/`TaskRow`/`ParentGroupHeader`
  rendering and callbacks, presentational and fixture-driven, including the
  `variant` differences between a Backlog and an In Progress
  `ProjectHeader`/`ProjectGroup`; a `describe` block explicitly titled
  "In Progress membership is column-only (ghost rows and the old marker
  are both gone)" covers the carried badge rendering on its own now that
  the marker is gone (and hiding at `carriedDays: 0`), and the stage
  toggle's always-visible presence and label per column.
- `lib/inProgressView.test.ts`: table-driven pure tests of
  `selectInProgressView` against `backlog.tasks` fixtures — manually
  scheduled and loose/nested/orphaned tasks, empty-project suppression, and
  parent-grouping (a qualifying top-level task's own subtasks nest onto
  it; a non-qualifying parent's qualifying subtasks produce a single
  `parentGroup` row keyed by that parent; a parent with no qualifying
  subtasks contributes no row; row order interleaves in `backlogTasks`'
  own order with no hoisting of one kind above the other). There is no
  "dismissed today / reappears tomorrow" case anymore — there is no
  dismissal state left to test.
- `lib/drag.test.ts`: the full drag matrix (backlog<->in progress, reorder, nest,
  project filing/re-homing, project header reorder) as table-driven pure
  tests against `computeTaskMove`/`computeProjectReorder`/`applyMoveToBoard`
  — no DOM, no dnd-kit runtime.
- `components/TodoPage.test.tsx`: end-to-end proof spanning the drag layer
  AND the board's rendering together, through a REAL dnd-kit gesture (the
  same `stubSequentialRects` keyboard-drag technique as the base
  reorder/optimistic tests) — a subtask dragged from its project into In
  Progress keeps its parent, and its non-qualifying parent surfaces a
  `ParentGroupHeader` naming it, with the subtask indented underneath and
  no trail rendered anywhere (the header already names the parent); the
  subtask stays visible, undimmed and fully interactive, in its project;
  dragging it back to the Backlog snaps it home regardless of drop
  position; a task carried several times still renders under its own
  `ParentGroupHeader` regardless of how many times it's been carried; the
  project header's `+` reveals and focuses its add-row (Backlog only); a task
  visible in both columns at once (a live `inProgress` task) can still be
  dragged without a dnd-kit id collision; clicking the stage toggle calls
  `setTaskStage` with the expected direction; a `describe` block titled
  "panel collapse" covers collapsing either column giving the other full
  width, both-collapsed being impossible, and the collapsed rail/bar shapes.
- `npm test` (vitest) must pass with zero failures, and `npx tsc --noEmit` clean.
