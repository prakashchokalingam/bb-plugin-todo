// All SQL lives here. Every exported function takes the db handle as its
// first argument; server.ts only wires these up to RPC methods and handles
// bb-specific concerns (kv, realtime, background scheduling).
import type Database from "better-sqlite3";
import type { ListDto, ProjectDto, TagColor, TagDto, TagRefDto, TaskDto, TrailDto } from "../contract.js";
import { localDay, startOfNextLocalDay } from "./day.js";
import { mintListId, mintProjectId, mintTagId, mintTaskId } from "./ids.js";
import { needsRebalance, nextOrder } from "./order.js";

// Ship exactly these statements, in this order. APPEND-ONLY: never edit or
// reorder a shipped statement, only add new ones at the end.
export const MIGRATIONS: string[] = [
  // 0
  `CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order REAL NOT NULL,
    created_at INTEGER NOT NULL
  );`,
  // 1
  `CREATE TABLE IF NOT EXISTS tasks (
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
  );`,
  // 2
  `CREATE INDEX IF NOT EXISTS tasks_board_idx
    ON tasks (list_id, status, bucket, parent_id, sort_order);`,
  // 3
  `CREATE INDEX IF NOT EXISTS tasks_archive_idx
    ON tasks (list_id, status, completed_at DESC);`,
  // 4
  `CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks (status, due_at);`,
  // 5
  `CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_id);`,
  // 6
  `CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    sort_order REAL NOT NULL,
    created_at INTEGER NOT NULL
  );`,
  // 7
  `CREATE UNIQUE INDEX IF NOT EXISTS tags_name_unique ON tags (name COLLATE NOCASE);`,
  // 8
  `CREATE TABLE IF NOT EXISTS task_tags (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (task_id, tag_id)
  );`,
  // 9
  `CREATE INDEX IF NOT EXISTS task_tags_tag_idx ON task_tags (tag_id);`,
  // 10
  `CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    list_id    TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    collapsed  INTEGER NOT NULL DEFAULT 0,
    sort_order REAL NOT NULL,
    created_at INTEGER NOT NULL
  );`,
  // 11
  `CREATE INDEX IF NOT EXISTS projects_list_idx ON projects (list_id, sort_order);`,
  // 12
  `ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id);`,
  // 13
  `ALTER TABLE tasks ADD COLUMN today_order REAL;`,
  // 14
  `CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (list_id, project_id, sort_order);`,
  // 15 — backfill: every existing Today row keeps its exact current position
  // on first load (today_order starts equal to its prior sort_order).
  `UPDATE tasks SET today_order = sort_order WHERE bucket = 'today';`,
  // 16 — the local day (YYYY-MM-DD) this task was last explicitly removed
  // from the Today view; self-expiring — inert once it is no longer today.
  // Purely additive, no backfill: NULL means "never dismissed", which is
  // already correct for every existing row.
  `ALTER TABLE tasks ADD COLUMN today_dismissed_day TEXT;`,
];

interface ListRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: number;
}

interface TaskRow {
  id: string;
  list_id: string;
  parent_id: string | null;
  title: string;
  notes: string | null;
  bucket: "backlog" | "today";
  day: string | null;
  sort_order: number;
  due_at: number | null;
  has_due_time: number;
  status: "open" | "done";
  completed_at: number | null;
  carried_count: number;
  created_at: number;
  updated_at: number;
  project_id: string | null;
  today_order: number | null;
  today_dismissed_day: string | null;
}

interface ProjectRow {
  id: string;
  list_id: string;
  name: string;
  color: TagColor;
  collapsed: number;
  sort_order: number;
  created_at: number;
}

interface TagRow {
  id: string;
  name: string;
  color: TagColor;
  sort_order: number;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Today membership — the one predicate
//
// "This row belongs to Today" has exactly one definition, expressed twice —
// once as SQL, once as plain TS — so both a query and a client-side
// recomputation can use it without either drifting out of sync with the
// other or with itself over time. Wired into every caller that needs to
// know "is this Today": getBoard's backlog query (via `inToday` on the
// DTO) and planned count, getProjectDtos's todayCount badge, moveTask's
// dismissal stamp, and completeTask's ring-preserving day stamp.
// ---------------------------------------------------------------------------

/**
 * member = (bucket = 'today' AND day = today)                        -- manual
 *        OR (due_at IS NOT NULL AND due_at < startOfTomorrow          -- due today or overdue
 *            AND (today_dismissed_day IS NULL OR today_dismissed_day <> today))
 *
 * Positional `?` placeholders, matching every other query in this file (no
 * named-parameter binding is used anywhere else in db.ts). Bind order —
 * `today` is needed twice (the manual check and the dismissal check share
 * the same value but SQLite has no named-parameter reuse with `?`):
 *   1. today             — YYYY-MM-DD, `localDay(now)`
 *   2. startOfTomorrowMs — epoch ms, exclusive upper bound; always
 *                          `startOfNextLocalDay(now)` (lib/day.ts), never
 *                          UTC/ms-arithmetic
 *   3. today             — YYYY-MM-DD, same value as (1) again
 *
 * Wrapped in its own parens so a caller can safely `AND`/`OR` it into a
 * larger WHERE clause without operator-precedence surprises.
 */
export const TODAY_MEMBERSHIP_SQL = `(
    (bucket = 'today' AND day = ?)
    OR (due_at IS NOT NULL AND due_at < ? AND (today_dismissed_day IS NULL OR today_dismissed_day <> ?))
  )`;

/**
 * Pure TS twin of `TODAY_MEMBERSHIP_SQL`, operating on the raw row shape so
 * tests — and, later, client-side code that only has the wire `TaskDto` —
 * can recompute membership without a database round trip. The two must
 * agree by construction: db.test.ts's drift guard runs both against the
 * same hand-built rows and asserts identical membership sets.
 */
export function isTodayMember(
  row: { bucket: "backlog" | "today"; day: string | null; due_at: number | null; today_dismissed_day: string | null },
  todayStr: string,
  startOfTomorrowMs: number,
): boolean {
  const manual = row.bucket === "today" && row.day === todayStr;
  const auto =
    row.due_at !== null &&
    row.due_at < startOfTomorrowMs &&
    (row.today_dismissed_day === null || row.today_dismissed_day !== todayStr);
  return manual || auto;
}

/** Seeds `Work` (1000) then `Personal` (2000) — only when `lists` is empty. */
export function seed(db: Database.Database, now: Date): void {
  const { c } = db.prepare(`SELECT COUNT(*) AS c FROM lists`).get() as { c: number };
  if (c > 0) return;
  const ts = now.getTime();
  db.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)`).run(
    mintListId(),
    "Work",
    1000,
    ts,
  );
  db.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)`).run(
    mintListId(),
    "Personal",
    2000,
    ts,
  );
}

