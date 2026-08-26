// All SQL lives here. Every exported function takes the db handle as its
// first argument; server.ts only wires these up to RPC methods and handles
// bb-specific concerns (kv, realtime, background scheduling).
import type Database from "better-sqlite3";
import type { ListDto, TagColor, TagDto, TagRefDto, TaskDto } from "../contract.js";
import { localDay } from "./day.js";
import { mintListId, mintTagId, mintTaskId } from "./ids.js";
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
}

interface TagRow {
  id: string;
  name: string;
  color: TagColor;
  sort_order: number;
  created_at: number;
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

function getChildrenRows(db: Database.Database, parentId: string): TaskRow[] {
  return db
    .prepare(`SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order`)
    .all(parentId) as TaskRow[];
}

function getSiblingRows(
  db: Database.Database,
  listId: string,
  parentId: string | null,
  bucket: "backlog" | "today",
): TaskRow[] {
  if (parentId === null) {
    return db
      .prepare(
        `SELECT * FROM tasks WHERE list_id = ? AND parent_id IS NULL AND bucket = ? AND status = 'open' ORDER BY sort_order`,
      )
      .all(listId, bucket) as TaskRow[];
  }
  return db
    .prepare(
      `SELECT * FROM tasks WHERE list_id = ? AND parent_id = ? AND bucket = ? AND status = 'open' ORDER BY sort_order`,
    )
    .all(listId, parentId, bucket) as TaskRow[];
}

function rebalanceSiblingGroup(
  db: Database.Database,
  listId: string,
  parentId: string | null,
  bucket: "backlog" | "today",
  now: Date,
): void {
  const siblings = getSiblingRows(db, listId, parentId, bucket);
  const ts = now.getTime();
  siblings.forEach((s, i) => {
    db.prepare(`UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?`).run(
      (i + 1) * 1000,
      ts,
      s.id,
    );
  });
}

/** Builds a top-level TaskDto with its open subtasks nested and full counts.
 * `tagMap` is `undefined` for the single-DTO mutation return paths, which
 * use the targeted `getTaskTags` lookup instead of a whole-board map. */
function buildTopLevelDto(db: Database.Database, row: TaskRow, tagMap?: TagMap): TaskDto {
  const children = getChildrenRows(db, row.id);
  const done = children.filter((c) => c.status === "done").length;
  const tagsFor = (id: string) => (tagMap ? (tagMap.get(id) ?? []) : getTaskTags(db, id));
  const subtasks = children
    .filter((c) => c.status === "open")
    .map((c) => taskRowToDto(c, [], { total: 0, done: 0 }, tagsFor(c.id)));
  return taskRowToDto(row, subtasks, { total: children.length, done }, tagsFor(row.id));
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
// Board / archive reads
// ---------------------------------------------------------------------------

export interface BoardResult {
  lists: ListDto[];
  activeListId: string;
  today: { day: string; planned: number; completed: number; tasks: TaskDto[] };
  backlog: { total: number; overdue: number; tasks: TaskDto[] };
  totalOverdue: number;
  serverNow: number;
  tags: TagDto[];
}

export function getBoard(db: Database.Database, listId: string | null, now: Date): BoardResult {
  const lists = getListDtos(db, now);
  const activeListId = listId && lists.some((l) => l.id === listId) ? listId : lists[0].id;
  const today = localDay(now);
  const tagMap = loadTagMap(db);

  // Single source of truth for "this row belongs to today": `day = today`.
  // Every selector and counter below is built from this exact predicate so
  // the visible today.tasks list and the today.planned/today.completed
  // counters can never disagree — a stale `day` (rollover not having run,
  // or a bug in it) can never make a row appear in one and not the other.
  const isTodayRow = `day = ?`;

  const topToday = db
    .prepare(
      `SELECT * FROM tasks WHERE list_id = ? AND parent_id IS NULL AND bucket = 'today' AND status = 'open' AND ${isTodayRow} ORDER BY sort_order`,
    )
    .all(activeListId, today) as TaskRow[];
  const todayTasks = topToday.map((r) => buildTopLevelDto(db, r, tagMap));

  const topBacklog = db
    .prepare(
      `SELECT * FROM tasks WHERE list_id = ? AND parent_id IS NULL AND bucket = 'backlog' AND status = 'open' ORDER BY sort_order`,
    )
    .all(activeListId) as TaskRow[];
  const backlogTasks = topBacklog.map((r) => buildTopLevelDto(db, r, tagMap));

  const planned = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE list_id = ? AND ${isTodayRow}`)
      .get(activeListId, today) as { c: number }
  ).c;
  const completed = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE list_id = ? AND ${isTodayRow} AND status = 'done'`)
      .get(activeListId, today) as { c: number }
  ).c;

  const backlogOverdue = countOverdue(db, activeListId, "backlog", now);
  const totalOverdue = lists.reduce((sum, l) => sum + l.overdueCount, 0);

  return {
    lists,
    activeListId,
    today: { day: today, planned, completed, tasks: todayTasks },
    backlog: { total: topBacklog.length, overdue: backlogOverdue, tasks: backlogTasks },
    totalOverdue,
    serverNow: now.getTime(),
    tags: getTagDtos(db),
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
): ArchiveResult {
  const tagMap = loadTagMap(db);
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
    if (r.parent_id) return taskRowToDto(r, [], { total: 0, done: 0 }, tagMap.get(r.id) ?? []);
    const children = getChildrenRows(db, r.id);
    const done = children.filter((c) => c.status === "done").length;
    const nested = children
      .filter((c) => c.status === "done" && dayOf(c) === dayOf(r))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => taskRowToDto(c, [], { total: 0, done: 0 }, tagMap.get(c.id) ?? []));
    return taskRowToDto(r, nested, { total: children.length, done }, tagMap.get(r.id) ?? []);
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

