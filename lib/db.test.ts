import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "./db.js";
import { localDay, startOfNextLocalDay } from "./day.js";

function freshDb(): Database.Database {
  const conn = new Database(":memory:");
  conn.pragma("foreign_keys = ON");
  for (const stmt of db.MIGRATIONS) conn.exec(stmt);
  return conn;
}

const NOW = new Date(2026, 7, 20, 12, 0, 0);

describe("seed", () => {
  it("seeds Work then Personal only when lists is empty", () => {
    const conn = freshDb();
    db.seed(conn, NOW);
    const rows = conn.prepare(`SELECT name, sort_order FROM lists ORDER BY sort_order`).all() as {
      name: string;
      sort_order: number;
    }[];
    expect(rows).toEqual([
      { name: "Work", sort_order: 1000 },
      { name: "Personal", sort_order: 2000 },
    ]);

    db.seed(conn, NOW); // second call is a no-op
    const count = (conn.prepare(`SELECT COUNT(*) c FROM lists`).get() as { c: number }).c;
    expect(count).toBe(2);
  });
});

describe("createTask / subtask depth", () => {
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  it("rejects an empty/whitespace title", () => {
    expect(() =>
      db.createTask(
        conn,
        { listId, bucket: "backlog", title: "   ", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
        NOW,
      ),
    ).toThrow(/invalid_input/);
  });

  it("rejects a parentId that is itself a subtask", () => {
    const parent = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "Parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "Child", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    expect(() =>
      db.createTask(
        conn,
        { listId, bucket: "backlog", title: "Grandchild", parentId: child.id, dueAt: null, hasDueTime: false, position: "bottom" },
        NOW,
      ),
    ).toThrow(/invalid_input/);
  });

  it("mirrors the parent's bucket and day onto a new subtask", () => {
    const parent = db.createTask(
      conn,
      { listId, bucket: "today", title: "Parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "Child", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    expect(child.bucket).toBe("today");
    expect(child.day).toBe(parent.day);
  });
});

describe("moveTask", () => {
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  function create(title: string, bucket: "backlog" | "today" = "backlog") {
    return db.createTask(
      conn,
      { listId, bucket, title, parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
  }

  it("rejects a move that would create a cycle", () => {
    const a = create("A");
    const b = create("B");
    db.moveTask(conn, { id: b.id, bucket: "backlog", parentId: a.id, beforeId: null, afterId: null }, NOW);
    // b is now a's child; making a a child of b would be a 2-cycle.
    expect(() =>
      db.moveTask(conn, { id: a.id, bucket: "backlog", parentId: b.id, beforeId: null, afterId: null }, NOW),
    ).toThrow(/cycle/);
  });

  it("rejects a move creating depth > 1", () => {
    const a = create("A");
    const b = create("B");
    const c = create("C");
    db.moveTask(conn, { id: b.id, bucket: "backlog", parentId: a.id, beforeId: null, afterId: null }, NOW);
    // b is already a subtask; nesting c under b would be depth 2.
    expect(() =>
      db.moveTask(conn, { id: c.id, bucket: "backlog", parentId: b.id, beforeId: null, afterId: null }, NOW),
    ).toThrow(/depth/);
  });

  it("promotes a task's own children to top-level siblings right after it", () => {
    const a = create("A");
    const b = create("B");
    const child1 = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "child1", parentId: a.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child2 = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "child2", parentId: a.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );

    // Drop A onto B: A becomes a subtask of B, and A's own children (child1,
    // child2) are promoted to top-level, placed right after A in order.
    db.moveTask(conn, { id: a.id, bucket: "backlog", parentId: b.id, beforeId: null, afterId: null }, NOW);

    const rows = conn
      .prepare(`SELECT id, parent_id FROM tasks WHERE list_id = ? ORDER BY sort_order`)
      .all(listId) as { id: string; parent_id: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r.parent_id]));
    expect(byId.get(a.id)).toBe(b.id);
    expect(byId.get(child1.id)).toBeNull();
    expect(byId.get(child2.id)).toBeNull();

    // Order preserved: child1 then child2, both after A.
    const order = rows.map((r) => r.id);
    expect(order.indexOf(child1.id)).toBeLessThan(order.indexOf(child2.id));
  });

  it("makes a top-level task out of a subtask when dropped into a section", () => {
    const a = create("A");
    const child = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "child", parentId: a.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.moveTask(conn, { id: child.id, bucket: "today", parentId: null, beforeId: null, afterId: null }, NOW);
    const row = conn.prepare(`SELECT parent_id, bucket, day FROM tasks WHERE id = ?`).get(child.id) as {
      parent_id: string | null;
      bucket: string;
      day: string | null;
    };
    expect(row.parent_id).toBeNull();
    expect(row.bucket).toBe("today");
    expect(row.day).not.toBeNull();
  });

  it("rebalances the sibling group when the fractional gap collapses", () => {
    const a = create("A");
    const b = create("B");
    // Repeatedly insert between a and b until the gap collapses below the
    // threshold and moveTask has to rebalance.
    let lastId = a.id;
    for (let i = 0; i < 20; i++) {
      const t = create(`mid${i}`);
      db.moveTask(conn, { id: t.id, bucket: "backlog", parentId: null, beforeId: b.id, afterId: lastId }, NOW);
      lastId = t.id;
    }
    const orders = (
      conn
        .prepare(`SELECT sort_order FROM tasks WHERE list_id = ? AND bucket = 'backlog' ORDER BY sort_order`)
        .all(listId) as { sort_order: number }[]
    ).map((r) => r.sort_order);
    // All gaps must be comfortably above the rebalance threshold after the
    // (possibly repeated) rebalance(s) — i.e. it actually happened.
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i] - orders[i - 1]).toBeGreaterThan(0.0001);
    }
    // No two rows collide.
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe("completeTask / restoreTasks", () => {
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  it("completing a parent completes its open subtasks and reports every changed id", () => {
    const parent = db.createTask(
      conn,
      { listId, bucket: "today", title: "Parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child1 = db.createTask(
      conn,
      { listId, bucket: "today", title: "c1", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child2 = db.createTask(
      conn,
      { listId, bucket: "today", title: "c2", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );

    const { completedIds } = db.completeTask(conn, parent.id, NOW);
    expect(new Set(completedIds)).toEqual(new Set([parent.id, child1.id, child2.id]));

    // restoreTasks undoes exactly that set.
    db.restoreTasks(conn, completedIds, NOW);
    const statuses = conn
      .prepare(`SELECT status FROM tasks WHERE id IN (?, ?, ?)`)
      .all(parent.id, child1.id, child2.id) as { status: string }[];
    expect(statuses.every((s) => s.status === "open")).toBe(true);
  });
});

describe("getBoard", () => {
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  it("today's planned/completed count top-level rows and subtasks, and survive completion vanishing them", () => {
    const parent = db.createTask(
      conn,
      { listId, bucket: "today", title: "Parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.createTask(
      conn,
      { listId, bucket: "today", title: "c1", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.completeTask(conn, parent.id, NOW);

    const board = db.getBoard(conn, listId, NOW);
    expect(board.today.planned).toBe(2); // parent + subtask, both day=today
    expect(board.today.completed).toBe(2);
    // Both rows are done, so they vanish from the open backlog entirely —
    // there's no separate today.tasks list to vanish from anymore.
    expect(board.backlog.tasks.find((t) => t.id === parent.id)).toBeUndefined();
  });

  it("falls back to the first list when listId is null or unknown", () => {
    const board = db.getBoard(conn, null, NOW);
    expect(board.activeListId).toBe(listId);
    const board2 = db.getBoard(conn, "not-a-real-list", NOW);
    expect(board2.activeListId).toBe(listId);
  });
});

describe("list CRUD", () => {
  it("refuses to delete the last remaining list", () => {
    const conn = freshDb();
    const only = db.createList(conn, "Only", NOW);
    expect(() => db.deleteList(conn, only.id, NOW)).toThrow(/last remaining list/);
  });

  it("cascades a list's tasks when the list is deleted", () => {
    const conn = freshDb();
    db.seed(conn, NOW);
    const lists = conn.prepare(`SELECT id FROM lists ORDER BY sort_order`).all() as { id: string }[];
    const [first, second] = lists;
    const task = db.createTask(
      conn,
      { listId: first.id, bucket: "backlog", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.deleteList(conn, first.id, NOW);
    const row = conn.prepare(`SELECT id FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toBeUndefined();
    // The other list survives.
    const remaining = conn.prepare(`SELECT id FROM lists`).all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toEqual([second.id]);
  });
});

describe("clearArchive", () => {
  it("hard-deletes every done row in the list and nothing else", () => {
    const conn = freshDb();
    db.seed(conn, NOW);
    const listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
    const open = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "open", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const done = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "done", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.completeTask(conn, done.id, NOW);

    const deleted = db.clearArchive(conn, listId);
    expect(deleted).toBe(1);
    expect(conn.prepare(`SELECT id FROM tasks WHERE id = ?`).get(open.id)).toBeDefined();
    expect(conn.prepare(`SELECT id FROM tasks WHERE id = ?`).get(done.id)).toBeUndefined();
  });
});

describe("tags", () => {
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  it("create appears in listTags-equivalent (getBoard.tags) with sortOrder after existing tags", () => {
    const a = db.createTag(conn, { name: "urgent", color: "red" }, NOW);
    const b = db.createTag(conn, { name: "bug", color: "amber" }, NOW);
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);

    const board = db.getBoard(conn, listId, NOW);
    expect(board.tags.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("throws on a duplicate name differing only in case", () => {
    db.createTag(conn, { name: "Urgent", color: "red" }, NOW);
    expect(() => db.createTag(conn, { name: "urgent", color: "blue" }, NOW)).toThrow(
      /invalid_input: a tag named "urgent" already exists/,
    );
  });

  it("throws on an empty or whitespace-only name", () => {
    expect(() => db.createTag(conn, { name: "   ", color: "red" }, NOW)).toThrow(
      /invalid_input: name must not be empty/,
    );
  });

  it("updateTag: rename to a colliding name throws; rename to own name in new casing succeeds", () => {
    const a = db.createTag(conn, { name: "urgent", color: "red" }, NOW);
    const b = db.createTag(conn, { name: "bug", color: "amber" }, NOW);

    expect(() => db.updateTag(conn, { id: b.id, name: "URGENT" }, NOW)).toThrow(/invalid_input/);

    const renamed = db.updateTag(conn, { id: a.id, name: "URGENT" }, NOW);
    expect(renamed.name).toBe("URGENT");
    expect(renamed.id).toBe(a.id);
  });

  it("deleteTag removes assignments but leaves tasks intact", () => {
    const tag = db.createTag(conn, { name: "urgent", color: "red" }, NOW);
    const task = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.setTaskTags(conn, task.id, [tag.id], NOW);

    db.deleteTag(conn, tag.id);

    const taskRow = conn.prepare(`SELECT id FROM tasks WHERE id = ?`).get(task.id);
    expect(taskRow).toBeDefined();
    const assignment = conn.prepare(`SELECT * FROM task_tags WHERE tag_id = ?`).get(tag.id);
    expect(assignment).toBeUndefined();
  });

  it("deleteTask removes assignments but leaves tags intact", () => {
    const tag = db.createTag(conn, { name: "urgent", color: "red" }, NOW);
    const task = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.setTaskTags(conn, task.id, [tag.id], NOW);

    db.deleteTask(conn, task.id);

    const tagRow = conn.prepare(`SELECT id FROM tags WHERE id = ?`).get(tag.id);
    expect(tagRow).toBeDefined();
    const assignment = conn.prepare(`SELECT * FROM task_tags WHERE task_id = ?`).get(task.id);
    expect(assignment).toBeUndefined();
  });

  it("setTaskTags replaces the full set, is idempotent, dedupes duplicate input ids, throws on an unknown tag id", () => {
    const a = db.createTag(conn, { name: "urgent", color: "red" }, NOW);
    const b = db.createTag(conn, { name: "bug", color: "amber" }, NOW);
    const task = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );

    const withA = db.setTaskTags(conn, task.id, [a.id], NOW);
    expect(withA.tags.map((t) => t.id)).toEqual([a.id]);

    // Idempotent: setting the same set again is a no-op change-wise.
    const again = db.setTaskTags(conn, task.id, [a.id], NOW);
    expect(again.tags.map((t) => t.id)).toEqual([a.id]);

    // Full replace, and duplicate ids in the input are deduped.
    const withBoth = db.setTaskTags(conn, task.id, [b.id, b.id, a.id], NOW);
    expect(new Set(withBoth.tags.map((t) => t.id))).toEqual(new Set([a.id, b.id]));
    expect(withBoth.tags.length).toBe(2);

    const cleared = db.setTaskTags(conn, task.id, [], NOW);
    expect(cleared.tags).toEqual([]);

    expect(() => db.setTaskTags(conn, task.id, ["tag_does_not_exist"], NOW)).toThrow(/invalid_input/);
  });

  it("getBoard returns tags: [] for untagged tasks, ordered refs for tagged ones, and populates tags on subtasks", () => {
    const a = db.createTag(conn, { name: "urgent", color: "red" }, NOW);
    const b = db.createTag(conn, { name: "bug", color: "amber" }, NOW);

    const untagged = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "untagged", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const parent = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "child", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );

    // Assign in reverse insertion order to prove ordering follows tag
    // sort_order, not insertion order.
    db.setTaskTags(conn, parent.id, [b.id, a.id], NOW);
    db.setTaskTags(conn, child.id, [b.id], NOW);

    const board = db.getBoard(conn, listId, NOW);
    const untaggedDto = board.backlog.tasks.find((t) => t.id === untagged.id)!;
    expect(untaggedDto.tags).toEqual([]);

    const parentDto = board.backlog.tasks.find((t) => t.id === parent.id)!;
    expect(parentDto.tags.map((t) => t.id)).toEqual([a.id, b.id]);

    const childDto = parentDto.subtasks.find((t) => t.id === child.id)!;
    expect(childDto.tags.map((t) => t.id)).toEqual([b.id]);
  });

  it("reorderTags renumbers a full valid permutation and every sort_order stays distinct", () => {
    const a = db.createTag(conn, { name: "urgent", color: "red" }, NOW);
    const b = db.createTag(conn, { name: "bug", color: "amber" }, NOW);
    const c = db.createTag(conn, { name: "deep-work", color: "blue" }, NOW);
    const task = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.setTaskTags(conn, task.id, [a.id, b.id], NOW);

    const reordered = db.reorderTags(conn, [c.id, b.id, a.id]);
    expect(reordered.map((t) => t.id)).toEqual([c.id, b.id, a.id]);
    const orders = reordered.map((t) => t.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);

    const board = db.getBoard(conn, listId, NOW);
    const dto = board.backlog.tasks.find((t) => t.id === task.id)!;
    expect(dto.tags.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it("reorderTags reflects the new order in TaskDto.tags on both a top-level task and a subtask", () => {
    const a = db.createTag(conn, { name: "urgent", color: "red" }, NOW);
    const b = db.createTag(conn, { name: "bug", color: "amber" }, NOW);
    const parent = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "child", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.setTaskTags(conn, parent.id, [a.id, b.id], NOW);
    db.setTaskTags(conn, child.id, [a.id, b.id], NOW);

    db.reorderTags(conn, [b.id, a.id]);

    const board = db.getBoard(conn, listId, NOW);
    const parentDto = board.backlog.tasks.find((t) => t.id === parent.id)!;
    expect(parentDto.tags.map((t) => t.id)).toEqual([b.id, a.id]);
    const childDto = parentDto.subtasks.find((t) => t.id === child.id)!;
    expect(childDto.tags.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it("reorderTags rejects a partial id list and leaves the catalog unchanged (regression: this used to collide sort_order and corrupt chip ordering)", () => {
    const a = db.createTag(conn, { name: "urgent", color: "red" }, NOW);
    db.createTag(conn, { name: "bug", color: "amber" }, NOW);
    const c = db.createTag(conn, { name: "deep-work", color: "blue" }, NOW);
    const before = db.getBoard(conn, listId, NOW).tags;

    expect(() => db.reorderTags(conn, [c.id, a.id])).toThrow(
      /invalid_input: reorder list must include every tag/,
    );

    const after = db.getBoard(conn, listId, NOW).tags;
    expect(after).toEqual(before);
  });

  it("reorderTags rejects duplicate ids in the input", () => {
    const a = db.createTag(conn, { name: "urgent", color: "red" }, NOW);
    db.createTag(conn, { name: "bug", color: "amber" }, NOW);
    expect(() => db.reorderTags(conn, [a.id, a.id])).toThrow(
      /invalid_input: duplicate tag ids in reorder list/,
    );
  });

  it("reorderTags rejects an id that doesn't name a real tag", () => {
    const a = db.createTag(conn, { name: "urgent", color: "red" }, NOW);
    expect(() => db.reorderTags(conn, [a.id, "tag_does_not_exist"])).toThrow(/invalid_input: tag not found/);
  });
});

// ---------------------------------------------------------------------------
// Projects (docs/design/2026-08-27-projects.md, Phases 1-3)
// ---------------------------------------------------------------------------

describe("migration 15 backfill", () => {
  it("preserves every existing Today row's exact prior position when backfilling today_order from sort_order", () => {
    const conn = new Database(":memory:");
    conn.pragma("foreign_keys = ON");
    // Fixture: only the pre-change schema (statements 0-9) — the shape the
    // database was in before this feature shipped. Migration 15 is a
    // one-shot backfill and is not re-runnable, so it's tested against
    // this exact pre-change fixture rather than the post-change freshDb().
    for (const stmt of db.MIGRATIONS.slice(0, 10)) conn.exec(stmt);
    conn.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES ('lst_1', 'Work', 1000, 0)`).run();
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
         VALUES ('tsk_today', 'lst_1', NULL, 'today task', NULL, 'today', '2026-08-20', 4242.5, NULL, 0, 'open', NULL, 0, 0, 0)`,
      )
      .run();
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
         VALUES ('tsk_backlog', 'lst_1', NULL, 'backlog task', NULL, 'backlog', NULL, 777, NULL, 0, 'open', NULL, 0, 0, 0)`,
      )
      .run();

    // The actual upgrade path: apply migrations 10-15 on top.
    for (const stmt of db.MIGRATIONS.slice(10)) conn.exec(stmt);

    const today = conn.prepare(`SELECT sort_order, today_order FROM tasks WHERE id = 'tsk_today'`).get() as {
      sort_order: number;
      today_order: number | null;
    };
    expect(today.today_order).toBe(4242.5);
    expect(today.sort_order).toBe(4242.5); // untouched — exact prior position preserved

    const backlogRow = conn.prepare(`SELECT today_order FROM tasks WHERE id = 'tsk_backlog'`).get() as {
      today_order: number | null;
    };
    expect(backlogRow.today_order).toBeNull();
  });
});

describe("migration 16 — today_dismissed_day", () => {
  it("applies cleanly on a fresh db and adds a nullable column", () => {
    const conn = freshDb();
    const cols = conn.prepare(`PRAGMA table_info(tasks)`).all() as { name: string; notnull: number }[];
    const col = cols.find((c) => c.name === "today_dismissed_day");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);

    conn.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES ('lst_1', 'Work', 1000, 0)`).run();
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
         VALUES ('tsk_1', 'lst_1', NULL, 'task', NULL, 'backlog', NULL, 1000, NULL, 0, 'open', NULL, 0, 0, 0)`,
      )
      .run();
    const row = conn.prepare(`SELECT today_dismissed_day FROM tasks WHERE id = 'tsk_1'`).get() as {
      today_dismissed_day: string | null;
    };
    // NULL = "never dismissed" — the correct state for every pre-existing row.
    expect(row.today_dismissed_day).toBeNull();
  });

  it("applies cleanly against a pre-16 fixture that already carries non-null today_order values (real-shaped legacy data)", () => {
    const conn = new Database(":memory:");
    conn.pragma("foreign_keys = ON");
    // Fixture: the schema exactly as it shipped before this migration
    // (statements 0-15) — mirrors the "migration 15 backfill" fixture
    // pattern above. today_order is populated, mimicking a real Today row
    // that predates today_dismissed_day entirely.
    for (const stmt of db.MIGRATIONS.slice(0, 16)) conn.exec(stmt);
    conn.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES ('lst_1', 'Work', 1000, 0)`).run();
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, today_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
         VALUES ('tsk_today', 'lst_1', NULL, 'today task', NULL, 'today', '2026-08-20', 4242.5, 4242.5, NULL, 0, 'open', NULL, 0, 0, 0)`,
      )
      .run();

    // The actual upgrade path: apply migration 16 on top of the legacy fixture.
    for (const stmt of db.MIGRATIONS.slice(16)) conn.exec(stmt);

    const row = conn
      .prepare(`SELECT sort_order, today_order, today_dismissed_day FROM tasks WHERE id = 'tsk_today'`)
      .get() as { sort_order: number; today_order: number | null; today_dismissed_day: string | null };
    // The additive migration touches nothing that already existed.
    expect(row.sort_order).toBe(4242.5);
    expect(row.today_order).toBe(4242.5);
    expect(row.today_dismissed_day).toBeNull();
  });
});

describe("TODAY_MEMBERSHIP_SQL / isTodayMember agreement (drift guard)", () => {
  // Hand-built rows covering every branch of the union, including the two
  // opposite dismissal outcomes. `TODAY_MEMBERSHIP_SQL` and `isTodayMember`
  // are two independent expressions of the same predicate (one SQL, one
  // TS) — this test is the thing that would catch them silently diverging.
  const TODAY = "2026-08-20";
  const YESTERDAY = "2026-08-19";
  const startOfTomorrowMs = startOfNextLocalDay(new Date(2026, 7, 20, 12, 0, 0));
  const dueToday = new Date(2026, 7, 20, 9, 0, 0).getTime(); // within today's window
  const dueOverdue = new Date(2026, 7, 18, 9, 0, 0).getTime(); // before today, still open
  const dueFuture = new Date(2026, 7, 25, 9, 0, 0).getTime(); // not due yet

  type FixtureRow = {
    id: string;
    bucket: "backlog" | "today";
    day: string | null;
    due_at: number | null;
    today_dismissed_day: string | null;
  };

  const rows: FixtureRow[] = [
    { id: "manual_only", bucket: "today", day: TODAY, due_at: null, today_dismissed_day: null },
    { id: "auto_due_today", bucket: "backlog", day: null, due_at: dueToday, today_dismissed_day: null },
    { id: "auto_overdue", bucket: "backlog", day: null, due_at: dueOverdue, today_dismissed_day: null },
    { id: "both_manual_and_auto", bucket: "today", day: TODAY, due_at: dueOverdue, today_dismissed_day: null },
    { id: "dismissed_today", bucket: "backlog", day: null, due_at: dueOverdue, today_dismissed_day: TODAY },
    { id: "dismissed_yesterday", bucket: "backlog", day: null, due_at: dueOverdue, today_dismissed_day: YESTERDAY },
    { id: "no_due_not_scheduled", bucket: "backlog", day: null, due_at: null, today_dismissed_day: null },
    { id: "future_due_not_scheduled", bucket: "backlog", day: null, due_at: dueFuture, today_dismissed_day: null },
  ];

  function fixtureDb(): Database.Database {
    const conn = freshDb();
    conn.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES ('lst_1', 'Work', 1000, 0)`).run();
    const insert = conn.prepare(
      `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, today_dismissed_day, created_at, updated_at)
       VALUES (?, 'lst_1', NULL, ?, NULL, ?, ?, 1000, ?, 0, 'open', NULL, 0, ?, 0, 0)`,
    );
    for (const r of rows) insert.run(r.id, r.id, r.bucket, r.day, r.due_at, r.today_dismissed_day);
    return conn;
  }

  it("SQL and TS agree on every hand-built row, including both dismissal outcomes", () => {
    const conn = fixtureDb();
    const sqlIds = new Set(
      (
        conn
          .prepare(`SELECT id FROM tasks WHERE ${db.TODAY_MEMBERSHIP_SQL}`)
          .all(TODAY, startOfTomorrowMs, TODAY) as { id: string }[]
      ).map((r) => r.id),
    );
    const tsIds = new Set(rows.filter((r) => db.isTodayMember(r, TODAY, startOfTomorrowMs)).map((r) => r.id));

    expect(sqlIds).toEqual(tsIds);
    // Pin the expected membership explicitly so a change to either
    // predicate that happens to keep them in agreement, but drifts from
    // the design doc's union, still fails this test.
    expect([...sqlIds].sort()).toEqual(
      ["manual_only", "auto_due_today", "auto_overdue", "both_manual_and_auto", "dismissed_yesterday"].sort(),
    );
    expect(sqlIds.has("dismissed_today")).toBe(false);
    expect(sqlIds.has("no_due_not_scheduled")).toBe(false);
    expect(sqlIds.has("future_due_not_scheduled")).toBe(false);
  });
});

describe("PRAGMA foreign_keys finding", () => {
  // Finding (per the design doc's "verify before relying on it"): this
  // codebase turns PRAGMA foreign_keys ON explicitly — server.ts does it on
  // every connection ("better-sqlite3 defaults foreign_keys off; ON DELETE
  // CASCADE is inert without this"), and this file's own freshDb() mirrors
  // that for tests. So FK cascades *would* fire here. deleteProject still
  // does not depend on that: migration 12's `project_id` column carries no
  // `ON DELETE SET NULL` clause at all (just a bare REFERENCES), so without
  // an explicit release it would default to `ON DELETE NO ACTION` and
  // *reject* the delete outright while any task still points at the
  // project — not cascade it. The explicit `UPDATE ... SET project_id =
  // NULL` in deleteProject (lib/db.ts) is required either way.
  it("is ON in this codebase's connections", () => {
    const conn = freshDb();
    expect(conn.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

describe("writeOrder structural guard", () => {
  it("is the only code path that assigns tasks.sort_order or tasks.today_order (risk mitigation from the design doc, made structurally true)", () => {
    const src = readFileSync(fileURLToPath(new URL("./db.ts", import.meta.url)), "utf8");
    const codeOnly = src.slice(src.indexOf("interface TaskRow")); // past the MIGRATIONS SQL text
    const updateStatements = codeOnly.match(/UPDATE tasks SET[^`]*/g) ?? [];
    expect(updateStatements.length).toBeGreaterThan(5); // sanity: the scan actually found statements
    for (const stmt of updateStatements) {
      if (stmt.includes("${column}")) continue; // writeOrder's own statement
      expect(stmt).not.toMatch(/\bsort_order\b/);
      expect(stmt).not.toMatch(/\btoday_order\b/);
    }
  });

  // Phase 2: today_order is abandoned. Today now inherits sort_order, so
  // there is exactly one order column and writeOrder's `column` parameter
  // is narrowed to the single literal type "sort_order" — nothing anywhere
  // in this file can write today_order anymore, by construction. The
  // column itself stays in the schema (see migration 13's comment and the
  // PRAGMA check below) purely as a rollback escape hatch.
  it("writeOrder never writes today_order anywhere in db.ts, and the abandoned column still exists in the schema", () => {
    const src = readFileSync(fileURLToPath(new URL("./db.ts", import.meta.url)), "utf8");
    const codeOnly = src.slice(src.indexOf("interface TaskRow"));
    const callSites = codeOnly.match(/writeOrder\([^):]*,\s*"today_order"/g) ?? [];
    expect(callSites.length).toBe(0);

    const conn = freshDb();
    const cols = conn.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    expect(cols.some((c) => c.name === "today_order")).toBe(true); // abandoned, not dropped
  });
});

describe("project CRUD", () => {
  let conn: Database.Database;
  let listId: string;
  let otherListId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    const lists = conn.prepare(`SELECT id FROM lists ORDER BY sort_order`).all() as { id: string }[];
    listId = lists[0].id;
    otherListId = lists[1].id;
  });

  it("createProject trims the name, rejects empty, and assigns an increasing sort_order per list", () => {
    const a = db.createProject(conn, { listId, name: "Q3 Launch", color: "blue" }, NOW);
    const b = db.createProject(conn, { listId, name: "  Personal errands  ", color: "green" }, NOW);
    expect(b.name).toBe("Personal errands");
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);
    expect(a.listId).toBe(listId);
    expect(a.collapsed).toBe(false);
    expect(a.openCount).toBe(0);

    expect(() => db.createProject(conn, { listId, name: "   ", color: "red" }, NOW)).toThrow(/invalid_input/);
  });

  it("updateProject renames and recolors, and reflects live counts", () => {
    const project = db.createProject(conn, { listId, name: "Q3 Launch", color: "blue" }, NOW);
    db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "t",
        parentId: null,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
        projectId: project.id,
      },
      NOW,
    );

    const updated = db.updateProject(conn, { id: project.id, name: "Q3 Launch (renamed)", color: "violet" }, NOW);
    expect(updated.name).toBe("Q3 Launch (renamed)");
    expect(updated.color).toBe("violet");
    expect(updated.openCount).toBe(1);

    expect(() => db.updateProject(conn, { id: "prj_missing", name: "x" }, NOW)).toThrow(/not_found/);
  });

  it("deleteProject releases its tasks to loose (project_id = NULL) rather than deleting them — invariant 6", () => {
    const project = db.createProject(conn, { listId, name: "Q3 Launch", color: "blue" }, NOW);
    const task = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "t",
        parentId: null,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
        projectId: project.id,
      },
      NOW,
    );

    db.deleteProject(conn, project.id);

    const row = conn.prepare(`SELECT project_id, status FROM tasks WHERE id = ?`).get(task.id) as {
      project_id: string | null;
      status: string;
    };
    expect(row.project_id).toBeNull(); // released to loose, not the bin
    expect(row.status).toBe("open");
    expect(conn.prepare(`SELECT id FROM projects WHERE id = ?`).get(project.id)).toBeUndefined();

    expect(() => db.deleteProject(conn, "prj_missing")).toThrow(/not_found/);
  });

  it("reorderProjects renumbers sort_order scoped to the given list", () => {
    const a = db.createProject(conn, { listId, name: "A", color: "red" }, NOW);
    const b = db.createProject(conn, { listId, name: "B", color: "amber" }, NOW);
    const reordered = db.reorderProjects(conn, listId, [b.id, a.id], NOW);
    expect(reordered.map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("setProjectCollapsed persists across reads", () => {
    const project = db.createProject(conn, { listId, name: "Q3 Launch", color: "blue" }, NOW);
    db.setProjectCollapsed(conn, project.id, true);
    const board = db.getBoard(conn, listId, NOW);
    expect(board.projects.find((p) => p.id === project.id)?.collapsed).toBe(true);
  });

  it("listProjects / getBoard.projects only returns projects for the active list", () => {
    db.createProject(conn, { listId, name: "In this list", color: "blue" }, NOW);
    db.createProject(conn, { listId: otherListId, name: "In the other list", color: "red" }, NOW);
    expect(db.listProjects(conn, listId, NOW).map((p) => p.name)).toEqual(["In this list"]);
    const board = db.getBoard(conn, listId, NOW);
    expect(board.projects.map((p) => p.name)).toEqual(["In this list"]);
  });
});

describe("invariants (docs/design/2026-08-27-projects.md)", () => {
  let conn: Database.Database;
  let listId: string;
  let otherListId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    const lists = conn.prepare(`SELECT id FROM lists ORDER BY sort_order`).all() as { id: string }[];
    listId = lists[0].id;
    otherListId = lists[1].id;
  });

  function create(title: string, overrides: Partial<db.CreateTaskInput> = {}) {
    return db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title,
        parentId: null,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
        ...overrides,
      },
      NOW,
    );
  }

  it("invariant 1: a task with parent_id != NULL can never be a parent (depth cap)", () => {
    const parent = create("parent");
    const child = create("child", { parentId: parent.id });
    expect(() => create("grandchild", { parentId: child.id })).toThrow(/invalid_input/);
    expect(() =>
      db.moveTask(conn, { id: child.id, bucket: "backlog", parentId: null, beforeId: null, afterId: null }, NOW),
    ).not.toThrow(); // sanity: promoting a subtask back to top-level is fine
  });

  it("invariant 2: createTask mirrors a subtask's project_id from its parent, ignoring any projectId passed for the subtask itself", () => {
    const project = db.createProject(conn, { listId, name: "Q3", color: "blue" }, NOW);
    const otherProject = db.createProject(conn, { listId, name: "Other", color: "red" }, NOW);
    const parent = create("parent", { projectId: project.id });
    const child = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "child",
        parentId: parent.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
        projectId: otherProject.id,
      },
      NOW,
    );
    expect(child.projectId).toBe(project.id); // mirrors the parent, not the (ignored) input
  });

  it("invariant 2: moveTask mirrors a subtask's project_id from its new parent; a promoted ex-child keeps its own", () => {
    const projectA = db.createProject(conn, { listId, name: "A", color: "blue" }, NOW);
    const projectB = db.createProject(conn, { listId, name: "B", color: "red" }, NOW);
    const parentInB = create("parent in B", { projectId: projectB.id });
    const looseTask = create("loose", { projectId: projectA.id });
    const grandchild = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "grandchild-to-be-promoted",
        parentId: looseTask.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      },
      NOW,
    );

    // Nest looseTask under parentInB: looseTask becomes a subtask and must
    // mirror parentInB's project (B), even though it was filed under A.
    db.moveTask(
      conn,
      { id: looseTask.id, bucket: "backlog", parentId: parentInB.id, beforeId: null, afterId: null },
      NOW,
    );
    const looseRow = conn.prepare(`SELECT project_id FROM tasks WHERE id = ?`).get(looseTask.id) as {
      project_id: string | null;
    };
    expect(looseRow.project_id).toBe(projectB.id);

    // Its own child (grandchild) got promoted to top-level by that same
    // move — a promoted row keeps whatever project it already had (A); it
    // is not forced to follow its ex-parent into B.
    const grandchildRow = conn.prepare(`SELECT project_id, parent_id FROM tasks WHERE id = ?`).get(
      grandchild.id,
    ) as { project_id: string | null; parent_id: string | null };
    expect(grandchildRow.parent_id).toBeNull();
    expect(grandchildRow.project_id).toBe(projectA.id);
  });

  it("invariant 2: re-homing a top-level parent to a different project cascades to its remaining children", () => {
    const projectA = db.createProject(conn, { listId, name: "A", color: "blue" }, NOW);
    const projectB = db.createProject(conn, { listId, name: "B", color: "red" }, NOW);
    const parent = create("parent", { projectId: projectA.id });
    const child = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "child",
        parentId: parent.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      },
      NOW,
    );
    db.moveTask(
      conn,
      { id: parent.id, bucket: "backlog", parentId: null, beforeId: null, afterId: null, projectId: projectB.id },
      NOW,
    );
    const childRow = conn.prepare(`SELECT project_id FROM tasks WHERE id = ?`).get(child.id) as {
      project_id: string | null;
    };
    expect(childRow.project_id).toBe(projectB.id);
  });

  it("invariant 3: a task's project must belong to the task's list — createTask and moveTask both reject a cross-list project", () => {
    const otherProject = db.createProject(conn, { listId: otherListId, name: "Elsewhere", color: "blue" }, NOW);
    expect(() =>
      db.createTask(
        conn,
        {
          listId,
          bucket: "backlog",
          title: "t",
          parentId: null,
          dueAt: null,
          hasDueTime: false,
          position: "bottom",
          projectId: otherProject.id,
        },
        NOW,
      ),
    ).toThrow(/invalid_input/);

    const task = create("t");
    expect(() =>
      db.moveTask(
        conn,
        { id: task.id, bucket: "backlog", parentId: null, beforeId: null, afterId: null, projectId: otherProject.id },
        NOW,
      ),
    ).toThrow(/invalid_input/);
  });

  it("invariant 4: scheduling a subtask into Today does not schedule its parent, and scheduling a parent does not drag its subtasks along", () => {
    const parent = create("parent");
    const child = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "child",
        parentId: parent.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      },
      NOW,
    );

    db.moveTask(conn, { id: child.id, bucket: "today", parentId: parent.id, beforeId: null, afterId: null }, NOW);
    const parentAfterChildScheduled = conn.prepare(`SELECT bucket FROM tasks WHERE id = ?`).get(parent.id) as {
      bucket: string;
    };
    expect(parentAfterChildScheduled.bucket).toBe("backlog"); // parent untouched
    const childRow = conn.prepare(`SELECT bucket, parent_id FROM tasks WHERE id = ?`).get(child.id) as {
      bucket: string;
      parent_id: string | null;
    };
    expect(childRow.bucket).toBe("today");
    expect(childRow.parent_id).toBe(parent.id); // the central change: parent_id survives

    // Reset, then schedule the parent instead.
    db.moveTask(conn, { id: child.id, bucket: "backlog", parentId: parent.id, beforeId: null, afterId: null }, NOW);
    db.moveTask(conn, { id: parent.id, bucket: "today", parentId: null, beforeId: null, afterId: null }, NOW);
    const childAfterParentScheduled = conn.prepare(`SELECT bucket FROM tasks WHERE id = ?`).get(child.id) as {
      bucket: string;
    };
    expect(childAfterParentScheduled.bucket).toBe("backlog"); // subtask not dragged along
  });

  it("invariant 5 (revised — Phase 2): today_order is abandoned, so it stays NULL forever now regardless of bucket, since nothing writes it anymore", () => {
    const task = create("t");
    let row = conn.prepare(`SELECT bucket, today_order FROM tasks WHERE id = ?`).get(task.id) as {
      bucket: string;
      today_order: number | null;
    };
    expect(row.bucket).toBe("backlog");
    expect(row.today_order).toBeNull();

    db.moveTask(conn, { id: task.id, bucket: "today", parentId: null, beforeId: null, afterId: null }, NOW);
    row = conn.prepare(`SELECT bucket, today_order FROM tasks WHERE id = ?`).get(task.id) as {
      bucket: string;
      today_order: number | null;
    };
    expect(row.bucket).toBe("today");
    expect(row.today_order).toBeNull(); // was `.not.toBeNull()` pre-Phase-2 — Today now shares sort_order instead

    db.moveTask(conn, { id: task.id, bucket: "backlog", parentId: null, beforeId: null, afterId: null }, NOW);
    row = conn.prepare(`SELECT bucket, today_order FROM tasks WHERE id = ?`).get(task.id) as {
      bucket: string;
      today_order: number | null;
    };
    expect(row.bucket).toBe("backlog");
    expect(row.today_order).toBeNull();
  });

  it("invariant 6: deleting a project releases its tasks to loose, never into the bin", () => {
    const project = db.createProject(conn, { listId, name: "Q3", color: "blue" }, NOW);
    const task = create("t", { projectId: project.id });
    db.deleteProject(conn, project.id);
    const row = conn.prepare(`SELECT status, project_id FROM tasks WHERE id = ?`).get(task.id) as {
      status: string;
      project_id: string | null;
    };
    expect(row.status).toBe("open");
    expect(row.project_id).toBeNull();
  });
});

describe("moveTask — projects and the drag matrix", () => {
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  function create(title: string, overrides: Partial<db.CreateTaskInput> = {}) {
    return db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title,
        parentId: null,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
        ...overrides,
      },
      NOW,
    );
  }

  it("project task -> Today: flags scheduled, keeps its project and home slot (no reposition without an explicit drop target)", () => {
    const project = db.createProject(conn, { listId, name: "Q3", color: "blue" }, NOW);
    const task = create("t", { projectId: project.id });
    const before = conn.prepare(`SELECT sort_order FROM tasks WHERE id = ?`).get(task.id) as {
      sort_order: number;
    };

    db.moveTask(conn, { id: task.id, bucket: "today", parentId: null, beforeId: null, afterId: null }, NOW);

    const after = conn
      .prepare(`SELECT bucket, sort_order, project_id, today_order, today_dismissed_day FROM tasks WHERE id = ?`)
      .get(task.id) as {
      bucket: string;
      sort_order: number;
      project_id: string | null;
      today_order: number | null;
      today_dismissed_day: string | null;
    };
    expect(after.bucket).toBe("today");
    expect(after.project_id).toBe(project.id);
    expect(after.sort_order).toBe(before.sort_order); // home slot untouched — no beforeId/afterId given
    expect(after.today_order).toBeNull(); // abandoned column, never written
    expect(after.today_dismissed_day).toBeNull(); // entering Today clears any (nonexistent) prior dismissal
  });

  it("Today row -> Backlog (anywhere): unschedule snaps home to its own slot, ignoring beforeId/afterId, and stamps today_dismissed_day", () => {
    const a = create("a");
    const b = create("b");
    const scheduled = create("scheduled");
    const homeBefore = conn.prepare(`SELECT sort_order, project_id, parent_id FROM tasks WHERE id = ?`).get(
      scheduled.id,
    ) as { sort_order: number; project_id: string | null; parent_id: string | null };

    db.moveTask(conn, { id: scheduled.id, bucket: "today", parentId: null, beforeId: null, afterId: null }, NOW);
    // Unschedule, dropped "between a and b" — snap-home must ignore this.
    db.moveTask(conn, { id: scheduled.id, bucket: "backlog", parentId: null, beforeId: b.id, afterId: a.id }, NOW);

    const row = conn
      .prepare(
        `SELECT bucket, sort_order, project_id, parent_id, today_order, today_dismissed_day FROM tasks WHERE id = ?`,
      )
      .get(scheduled.id) as {
      bucket: string;
      sort_order: number;
      project_id: string | null;
      parent_id: string | null;
      today_order: number | null;
      today_dismissed_day: string | null;
    };
    expect(row.bucket).toBe("backlog");
    expect(row.sort_order).toBe(homeBefore.sort_order); // snapped home, not between a and b
    expect(row.project_id).toBe(homeBefore.project_id);
    expect(row.parent_id).toBe(homeBefore.parent_id);
    expect(row.today_order).toBeNull();
    // Stamped so an overdue-and-scheduled task can't boomerang straight
    // back into Today via TODAY_MEMBERSHIP_SQL the instant bucket flips.
    expect(row.today_dismissed_day).toBe(localDay(NOW));
  });

  it("Today row -> a different project's header: unschedule AND re-home, and still stamps today_dismissed_day", () => {
    const projectA = db.createProject(conn, { listId, name: "A", color: "blue" }, NOW);
    const projectB = db.createProject(conn, { listId, name: "B", color: "red" }, NOW);
    const task = create("t", { projectId: projectA.id });

    db.moveTask(conn, { id: task.id, bucket: "today", parentId: null, beforeId: null, afterId: null }, NOW);
    db.moveTask(
      conn,
      { id: task.id, bucket: "backlog", parentId: null, beforeId: null, afterId: null, projectId: projectB.id },
      NOW,
    );

    const row = conn
      .prepare(`SELECT bucket, project_id, today_order, today_dismissed_day FROM tasks WHERE id = ?`)
      .get(task.id) as {
      bucket: string;
      project_id: string | null;
      today_order: number | null;
      today_dismissed_day: string | null;
    };
    expect(row.bucket).toBe("backlog");
    expect(row.project_id).toBe(projectB.id);
    expect(row.today_order).toBeNull();
    expect(row.today_dismissed_day).toBe(localDay(NOW));
  });

  it("Today row -> Today: reorder writes sort_order directly — Today shares the Backlog's order column now, so this is visible there too", () => {
    const a = create("a");
    const b = create("b");
    db.moveTask(conn, { id: a.id, bucket: "today", parentId: null, beforeId: null, afterId: null }, NOW);
    db.moveTask(conn, { id: b.id, bucket: "today", parentId: null, beforeId: null, afterId: null }, NOW);

    db.moveTask(conn, { id: a.id, bucket: "today", parentId: null, beforeId: b.id, afterId: null }, NOW);

    const aAfter = conn.prepare(`SELECT sort_order, today_order FROM tasks WHERE id = ?`).get(a.id) as {
      sort_order: number;
      today_order: number | null;
    };
    const bRow = conn.prepare(`SELECT sort_order FROM tasks WHERE id = ?`).get(b.id) as { sort_order: number };
    expect(aAfter.sort_order).toBeLessThan(bRow.sort_order);
    expect(aAfter.today_order).toBeNull(); // abandoned column, never written
  });

  it("project task -> another project: re-home writes sort_order only (today_order stays untouched/null)", () => {
    const projectA = db.createProject(conn, { listId, name: "A", color: "blue" }, NOW);
    const projectB = db.createProject(conn, { listId, name: "B", color: "red" }, NOW);
    const task = create("t", { projectId: projectA.id });
    db.moveTask(
      conn,
      { id: task.id, bucket: "backlog", parentId: null, beforeId: null, afterId: null, projectId: projectB.id },
      NOW,
    );
    const row = conn.prepare(`SELECT project_id, today_order FROM tasks WHERE id = ?`).get(task.id) as {
      project_id: string | null;
      today_order: number | null;
    };
    expect(row.project_id).toBe(projectB.id);
    expect(row.today_order).toBeNull();
  });

  it("project task -> loose area: project_id becomes NULL", () => {
    const project = db.createProject(conn, { listId, name: "A", color: "blue" }, NOW);
    const task = create("t", { projectId: project.id });
    db.moveTask(
      conn,
      { id: task.id, bucket: "backlog", parentId: null, beforeId: null, afterId: null, projectId: null },
      NOW,
    );
    const row = conn.prepare(`SELECT project_id FROM tasks WHERE id = ?`).get(task.id) as {
      project_id: string | null;
    };
    expect(row.project_id).toBeNull();
  });

  it("loose task -> project body: files into the project", () => {
    const project = db.createProject(conn, { listId, name: "A", color: "blue" }, NOW);
    const task = create("t");
    db.moveTask(
      conn,
      { id: task.id, bucket: "backlog", parentId: null, beforeId: null, afterId: null, projectId: project.id },
      NOW,
    );
    const row = conn.prepare(`SELECT project_id FROM tasks WHERE id = ?`).get(task.id) as {
      project_id: string | null;
    };
    expect(row.project_id).toBe(project.id);
  });

  it("subtask -> Today: flags scheduled, parent_id kept (the central change)", () => {
    const parent = create("parent");
    const child = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "child",
        parentId: parent.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      },
      NOW,
    );
    db.moveTask(conn, { id: child.id, bucket: "today", parentId: parent.id, beforeId: null, afterId: null }, NOW);
    const row = conn.prepare(`SELECT parent_id, bucket FROM tasks WHERE id = ?`).get(child.id) as {
      parent_id: string | null;
      bucket: string;
    };
    expect(row.parent_id).toBe(parent.id);
    expect(row.bucket).toBe("today");
  });
});

describe("Today dismissal — the boomerang fix", () => {
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  // Named regression test: a task that is BOTH overdue AND manually
  // scheduled must not immediately re-satisfy TODAY_MEMBERSHIP_SQL once
  // it's dragged back out to the Backlog — that's exactly the boomerang
  // moveTask's dismissal stamp exists to prevent.
  it("BOOMERANG: an overdue, manually-scheduled task moved today->backlog does not satisfy Today membership afterwards", () => {
    const overdueMs = new Date(2026, 7, 10, 9, 0, 0).getTime();
    const task = db.createTask(
      conn,
      {
        listId,
        bucket: "today",
        title: "overdue and scheduled",
        parentId: null,
        dueAt: overdueMs,
        hasDueTime: true,
        position: "bottom",
      },
      NOW,
    );

    db.moveTask(conn, { id: task.id, bucket: "backlog", parentId: null, beforeId: null, afterId: null }, NOW);

    const row = conn
      .prepare(`SELECT bucket, day, due_at, today_dismissed_day FROM tasks WHERE id = ?`)
      .get(task.id) as {
      bucket: "backlog" | "today";
      day: string | null;
      due_at: number | null;
      today_dismissed_day: string | null;
    };
    const today = localDay(NOW);
    const startOfTomorrowMs = startOfNextLocalDay(NOW);
    expect(db.isTodayMember(row, today, startOfTomorrowMs)).toBe(false);

    // The board agrees: the row does not render as inToday.
    const board = db.getBoard(conn, listId, NOW);
    const dto = board.backlog.tasks.find((t) => t.id === task.id)!;
    expect(dto.inToday).toBe(false);
  });

  it("entering Today clears an earlier dismissal", () => {
    const overdueMs = new Date(2026, 7, 10, 9, 0, 0).getTime();
    const task = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "overdue", parentId: null, dueAt: overdueMs, hasDueTime: true, position: "bottom" },
      NOW,
    );
    db.dismissFromToday(conn, task.id, NOW);
    let row = conn.prepare(`SELECT today_dismissed_day FROM tasks WHERE id = ?`).get(task.id) as {
      today_dismissed_day: string | null;
    };
    expect(row.today_dismissed_day).toBe(localDay(NOW));

    db.moveTask(conn, { id: task.id, bucket: "today", parentId: null, beforeId: null, afterId: null }, NOW);
    row = conn.prepare(`SELECT today_dismissed_day FROM tasks WHERE id = ?`).get(task.id) as {
      today_dismissed_day: string | null;
    };
    expect(row.today_dismissed_day).toBeNull();
  });
});

describe("dismissFromToday", () => {
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  function createOverdue() {
    return db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "auto-included",
        parentId: null,
        dueAt: new Date(2026, 7, 18, 9, 0, 0).getTime(),
        hasDueTime: true,
        position: "bottom",
      },
      NOW,
    );
  }

  it("writes only today_dismissed_day and updated_at — no other column changes", () => {
    const task = createOverdue();
    const before = conn.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task.id) as Record<string, unknown>;

    db.dismissFromToday(conn, task.id, NOW);

    const after = conn.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task.id) as Record<string, unknown>;
    for (const key of Object.keys(before)) {
      if (key === "today_dismissed_day" || key === "updated_at") continue;
      expect(after[key]).toEqual(before[key]);
    }
    expect(after.today_dismissed_day).toBe(localDay(NOW));
  });

  it("is self-expiring: a dismissal recorded yesterday no longer suppresses membership today", () => {
    const task = createOverdue();
    const yesterday = new Date(2026, 7, 19, 12, 0, 0);
    db.dismissFromToday(conn, task.id, yesterday);

    const board = db.getBoard(conn, listId, NOW); // NOW is 2026-08-20
    const dto = board.backlog.tasks.find((t) => t.id === task.id)!;
    expect(dto.inToday).toBe(true); // a prior day's dismissal is inert today
  });

  it("throws not_found for an unknown id", () => {
    expect(() => db.dismissFromToday(conn, "tsk_missing", NOW)).toThrow(/not_found/);
  });
});

describe("getBoard — ring survives the vanish", () => {
  it("an auto-included (never manually scheduled) task still counts in today.planned after it completes and vanishes from the open backlog", () => {
    const conn = freshDb();
    db.seed(conn, NOW);
    const listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
    const overdue = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "overdue, never scheduled",
        parentId: null,
        dueAt: new Date(2026, 7, 18, 9, 0, 0).getTime(),
        hasDueTime: true,
        position: "bottom",
      },
      NOW,
    );

    const before = db.getBoard(conn, listId, NOW);
    expect(before.backlog.tasks.find((t) => t.id === overdue.id)?.inToday).toBe(true);
    expect(before.today.planned).toBe(1);
    expect(before.today.completed).toBe(0);

    db.completeTask(conn, overdue.id, NOW);

    const dayRow = conn.prepare(`SELECT day FROM tasks WHERE id = ?`).get(overdue.id) as { day: string | null };
    expect(dayRow.day).toBe(localDay(NOW)); // stamped at completion — never written before this

    const after = db.getBoard(conn, listId, NOW);
    expect(after.backlog.tasks.find((t) => t.id === overdue.id)).toBeUndefined(); // vanished (done, no longer open)
    expect(after.today.completed).toBe(1);
    expect(after.today.planned).toBe(1); // denominator survives the vanish
  });
});

describe("TaskDto.inToday drift guard", () => {
  it("board.backlog.tasks' inToday always matches isTodayMember recomputed independently from the raw columns", () => {
    const conn = freshDb();
    db.seed(conn, NOW);
    const listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;

    const manual = db.createTask(
      conn,
      { listId, bucket: "today", title: "manual", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const dismissedOverdue = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "overdue, dismissed today",
        parentId: null,
        dueAt: new Date(2026, 7, 18, 9, 0, 0).getTime(),
        hasDueTime: true,
        position: "bottom",
      },
      NOW,
    );
    db.dismissFromToday(conn, dismissedOverdue.id, NOW);
    const plain = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "plain", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );

    const board = db.getBoard(conn, listId, NOW);
    const today = localDay(NOW);
    const startOfTomorrowMs = startOfNextLocalDay(NOW);
    for (const dto of board.backlog.tasks) {
      const row = conn
        .prepare(`SELECT bucket, day, due_at, today_dismissed_day FROM tasks WHERE id = ?`)
        .get(dto.id) as {
        bucket: "backlog" | "today";
        day: string | null;
        due_at: number | null;
        today_dismissed_day: string | null;
      };
      expect(dto.inToday).toBe(db.isTodayMember(row, today, startOfTomorrowMs));
    }
    expect(board.backlog.tasks.find((t) => t.id === manual.id)?.inToday).toBe(true);
    expect(board.backlog.tasks.find((t) => t.id === dismissedOverdue.id)?.inToday).toBe(false);
    expect(board.backlog.tasks.find((t) => t.id === plain.id)?.inToday).toBe(false);
  });
});

describe("getBoard — comprehensive backlog and trail", () => {
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  it("backlog.tasks is comprehensive: a manually-scheduled task and an auto-included (due-today) task both appear exactly once, undimmed — no ghost concept", () => {
    const project = db.createProject(conn, { listId, name: "Q3", color: "blue" }, NOW);
    const plain = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "plain",
        parentId: null,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
        projectId: project.id,
      },
      NOW,
    );
    const scheduled = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "will be scheduled",
        parentId: null,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
        projectId: project.id,
      },
      NOW,
    );
    db.moveTask(conn, { id: scheduled.id, bucket: "today", parentId: null, beforeId: null, afterId: null }, NOW);
    const dueToday = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "auto-included",
        parentId: null,
        dueAt: new Date(2026, 7, 20, 9, 0, 0).getTime(),
        hasDueTime: true,
        position: "bottom",
      },
      NOW,
    );

    const board = db.getBoard(conn, listId, NOW);
    const ids = board.backlog.tasks.map((t) => t.id);
    expect(new Set(ids)).toEqual(new Set([plain.id, scheduled.id, dueToday.id]));
    expect(ids.length).toBe(3); // exactly once each
    expect(board.backlog.total).toBe(3); // every open top-level row — no ghost-vs-genuine split anymore

    const scheduledDto = board.backlog.tasks.find((t) => t.id === scheduled.id)!;
    expect(scheduledDto.bucket).toBe("today");
    expect(scheduledDto.inToday).toBe(true);

    const dueTodayDto = board.backlog.tasks.find((t) => t.id === dueToday.id)!;
    expect(dueTodayDto.bucket).toBe("backlog"); // never manually scheduled
    expect(dueTodayDto.inToday).toBe(true); // auto-included purely by due date
  });

  it("inToday is true for a subtask scheduled on its own, without scheduling its parent", () => {
    const parent = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "child",
        parentId: parent.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      },
      NOW,
    );
    db.moveTask(conn, { id: child.id, bucket: "today", parentId: parent.id, beforeId: null, afterId: null }, NOW);

    const board = db.getBoard(conn, listId, NOW);
    const parentDto = board.backlog.tasks.find((t) => t.id === parent.id)!;
    expect(parentDto.inToday).toBe(false); // scheduling the subtask did not schedule the parent
    const childDto = parentDto.subtasks.find((t) => t.id === child.id)!;
    expect(childDto.inToday).toBe(true);
    expect(childDto.bucket).toBe("today");
  });

  it("trail is null for a loose top-level task, and populated with project name/color and parent title otherwise", () => {
    const project = db.createProject(conn, { listId, name: "Q3 Launch", color: "violet" }, NOW);
    const loose = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "loose", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const parent = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "Rewrite the onboarding email",
        parentId: null,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
        projectId: project.id,
      },
      NOW,
    );
    const child = db.createTask(
      conn,
      {
        listId,
        bucket: "backlog",
        title: "Get legal sign-off",
        parentId: parent.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      },
      NOW,
    );
    db.moveTask(conn, { id: child.id, bucket: "today", parentId: parent.id, beforeId: null, afterId: null }, NOW);

    const board = db.getBoard(conn, listId, NOW);
    const looseDto = board.backlog.tasks.find((t) => t.id === loose.id)!;
    expect(looseDto.trail).toBeNull();

    const parentDto = board.backlog.tasks.find((t) => t.id === parent.id)!;
    const childDto = parentDto.subtasks.find((t) => t.id === child.id)!;
    expect(childDto.trail).toEqual({
      projectId: project.id,
      projectName: "Q3 Launch",
      projectColor: "violet",
      parentId: parent.id,
      parentTitle: "Rewrite the onboarding email",
    });
  });
});

describe("getArchive grouping", () => {
  it("groups by the local day of completed_at, newest first", () => {
    const conn = freshDb();
    db.seed(conn, NOW);
    const listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;

    const dayOneTask = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "day1", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const dayTwoTask = db.createTask(
      conn,
      { listId, bucket: "backlog", title: "day2", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );

    const earlier = new Date(2026, 7, 18, 10, 0, 0);
    const later = new Date(2026, 7, 19, 10, 0, 0);
    db.completeTask(conn, dayOneTask.id, earlier);
    db.completeTask(conn, dayTwoTask.id, later);

    const archive = db.getArchive(conn, listId, 100, 0, NOW);
    expect(archive.total).toBe(2);
    expect(archive.groups.map((g) => g.day)).toEqual(["2026-08-19", "2026-08-18"]);
    expect(archive.groups[0].tasks[0].id).toBe(dayTwoTask.id);
  });
});