// ---------------------------------------------------------------------------
// Row -> DTO helpers
// ---------------------------------------------------------------------------

function taskRowToDto(
  row: TaskRow,
  subtasks: TaskDto[],
  counts: { total: number; done: number },
  tags: TagRefDto[],
  trail: TrailDto | null,
  inToday: boolean,
): TaskDto {
  return {
    id: row.id,
    listId: row.list_id,
    parentId: row.parent_id,
    title: row.title,
    notes: row.notes,
    bucket: row.bucket,
    day: row.day,
    sortOrder: row.sort_order,
    dueAt: row.due_at,
    hasDueTime: !!row.has_due_time,
    status: row.status,
    completedAt: row.completed_at,
    carriedCount: row.carried_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subtasks,
    subtaskCounts: counts,
    tags,
    projectId: row.project_id,
    trail,
    inToday,
  };
}

// ---------------------------------------------------------------------------
// Tags — read helpers
// ---------------------------------------------------------------------------

type TagMap = Map<string, TagRefDto[]>;

/**
 * One query. Every task's tags, ordered by tag sort_order. Call this once
 * per `getBoard`/`getArchive` invocation and thread the result down —
 * looking up tags per-task inside `taskRowToDto` would be an N+1 query.
 */
function loadTagMap(db: Database.Database): TagMap {
  const rows = db
    .prepare(
      `SELECT tt.task_id AS task_id, t.id AS id, t.name AS name, t.color AS color
       FROM task_tags tt
       JOIN tags t ON t.id = tt.tag_id
       ORDER BY t.sort_order`,
    )
    .all() as { task_id: string; id: string; name: string; color: TagColor }[];
  const map: TagMap = new Map();
  for (const r of rows) {
    const ref: TagRefDto = { id: r.id, name: r.name, color: r.color };
    const list = map.get(r.task_id);
    if (list) list.push(ref);
    else map.set(r.task_id, [ref]);
  }
  return map;
}

/** Targeted lookup for single-DTO returns (createTask/updateTask/setTaskTags)
 * where a whole-board `loadTagMap` would be overkill. */
function getTaskTags(db: Database.Database, taskId: string): TagRefDto[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.name AS name, t.color AS color
       FROM task_tags tt
       JOIN tags t ON t.id = tt.tag_id
       WHERE tt.task_id = ?
       ORDER BY t.sort_order`,
    )
    .all(taskId) as { id: string; name: string; color: TagColor }[];
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color }));
}

function getTaskRow(db: Database.Database, id: string): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
}

function getProjectRow(db: Database.Database, id: string): ProjectRow | undefined {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
}

type ProjectMap = Map<string, ProjectRow>;

/** One query for every project in `listId`, keyed by id — same rationale as
 * `loadTagMap`: call once per `getBoard`/`getArchive` and thread the result
 * down instead of a per-task lookup. */
function loadProjectMap(db: Database.Database, listId: string): ProjectMap {
  const rows = db.prepare(`SELECT * FROM projects WHERE list_id = ?`).all(listId) as ProjectRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * The trail is `null` for a loose top-level task (no project, no parent) —
 * those rows render exactly as they do today. Otherwise it carries the
 * project's name/color and, for a subtask, the parent's title, so the
 * client never has to look either up. `projectMap` is the whole-board batch
 * (getBoard/getArchive); omit it for the single-DTO mutation return paths,
 * which fall back to a targeted `getProjectRow` lookup — same split as
 * `tagMap` vs `getTaskTags`.
 */
function buildTrail(db: Database.Database, row: TaskRow, projectMap?: ProjectMap): TrailDto | null {
  if (!row.project_id && !row.parent_id) return null;
  const project = row.project_id
    ? (projectMap ? projectMap.get(row.project_id) : getProjectRow(db, row.project_id))
    : undefined;
  const parent = row.parent_id ? getTaskRow(db, row.parent_id) : undefined;
  return {
    projectId: row.project_id,
    projectName: project ? project.name : null,
    projectColor: project ? project.color : null,
    parentId: row.parent_id,
    parentTitle: parent ? parent.title : null,
  };
}

function getChildrenRows(db: Database.Database, parentId: string): TaskRow[] {
  return db
    .prepare(`SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order`)
    .all(parentId) as TaskRow[];
}

/**
 * `sort_order`'s scope: a task's "home" — its position within its project
 * (or the loose group, when `projectId` is null) under its parent. This is
 * independent of `bucket`: a scheduled row (flagged today, still filed)
 * keeps its home slot exactly where it was, so unscheduling it later can
 * snap it back there (see `moveTask`'s snap-home rule).
 */
function getHomeSiblingRows(
  db: Database.Database,
  listId: string,
  projectId: string | null,
  parentId: string | null,
): TaskRow[] {
  if (parentId !== null) {
    return db
      .prepare(`SELECT * FROM tasks WHERE list_id = ? AND parent_id = ? AND status = 'open' ORDER BY sort_order`)
      .all(listId, parentId) as TaskRow[];
  }
  if (projectId === null) {
    return db
      .prepare(
        `SELECT * FROM tasks WHERE list_id = ? AND parent_id IS NULL AND project_id IS NULL AND status = 'open' ORDER BY sort_order`,
      )
      .all(listId) as TaskRow[];
  }
  return db
    .prepare(
      `SELECT * FROM tasks WHERE list_id = ? AND parent_id IS NULL AND project_id = ? AND status = 'open' ORDER BY sort_order`,
    )
    .all(listId, projectId) as TaskRow[];
}

/**
 * The only code path allowed to write `sort_order` (risk mitigation from
 * the design doc, made structurally true — see the regression test in
 * db.test.ts that greps this file for stray writes). `today_order` is
 * abandoned, not dropped (Phase 2 of the today-as-view plan): the column
 * stays in the schema as a rollback escape hatch, but nothing in this file
 * writes it anymore — Today now inherits `sort_order`, the same single
 * order column the Backlog always used.
 */
function writeOrder(db: Database.Database, id: string, column: "sort_order", value: number | null, now: Date): void {
  db.prepare(`UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`).run(value, now.getTime(), id);
}

function rebalanceHomeSiblingGroup(
  db: Database.Database,
  listId: string,
  projectId: string | null,
  parentId: string | null,
  now: Date,
): void {
  const siblings = getHomeSiblingRows(db, listId, projectId, parentId);
  siblings.forEach((s, i) => writeOrder(db, s.id, "sort_order", (i + 1) * 1000, now));
}

/** Builds a top-level TaskDto with its open subtasks nested and full counts.
 * `tagMap`/`projectMap` are `undefined` for the single-DTO mutation return
 * paths, which use targeted lookups instead of a whole-board map.
 * `today`/`startOfTomorrowMs` feed `isTodayMember` for `inToday` on both the
 * row and every nested subtask — each row's own membership, not the
 * parent's. */
function buildTopLevelDto(
  db: Database.Database,
  row: TaskRow,
  today: string,
  startOfTomorrowMs: number,
  tagMap?: TagMap,
  projectMap?: ProjectMap,
): TaskDto {
  const children = getChildrenRows(db, row.id);
  const done = children.filter((c) => c.status === "done").length;
  const tagsFor = (id: string) => (tagMap ? (tagMap.get(id) ?? []) : getTaskTags(db, id));
  const subtasks = children
    .filter((c) => c.status === "open")
    .map((c) =>
      taskRowToDto(
        c,
        [],
        { total: 0, done: 0 },
        tagsFor(c.id),
        buildTrail(db, c, projectMap),
        isTodayMember(c, today, startOfTomorrowMs),
      ),
    );
  return taskRowToDto(
    row,
    subtasks,
    { total: children.length, done },
    tagsFor(row.id),
    buildTrail(db, row, projectMap),
    isTodayMember(row, today, startOfTomorrowMs),
  );
}

/**
 * Overdue = open, has a due date in the past. `bucket` narrows to one
 * section; omit it to count across the whole list (used for ListDto and the
 * cross-list total).
 */
function countOverdue(
  db: Database.Database,
  listId: string,
  bucket: "backlog" | "today" | null,
  now: Date,
): number {
  const ts = now.getTime();
  if (bucket) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks WHERE list_id = ? AND bucket = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < ?`,
      )
      .get(listId, bucket, ts) as { c: number };
    return row.c;
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM tasks WHERE list_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < ?`,
    )
    .get(listId, ts) as { c: number };
  return row.c;
}

function getListDtos(db: Database.Database, now: Date): ListDto[] {
  const rows = db.prepare(`SELECT * FROM lists ORDER BY sort_order`).all() as ListRow[];
  return rows.map((l) => {
    const openCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE list_id = ? AND status = 'open'`).get(l.id) as {
        c: number;
      }
    ).c;
    const overdueCount = countOverdue(db, l.id, null, now);
    return { id: l.id, name: l.name, sortOrder: l.sort_order, openCount, overdueCount };
  });
}