    const siblings = getSiblingRows(db, listId, parentId, bucket);
    const order =
      input.position === "top"
        ? nextOrder(null, siblings[0]?.sort_order ?? null)
        : nextOrder(siblings[siblings.length - 1]?.sort_order ?? null, null);

    const id = mintTaskId();
    const ts = now.getTime();
    db.prepare(
      `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'open', NULL, 0, ?, ?)`,
    ).run(id, listId, parentId, title, bucket, day, order, input.dueAt, input.hasDueTime ? 1 : 0, ts, ts);

    return buildTopLevelDto(db, getTaskRow(db, id) as TaskRow);
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
    return updated.parent_id
      ? taskRowToDto(updated, [], { total: 0, done: 0 }, getTaskTags(db, updated.id))
      : buildTopLevelDto(db, updated);
  })();
}

export interface MoveTaskInput {
  id: string;
  bucket: "backlog" | "today";
  parentId: string | null;
  beforeId: string | null;
  afterId: string | null;
}

/** Returns the id of the list the moved task belongs to (for realtime). */
export function moveTask(db: Database.Database, input: MoveTaskInput, now: Date): { listId: string } {
  return db.transaction(() => {
    const row = getTaskRow(db, input.id);
    if (!row) throw new Error("not_found: task not found");

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
    const newBucket = parentRow ? parentRow.bucket : input.bucket;
    const newDay = parentRow ? parentRow.day : newBucket === "today" ? localDay(now) : null;
    const newParentId = parentRow ? parentRow.id : null;

    // Making `row` a subtask promotes its own children to top-level
    // siblings placed immediately after it, in their existing order.
    const promoted = newParentId ? getChildrenRows(db, row.id) : [];

    const siblings = getSiblingRows(db, listId, newParentId, newBucket).filter((s) => s.id !== row.id);
    const beforeRow = input.beforeId ? siblings.find((s) => s.id === input.beforeId) : undefined;
    const afterRow = input.afterId ? siblings.find((s) => s.id === input.afterId) : undefined;
    let prevOrder = afterRow ? afterRow.sort_order : null;
    let nextOrderVal = beforeRow ? beforeRow.sort_order : null;

    if (prevOrder === null && nextOrderVal === null) {
      prevOrder = siblings[siblings.length - 1]?.sort_order ?? null;
      nextOrderVal = null;
    } else if (needsRebalance(prevOrder, nextOrderVal)) {
      rebalanceSiblingGroup(db, listId, newParentId, newBucket, now);
      const refreshed = getSiblingRows(db, listId, newParentId, newBucket).filter((s) => s.id !== row.id);
      const br = input.beforeId ? refreshed.find((s) => s.id === input.beforeId) : undefined;
      const ar = input.afterId ? refreshed.find((s) => s.id === input.afterId) : undefined;
      prevOrder = ar ? ar.sort_order : null;
      nextOrderVal = br ? br.sort_order : null;
    }
    const order = nextOrder(prevOrder, nextOrderVal);

    const ts = now.getTime();
    db.prepare(
      `UPDATE tasks SET bucket = ?, day = ?, parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
    ).run(newBucket, newDay, newParentId, order, ts, row.id);

    // Subtasks always mirror their parent's bucket/day. If `row` stays a
    // parent (didn't itself become a subtask), carry its children along.
    if (!newParentId) {
      db.prepare(`UPDATE tasks SET bucket = ?, day = ?, updated_at = ? WHERE parent_id = ?`).run(
        newBucket,
        newDay,
        ts,
        row.id,
      );
    }

    if (promoted.length > 0) {
      const topSiblings = getSiblingRows(db, listId, null, newBucket).filter(
        (s) => s.id !== row.id && !promoted.some((p) => p.id === s.id),
      );
      const following = topSiblings
        .filter((s) => s.sort_order > order)
        .sort((a, b) => a.sort_order - b.sort_order)[0];
      const gapEnd = following ? following.sort_order : order + 1000 * (promoted.length + 1);
      const step = (gapEnd - order) / (promoted.length + 1);
      promoted
        .sort((a, b) => a.sort_order - b.sort_order)
        .forEach((p, i) => {
          db.prepare(
            `UPDATE tasks SET parent_id = NULL, bucket = ?, day = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
          ).run(newBucket, newDay, order + step * (i + 1), ts, p.id);
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

    const ts = now.getTime();
    const completedIds: string[] = [];
    if (row.status === "open") {
      db.prepare(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`).run(
        ts,
        ts,
        id,
      );
      completedIds.push(id);
    }

    if (!row.parent_id) {
      const openChildren = getChildrenRows(db, id).filter((c) => c.status === "open");
      for (const child of openChildren) {
        db.prepare(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`).run(
          ts,
          ts,
          child.id,
        );
        completedIds.push(child.id);
      }
    }

    return { listId: row.list_id, completedIds };
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

export function setTaskTags(db: Database.Database, taskId: string, tagIds: string[], _now: Date): TaskDto {
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

    return row.parent_id
      ? taskRowToDto(row, [], { total: 0, done: 0 }, getTaskTags(db, taskId))
      : buildTopLevelDto(db, row);
  })();
}