// ---------------------------------------------------------------------------
// Projects — read helpers
// ---------------------------------------------------------------------------

function projectRowToDto(row: ProjectRow, counts: { open: number; today: number; overdue: number }): ProjectDto {
  return {
    id: row.id,
    listId: row.list_id,
    name: row.name,
    color: row.color,
    sortOrder: row.sort_order,
    collapsed: !!row.collapsed,
    openCount: counts.open,
    todayCount: counts.today,
    overdueCount: counts.overdue,
  };
}

/** Counts (open/today/overdue) span every task filed to the project,
 * top-level and subtasks alike — same convention as ListDto.openCount. */
function getProjectDtos(db: Database.Database, listId: string, now: Date): ProjectDto[] {
  const today = localDay(now);
  const startOfTomorrowMs = startOfNextLocalDay(now);
  const ts = now.getTime();
  const rows = db
    .prepare(`SELECT * FROM projects WHERE list_id = ? ORDER BY sort_order`)
    .all(listId) as ProjectRow[];
  return rows.map((p) => {
    const open = (
      db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND status = 'open'`).get(p.id) as {
        c: number;
      }
    ).c;
    // The same union getBoard uses (manually scheduled OR due today/
    // overdue and undismissed) — so a project's "N today" badge picks up
    // an auto-included task too, not just one someone dragged in.
    const todayCount = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND status = 'open' AND ${TODAY_MEMBERSHIP_SQL}`)
        .get(p.id, today, startOfTomorrowMs, today) as { c: number }
    ).c;
    const overdue = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < ?`,
        )
        .get(p.id, ts) as { c: number }
    ).c;
    return projectRowToDto(p, { open, today: todayCount, overdue });
  });
}

// ---------------------------------------------------------------------------
// Board / archive reads
// ---------------------------------------------------------------------------

export interface BoardResult {
  lists: ListDto[];
  activeListId: string;
  today: { day: string; planned: number; completed: number };
  backlog: { total: number; overdue: number; tasks: TaskDto[] };
  totalOverdue: number;
  serverNow: number;
  tags: TagDto[];
  projects: ProjectDto[];
}

export function getBoard(db: Database.Database, listId: string | null, now: Date): BoardResult {
  const lists = getListDtos(db, now);
  const activeListId = listId && lists.some((l) => l.id === listId) ? listId : lists[0].id;
  const today = localDay(now);
  const startOfTomorrowMs = startOfNextLocalDay(now);
  const tagMap = loadTagMap(db);
  const projectMap = loadProjectMap(db, activeListId);

  // The Backlog is now the complete, always-true list of every open
  // top-level task — no bucket filter, no ghost-manufacturing clause.
  // `inToday` (computed per-row inside buildTopLevelDto via the shared
  // `isTodayMember` predicate) is what flags which of these rows also
  // belong to the Today view; nothing is excluded from the Backlog itself
  // anymore. This is also why `today.tasks` no longer exists on the wire —
  // everything a Today row needs is already here, once per task, so the
  // client derives its own grouped Today view from this single tree.
  const topBacklog = db
    .prepare(`SELECT * FROM tasks WHERE list_id = ? AND parent_id IS NULL AND status = 'open' ORDER BY sort_order`)
    .all(activeListId) as TaskRow[];
  const backlogTasks = topBacklog.map((r) =>
    buildTopLevelDto(db, r, today, startOfTomorrowMs, tagMap, projectMap),
  );
  const backlogTotal = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE list_id = ? AND parent_id IS NULL AND status = 'open'`)
      .get(activeListId) as { c: number }
  ).c;

  // today.completed counts rows historically stamped `day = today` at the
  // moment they were completed (see completeTask) — that stamp is what
  // keeps a vanished row counted even though it no longer satisfies
  // TODAY_MEMBERSHIP_SQL (done rows aren't `status = 'open'`, so they'd
  // never match it anyway). today.planned adds every currently-open row
  // that *does* satisfy the predicate, so the two halves of the ring can
  // never disagree with what's actually in play right now.
  const completed = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE list_id = ? AND day = ? AND status = 'done'`)
      .get(activeListId, today) as { c: number }
  ).c;
  const openToday = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE list_id = ? AND status = 'open' AND ${TODAY_MEMBERSHIP_SQL}`)
      .get(activeListId, today, startOfTomorrowMs, today) as { c: number }
  ).c;
  const planned = completed + openToday;

  const backlogOverdue = countOverdue(db, activeListId, null, now);
  const totalOverdue = lists.reduce((sum, l) => sum + l.overdueCount, 0);

  return {
    lists,
    activeListId,
    today: { day: today, planned, completed },
    backlog: { total: backlogTotal, overdue: backlogOverdue, tasks: backlogTasks },
    totalOverdue,
    serverNow: now.getTime(),
    tags: getTagDtos(db),
    projects: getProjectDtos(db, activeListId, now),
  };
}

export interface ArchiveResult {
  groups: { day: string; tasks: TaskDto[] }[];
  total: number;
  hasMore: boolean;
}

export function getArchive(
  db: Database.Database,
  listId: string,
  limit: number,
  offset: number,
  now: Date,
): ArchiveResult {
  // `inToday` is part of every TaskDto now (the contract's `.strict()`
  // schema requires it), so an archived row needs one too — computed with
  // the same shared predicate as everywhere else, even though it's largely
  // incidental here (Today's own selection logic never reads from the
  // archive). `getArchive`'s nesting and `buildTrail` are otherwise
  // untouched: unlike the Backlog, an archived subtask's parent may not be
  // on the current page, so this traversal still has to build its own tree
  // rather than delegate to a single comprehensive list.
  const today = localDay(now);
  const startOfTomorrowMs = startOfNextLocalDay(now);
  const tagMap = loadTagMap(db);
  const projectMap = loadProjectMap(db, listId);
  const doneRows = db
    .prepare(`SELECT * FROM tasks WHERE list_id = ? AND status = 'done' ORDER BY completed_at DESC`)
    .all(listId) as TaskRow[];
  const byId = new Map(doneRows.map((r) => [r.id, r]));
  const dayOf = (r: TaskRow) => localDay(new Date(r.completed_at as number));

  // An entry gets its own row unless it's a subtask nested under a parent
  // that's in the same archive day-group (done, same local day).
  const entries = doneRows.filter((r) => {
    if (!r.parent_id) return true;
    const parent = byId.get(r.parent_id);
    return !(parent && parent.status === "done" && dayOf(parent) === dayOf(r));
  });

  const total = entries.length;
  const page = entries.slice(offset, offset + limit);
  const hasMore = offset + limit < total;

  const dtoFor = (r: TaskRow, tagMap: TagMap): TaskDto => {
    if (r.parent_id) {
      return taskRowToDto(
        r,
        [],
        { total: 0, done: 0 },
        tagMap.get(r.id) ?? [],
        buildTrail(db, r, projectMap),
        isTodayMember(r, today, startOfTomorrowMs),
      );
    }
    const children = getChildrenRows(db, r.id);
    const done = children.filter((c) => c.status === "done").length;
    const nested = children
      .filter((c) => c.status === "done" && dayOf(c) === dayOf(r))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) =>
        taskRowToDto(
          c,
          [],
          { total: 0, done: 0 },
          tagMap.get(c.id) ?? [],
          buildTrail(db, c, projectMap),
          isTodayMember(c, today, startOfTomorrowMs),
        ),
      );
    return taskRowToDto(
      r,
      nested,
      { total: children.length, done },
      tagMap.get(r.id) ?? [],
      buildTrail(db, r, projectMap),
      isTodayMember(r, today, startOfTomorrowMs),
    );
  };

  const groups: { day: string; tasks: TaskDto[] }[] = [];
  for (const r of page) {
    const day = dayOf(r);
    const dto = dtoFor(r, tagMap);
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.tasks.push(dto);
    } else {
      groups.push({ day, tasks: [dto] });
    }
  }

  return { groups, total, hasMore };
}

// ---------------------------------------------------------------------------
// Task mutations
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  listId: string;
  bucket: "backlog" | "today";
  title: string;
  parentId: string | null;
  dueAt: number | null;
  hasDueTime: boolean;
  position: "top" | "bottom";
  /** Omitted or `null` = loose. Ignored (mirrors the parent's) for a subtask. */
  projectId?: string | null;
}

export function createTask(db: Database.Database, input: CreateTaskInput, now: Date): TaskDto {
  return db.transaction(() => {
    const title = input.title.trim();
    if (!title) throw new Error("invalid_input: title must not be empty");

    let parentRow: TaskRow | null = null;
    if (input.parentId) {
      const p = getTaskRow(db, input.parentId);
      if (!p) throw new Error("invalid_input: parent not found");
      if (p.parent_id) throw new Error("invalid_input: cannot nest a subtask under a subtask");
      parentRow = p;
    }

    const listId = parentRow ? parentRow.list_id : input.listId;
    const bucket = parentRow ? parentRow.bucket : input.bucket;
    const day = parentRow ? parentRow.day : bucket === "today" ? localDay(now) : null;
    const parentId = parentRow ? parentRow.id : null;

    // Invariant 2: a subtask's project_id always mirrors its parent's,
    // enforced here rather than left to the caller.
    let projectId: string | null;
    if (parentRow) {
      projectId = parentRow.project_id;
    } else {
      projectId = input.projectId ?? null;
      if (projectId) {
        const project = getProjectRow(db, projectId);
        if (!project) throw new Error("invalid_input: project not found");
        if (project.list_id !== listId) throw new Error("invalid_input: project belongs to a different list");
      }
    }

    const homeSiblings = getHomeSiblingRows(db, listId, projectId, parentId);
    const homeOrder =
      input.position === "top"
        ? nextOrder(null, homeSiblings[0]?.sort_order ?? null)
        : nextOrder(homeSiblings[homeSiblings.length - 1]?.sort_order ?? null, null);

    const id = mintTaskId();
    const ts = now.getTime();
    db.prepare(
      `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, 'open', NULL, 0, ?, ?, ?)`,
    ).run(id, listId, parentId, title, bucket, day, input.dueAt, input.hasDueTime ? 1 : 0, projectId, ts, ts);

    writeOrder(db, id, "sort_order", homeOrder, now);

    return buildTopLevelDto(db, getTaskRow(db, id) as TaskRow, localDay(now), startOfNextLocalDay(now));
  })();
}

export interface UpdateTaskInput {
  id: string;
  title?: string;
  notes?: string | null;
  dueAt?: number | null;
  hasDueTime?: boolean;
}

export function updateTask(db: Database.Database, input: UpdateTaskInput, now: Date): TaskDto {
  return db.transaction(() => {
    const row = getTaskRow(db, input.id);
    if (!row) throw new Error("not_found: task not found");

    let title = row.title;
    if (input.title !== undefined) {
      title = input.title.trim();
      if (!title) throw new Error("invalid_input: title must not be empty");
    }
    const notes = input.notes !== undefined ? input.notes : row.notes;
    const dueAt = input.dueAt !== undefined ? input.dueAt : row.due_at;
    const hasDueTime = input.hasDueTime !== undefined ? input.hasDueTime : !!row.has_due_time;

    const ts = now.getTime();
    db.prepare(
      `UPDATE tasks SET title = ?, notes = ?, due_at = ?, has_due_time = ?, updated_at = ? WHERE id = ?`,
    ).run(title, notes, dueAt, hasDueTime ? 1 : 0, ts, input.id);

    const updated = getTaskRow(db, input.id) as TaskRow;
    const today = localDay(now);
    const startOfTomorrowMs = startOfNextLocalDay(now);
    return updated.parent_id
      ? taskRowToDto(
          updated,
          [],
          { total: 0, done: 0 },
          getTaskTags(db, updated.id),
          buildTrail(db, updated),
          isTodayMember(updated, today, startOfTomorrowMs),
        )
      : buildTopLevelDto(db, updated, today, startOfTomorrowMs);
  })();
}

export interface MoveTaskInput {
  id: string;
  bucket: "backlog" | "today";
  parentId: string | null;
  beforeId: string | null;
  afterId: string | null;
  /** Target home. Omitted = unchanged (drives snap-home below). Ignored
   * when `parentId` names a parent — a subtask always mirrors it instead. */
  projectId?: string | null;
}

/** Returns the id of the list the moved task belongs to (for realtime). */
export function moveTask(db: Database.Database, input: MoveTaskInput, now: Date): { listId: string } {
  return db.transaction(() => {
    const row = getTaskRow(db, input.id);
    if (!row) throw new Error("not_found: task not found");
    // Captured before any write below — this is `row`'s home slot as it
    // was on entry, independent of whatever this move does to it. Needed
    // for the promoted-children gap (placed right after row's *old* spot)
    // since row's own sort_order may or may not change in this same call.
    const oldSortOrder = row.sort_order;
    const oldProjectId = row.project_id;

    let parentRow: TaskRow | null = null;
    if (input.parentId) {
      if (input.parentId === row.id) throw new Error("invalid_input: a task cannot be its own parent");
      const p = getTaskRow(db, input.parentId);
      if (!p) throw new Error("invalid_input: parent not found");
      if (p.parent_id === row.id) throw new Error("invalid_input: move would create a cycle");
      if (p.parent_id) throw new Error("invalid_input: subtask depth cannot exceed one level");
      parentRow = p;
    }

    const listId = row.list_id;
    const newBucket = input.bucket;
    const newDay = newBucket === "today" ? localDay(now) : null;
    const newParentId = parentRow ? parentRow.id : null;

    // Invariant 2: a subtask's project_id always mirrors its parent's,
    // enforced here — a caller-supplied projectId is ignored once parentId
    // names a parent. Invariant 3: a task's project must belong to its list.
    let newProjectId: string | null;
    if (parentRow) {
      newProjectId = parentRow.project_id;
    } else if (input.projectId !== undefined) {
      newProjectId = input.projectId;
      if (newProjectId) {
        const project = getProjectRow(db, newProjectId);
        if (!project) throw new Error("invalid_input: project not found");
        if (project.list_id !== listId) throw new Error("invalid_input: project belongs to a different list");
      }
    } else {
      newProjectId = row.project_id;
    }

    // Making `row` a subtask promotes its own children to top-level
    // siblings placed immediately after row's old spot, in their existing
    // order — unrelated to Today: their own bucket/day/today_order are
    // left exactly as they were (invariant 4).
    const promoted = newParentId ? getChildrenRows(db, row.id) : [];

    const wasToday = row.bucket === "today";
    const enteringToday = newBucket === "today";
    // Snap-home: dropping a Today row into the Backlog "anywhere" does not
    // reposition it — it returns to the home slot it never actually left.
    // Only a drop that explicitly names a *different* project re-homes it.
    const reHome =
      wasToday && !enteringToday && input.projectId !== undefined && input.projectId !== row.project_id;
    const snapHome = wasToday && !enteringToday && !reHome;

    // Today membership is a flag on the row, not a separate place —
    // `today_dismissed_day` is the one thing a bare `bucket` flip can't
    // express: an explicit "take this out of Today" for a row that is (or
    // remains) auto-included by its own due date. Stamped the instant a row
    // leaves Today for the Backlog — this is what stops a manually
    // scheduled *and* overdue task from boomeranging straight back in via
    // TODAY_MEMBERSHIP_SQL the moment its `bucket` flips away from 'today'.
    // Unconditional and harmless when the row has no due date at all.
    // Cleared the instant a row (re-)enters Today: a prior dismissal from
    // some earlier day is stale the moment the row is deliberately
    // scheduled again.
    const nextDismissedDay = enteringToday ? null : wasToday ? localDay(now) : row.today_dismissed_day;

    const ts = now.getTime();
    db.prepare(
      `UPDATE tasks SET bucket = ?, day = ?, parent_id = ?, project_id = ?, today_dismissed_day = ?, updated_at = ? WHERE id = ?`,
    ).run(newBucket, newDay, newParentId, newProjectId, nextDismissedDay, ts, row.id);

    // If row remains (or becomes) a top-level parent and its project
    // changed, its still-remaining children move with it (invariant 2).
    // Promoted ex-children are handled separately below and are exempt —
    // they're no longer row's children after this move.
    if (!newParentId && newProjectId !== oldProjectId) {
      db.prepare(`UPDATE tasks SET project_id = ? WHERE parent_id = ?`).run(newProjectId, row.id);
    }

    // Today now inherits `sort_order` — there is exactly one order column,
    // shared by both views, so entering/leaving/reordering within Today all
    // go through the same home-sibling ordering below. `homeUnchanged`
    // generalizes what used to be implicit: entering Today never touched
    // `sort_order` (Today had its own column), so a drop that names neither
    // a new position nor a new home must still leave the row exactly where
    // it was — "a task's home never changes on schedule/unschedule" holds
    // in both directions now, not just the snap-home one. `snapHome` stays
    // the stronger, direction-specific rule for leaving Today: it ignores
    // an explicit beforeId/afterId too, and takes precedence here.
    const homeUnchanged =
      !snapHome &&
      input.beforeId === null &&
      input.afterId === null &&
      newProjectId === row.project_id &&
      newParentId === row.parent_id;

    if (!snapHome && !homeUnchanged) {
      const homeSiblings = getHomeSiblingRows(db, listId, newProjectId, newParentId).filter(
        (s) => s.id !== row.id,
      );
      const beforeRow = input.beforeId ? homeSiblings.find((s) => s.id === input.beforeId) : undefined;
      const afterRow = input.afterId ? homeSiblings.find((s) => s.id === input.afterId) : undefined;
      let prevOrder = afterRow ? afterRow.sort_order : null;
      let nextOrderVal = beforeRow ? beforeRow.sort_order : null;

      if (prevOrder === null && nextOrderVal === null) {
        prevOrder = homeSiblings[homeSiblings.length - 1]?.sort_order ?? null;
        nextOrderVal = null;
      } else if (needsRebalance(prevOrder, nextOrderVal)) {
        rebalanceHomeSiblingGroup(db, listId, newProjectId, newParentId, now);
        const refreshed = getHomeSiblingRows(db, listId, newProjectId, newParentId).filter(
          (s) => s.id !== row.id,
        );
        const br = input.beforeId ? refreshed.find((s) => s.id === input.beforeId) : undefined;
        const ar = input.afterId ? refreshed.find((s) => s.id === input.afterId) : undefined;
        prevOrder = ar ? ar.sort_order : null;
        nextOrderVal = br ? br.sort_order : null;
      }
      writeOrder(db, row.id, "sort_order", nextOrder(prevOrder, nextOrderVal), now);
    }
    // snapHome / homeUnchanged: sort_order is left exactly as it was — no
    // write at all.

    if (promoted.length > 0) {
      const topSiblings = getHomeSiblingRows(db, listId, oldProjectId, null).filter(
        (s) => s.id !== row.id && !promoted.some((p) => p.id === s.id),
      );
      const following = topSiblings
        .filter((s) => s.sort_order > oldSortOrder)
        .sort((a, b) => a.sort_order - b.sort_order)[0];
      const gapEnd = following ? following.sort_order : oldSortOrder + 1000 * (promoted.length + 1);
      const step = (gapEnd - oldSortOrder) / (promoted.length + 1);
      promoted
        .sort((a, b) => a.sort_order - b.sort_order)
        .forEach((p, i) => {
          db.prepare(`UPDATE tasks SET parent_id = NULL, updated_at = ? WHERE id = ?`).run(ts, p.id);
          writeOrder(db, p.id, "sort_order", oldSortOrder + step * (i + 1), now);
        });
    }

    return { listId };
  })();
}

/** Completes `id`; if it's a top-level task, also completes its open
 * subtasks. Returns every id that was actually changed (for undo). */
export function completeTask(
  db: Database.Database,
  id: string,
  now: Date,
): { listId: string; completedIds: string[] } {
  return db.transaction(() => {
    const row = getTaskRow(db, id);
    if (!row) throw new Error("not_found: task not found");

    const today = localDay(now);
    const startOfTomorrowMs = startOfNextLocalDay(now);
    const ts = now.getTime();
    const completedIds: string[] = [];

    // A completed row vanishes from the visible board immediately — but
    // today.planned's ring must still count it if it was a
    // TODAY_MEMBERSHIP_SQL member at the instant it completed. `day` is the
    // only durable record getBoard reads for that (see its `completed`
    // count); a MANUALLY scheduled row already has it stamped, but an
    // AUTO-INCLUDED row (due today/overdue, never `bucket = 'today'`) has
    // never had `day` written at all. Stamp it here, once, at completion —
    // never `bucket`: this is a historical marker, not a reschedule.
    // `isTodayMember` is evaluated against the row's pre-completion
    // columns, so a dismissed-then-completed row is correctly not stamped.
    const completeRow = (r: TaskRow): void => {
      if (isTodayMember(r, today, startOfTomorrowMs) && r.day !== today) {
        db.prepare(
          `UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ?, day = ? WHERE id = ?`,
        ).run(ts, ts, today, r.id);
      } else {
        db.prepare(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`).run(
          ts,
          ts,
          r.id,
        );
      }
      completedIds.push(r.id);
    };

    if (row.status === "open") {
      completeRow(row);
    }

    if (!row.parent_id) {
      const openChildren = getChildrenRows(db, id).filter((c) => c.status === "open");
      for (const child of openChildren) {
        completeRow(child);
      }
    }

    return { listId: row.list_id, completedIds };
  })();
}

/**
 * The counterpart to `moveTask`'s dismissal stamp, for the case it can't
 * express: a task that was never manually scheduled (`bucket = 'backlog'`)
 * but renders in Today purely because it's due today or overdue — there is
 * nothing to move, so this is a single-column stamp. Writes ONLY
 * `today_dismissed_day` (plus `updated_at`); never touches `bucket`, `day`,
 * or any positional column.
 */
export function dismissFromToday(db: Database.Database, id: string, now: Date): { listId: string } {
  return db.transaction(() => {
    const row = getTaskRow(db, id);
    if (!row) throw new Error("not_found: task not found");
    db.prepare(`UPDATE tasks SET today_dismissed_day = ?, updated_at = ? WHERE id = ?`).run(
      localDay(now),
      now.getTime(),
      id,
    );
    return { listId: row.list_id };
  })();
}

/** Undo/restore: sets rows back to `open` and clears `completed_at`.
 * Preserves each row's existing sort_order. */
export function restoreTasks(db: Database.Database, ids: string[], now: Date): { listIds: string[] } {
  return db.transaction(() => {
    const ts = now.getTime();
    const listIds = new Set<string>();
    for (const id of ids) {
      const row = getTaskRow(db, id);
      if (!row) continue;
      db.prepare(`UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = ? WHERE id = ?`).run(
        ts,
        id,
      );
      listIds.add(row.list_id);
    }
    return { listIds: [...listIds] };
  })();
}

export function deleteTask(db: Database.Database, id: string): { listId: string } {
  return db.transaction(() => {
    const row = getTaskRow(db, id);
    if (!row) throw new Error("not_found: task not found");
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
    return { listId: row.list_id };
  })();
}

// ---------------------------------------------------------------------------
// List mutations
// ---------------------------------------------------------------------------

export function createList(db: Database.Database, name: string, now: Date): ListDto {
  return db.transaction(() => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("invalid_input: name must not be empty");
    const { m } = db.prepare(`SELECT MAX(sort_order) AS m FROM lists`).get() as { m: number | null };
    const sortOrder = (m ?? 0) + 1000;
    const id = mintListId();
    db.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)`).run(
      id,
      trimmed,
      sortOrder,
      now.getTime(),
    );
    return { id, name: trimmed, sortOrder, openCount: 0, overdueCount: 0 };
  })();
}

export function renameList(db: Database.Database, id: string, name: string, now: Date): ListDto[] {
  return db.transaction(() => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("invalid_input: name must not be empty");
    const row = db.prepare(`SELECT * FROM lists WHERE id = ?`).get(id);
    if (!row) throw new Error("not_found: list not found");
    db.prepare(`UPDATE lists SET name = ? WHERE id = ?`).run(trimmed, id);
    return getListDtos(db, now);
  })();
}

export function deleteList(db: Database.Database, id: string, now: Date): ListDto[] {
  return db.transaction(() => {
    const { c } = db.prepare(`SELECT COUNT(*) AS c FROM lists`).get() as { c: number };
    if (c <= 1) throw new Error("invalid_input: cannot delete the last remaining list");
    const row = db.prepare(`SELECT * FROM lists WHERE id = ?`).get(id);
    if (!row) throw new Error("not_found: list not found");
    db.prepare(`DELETE FROM lists WHERE id = ?`).run(id);
    return getListDtos(db, now);
  })();
}

export function reorderLists(db: Database.Database, ids: string[], now: Date): ListDto[] {
  return db.transaction(() => {
    ids.forEach((id, i) => {
      db.prepare(`UPDATE lists SET sort_order = ? WHERE id = ?`).run((i + 1) * 1000, id);
    });
    return getListDtos(db, now);
  })();
}

export function clearArchive(db: Database.Database, listId: string): number {
  const info = db.prepare(`DELETE FROM tasks WHERE list_id = ? AND status = 'done'`).run(listId);
  return info.changes;
}

// ---------------------------------------------------------------------------
// Project mutations
// ---------------------------------------------------------------------------

export function listProjects(db: Database.Database, listId: string, now: Date): ProjectDto[] {
  return getProjectDtos(db, listId, now);
}

export function createProject(
  db: Database.Database,
  input: { listId: string; name: string; color: TagColor },
  now: Date,
): ProjectDto {
  return db.transaction(() => {
    const name = input.name.trim();
    if (!name) throw new Error("invalid_input: name must not be empty");
    const { m } = db
      .prepare(`SELECT MAX(sort_order) AS m FROM projects WHERE list_id = ?`)
      .get(input.listId) as { m: number | null };
    const sortOrder = (m ?? 0) + 1000;
    const id = mintProjectId();
    db.prepare(
      `INSERT INTO projects (id, list_id, name, color, collapsed, sort_order, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, input.listId, name, input.color, sortOrder, now.getTime());
    return projectRowToDto(getProjectRow(db, id) as ProjectRow, { open: 0, today: 0, overdue: 0 });
  })();
}

export function updateProject(
  db: Database.Database,
  input: { id: string; name?: string; color?: TagColor },
  now: Date,
): ProjectDto {
  return db.transaction(() => {
    const row = getProjectRow(db, input.id);
    if (!row) throw new Error("not_found: project not found");

    let name = row.name;
    if (input.name !== undefined) {
      name = input.name.trim();
      if (!name) throw new Error("invalid_input: name must not be empty");
    }
    const color = input.color ?? row.color;

    db.prepare(`UPDATE projects SET name = ?, color = ? WHERE id = ?`).run(name, color, row.id);
    const counts = getProjectDtos(db, row.list_id, now).find((p) => p.id === row.id);
    return projectRowToDto(
      { ...row, name, color },
      { open: counts?.openCount ?? 0, today: counts?.todayCount ?? 0, overdue: counts?.overdueCount ?? 0 },
    );
  })();
}

/**
 * Deletes the project and releases its tasks to loose (`project_id =
 * NULL`), never into the bin (invariant 6). This UPDATE is explicit and
 * runs *before* the DELETE rather than relying on the FK's `ON DELETE
 * SET NULL` (there isn't one — see migration 12) — `PRAGMA foreign_keys`
 * is ON in this codebase (server.ts turns it on explicitly; db.test.ts's
 * `freshDb()` does too), so cascades *would* fire here, but the design
 * doc's mitigation is to not depend on that, and this function doesn't.
 */
export function deleteProject(db: Database.Database, id: string): { listId: string } {
  return db.transaction(() => {
    const row = getProjectRow(db, id);
    if (!row) throw new Error("not_found: project not found");
    db.prepare(`UPDATE tasks SET project_id = NULL WHERE project_id = ?`).run(id);
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    return { listId: row.list_id };
  })();
}

export function reorderProjects(db: Database.Database, listId: string, ids: string[], now: Date): ProjectDto[] {
  return db.transaction(() => {
    ids.forEach((id, i) => {
      db.prepare(`UPDATE projects SET sort_order = ? WHERE id = ? AND list_id = ?`).run(
        (i + 1) * 1000,
        id,
        listId,
      );
    });
    return getProjectDtos(db, listId, now);
  })();
}

export function setProjectCollapsed(db: Database.Database, id: string, collapsed: boolean): { listId: string } {
  return db.transaction(() => {
    const row = getProjectRow(db, id);
    if (!row) throw new Error("not_found: project not found");
    db.prepare(`UPDATE projects SET collapsed = ? WHERE id = ?`).run(collapsed ? 1 : 0, id);
    return { listId: row.list_id };
  })();
}

// ---------------------------------------------------------------------------
// Tag mutations
//
// Tags are global (no list_id) — every mutation touches the one `tags`
// table plus the `task_tags` join, never a per-list scope. Uniqueness is
// enforced case-insensitively both here (for a readable error message) and
// by the `tags_name_unique` index from migration 7 (so a race can't defeat
// it). Deleting a tag or a task cascades the join via `ON DELETE CASCADE`;
// no application-level cleanup of `task_tags` is needed for either.
// ---------------------------------------------------------------------------

function getTagRow(db: Database.Database, id: string): TagRow | undefined {
  return db.prepare(`SELECT * FROM tags WHERE id = ?`).get(id) as TagRow | undefined;
}

/** Case-insensitive name lookup, optionally excluding one tag id (used by
 * `updateTag` so renaming a tag to its own current name, in any casing, is
 * a no-op on the uniqueness check rather than a self-collision). */
function findTagByName(db: Database.Database, name: string, excludeId: string | null): TagRow | undefined {
  if (excludeId) {
    return db
      .prepare(`SELECT * FROM tags WHERE name = ? COLLATE NOCASE AND id != ?`)
      .get(name, excludeId) as TagRow | undefined;
  }
  return db.prepare(`SELECT * FROM tags WHERE name = ? COLLATE NOCASE`).get(name) as TagRow | undefined;
}

function tagRowToDto(row: TagRow, taskCount: number): TagDto {
  return { id: row.id, name: row.name, color: row.color, sortOrder: row.sort_order, taskCount };
}

function getTagDtos(db: Database.Database): TagDto[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.name AS name, t.color AS color, t.sort_order AS sort_order,
              (SELECT COUNT(*) FROM task_tags tt WHERE tt.tag_id = t.id) AS task_count
       FROM tags t
       ORDER BY t.sort_order`,
    )
    .all() as (TagRow & { task_count: number })[];
  return rows.map((r) => tagRowToDto(r, r.task_count));
}

function countTaggedTasks(db: Database.Database, tagId: string): number {
  const { c } = db.prepare(`SELECT COUNT(*) AS c FROM task_tags WHERE tag_id = ?`).get(tagId) as { c: number };
  return c;
}

export function createTag(
  db: Database.Database,
  input: { name: string; color: TagColor },
  now: Date,
): TagDto {
  return db.transaction(() => {
    const name = input.name.trim();
    if (!name) throw new Error("invalid_input: name must not be empty");
    const collision = findTagByName(db, name, null);
    if (collision) {
      throw new Error(`invalid_input: a tag named "${collision.name.toLowerCase()}" already exists`);
    }

    const { m } = db.prepare(`SELECT MAX(sort_order) AS m FROM tags`).get() as { m: number | null };
    const sortOrder = (m ?? 0) + 1000;
    const id = mintTagId();
    db.prepare(`INSERT INTO tags (id, name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      name,
      input.color,
      sortOrder,
      now.getTime(),
    );
    return { id, name, color: input.color, sortOrder, taskCount: 0 };
  })();
}

export function updateTag(
  db: Database.Database,
  input: { id: string; name?: string; color?: TagColor },
  _now: Date,
): TagDto {
  return db.transaction(() => {
    const row = getTagRow(db, input.id);
    if (!row) throw new Error("not_found: tag not found");

    let name = row.name;
    if (input.name !== undefined) {
      name = input.name.trim();
      if (!name) throw new Error("invalid_input: name must not be empty");
      const collision = findTagByName(db, name, row.id);
      if (collision) {
        throw new Error(`invalid_input: a tag named "${collision.name.toLowerCase()}" already exists`);
      }
    }
    const color = input.color ?? row.color;

    db.prepare(`UPDATE tags SET name = ?, color = ? WHERE id = ?`).run(name, color, row.id);
    return tagRowToDto({ ...row, name, color }, countTaggedTasks(db, row.id));
  })();
}

export function deleteTag(db: Database.Database, id: string): void {
  return db.transaction(() => {
    const row = getTagRow(db, id);
    if (!row) throw new Error("not_found: tag not found");
    // ON DELETE CASCADE (migration 8) removes the task_tags rows; tasks
    // themselves are untouched.
    db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
  })();
}

/**
 * `ids` must be a complete, duplicate-free permutation of the current tag
 * catalog. A partial list (e.g. a stale client's catalog missing a
 * concurrently-created tag) is rejected rather than silently renumbering
 * only the ids given: doing the latter can collide `sort_order` between an
 * omitted tag and a renumbered one, making their relative order in
 * `TaskDto.tags` undefined (spec §1.3 invariant #6). The client always has
 * the full catalog from `getBoard`, so a mismatch means it's stale and
 * should refetch — an error it can recover from beats corrupting ordering.
 */
export function reorderTags(db: Database.Database, ids: string[]): TagDto[] {
  return db.transaction(() => {
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      throw new Error("invalid_input: duplicate tag ids in reorder list");
    }

    const existingIds = (db.prepare(`SELECT id FROM tags`).all() as { id: string }[]).map((r) => r.id);
    const existingSet = new Set(existingIds);

    for (const id of ids) {
      if (!existingSet.has(id)) throw new Error("invalid_input: tag not found");
    }
    if (ids.length !== existingIds.length) {
      throw new Error("invalid_input: reorder list must include every tag");
    }

    ids.forEach((id, i) => {
      db.prepare(`UPDATE tags SET sort_order = ? WHERE id = ?`).run((i + 1) * 1000, id);
    });
    return getTagDtos(db);
  })();
}

export function setTaskTags(db: Database.Database, taskId: string, tagIds: string[], now: Date): TaskDto {
  return db.transaction(() => {
    const row = getTaskRow(db, taskId);
    if (!row) throw new Error("not_found: task not found");

    // Full-set replace, not add/remove — idempotent under retry. Duplicate
    // ids in the input are deduped, not an error; an id that doesn't name a
    // real tag is.
    const uniqueIds = [...new Set(tagIds)];
    for (const tagId of uniqueIds) {
      if (!getTagRow(db, tagId)) throw new Error("invalid_input: tag not found");
    }

    db.prepare(`DELETE FROM task_tags WHERE task_id = ?`).run(taskId);
    const insert = db.prepare(`INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)`);
    for (const tagId of uniqueIds) insert.run(taskId, tagId);

    const today = localDay(now);
    const startOfTomorrowMs = startOfNextLocalDay(now);
    return row.parent_id
      ? taskRowToDto(
          row,
          [],
          { total: 0, done: 0 },
          getTaskTags(db, taskId),
          buildTrail(db, row),
          isTodayMember(row, today, startOfTomorrowMs),
        )
      : buildTopLevelDto(db, row, today, startOfTomorrowMs);
  })();
}
