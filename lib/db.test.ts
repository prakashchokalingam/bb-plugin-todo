import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "./db.js";

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
        { listId, stage: "pending", title: "   ", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
        NOW,
      ),
    ).toThrow(/invalid_input/);
  });

  it("rejects a parentId that is itself a subtask", () => {
    const parent = db.createTask(
      conn,
      { listId, stage: "pending", title: "Parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child = db.createTask(
      conn,
      { listId, stage: "pending", title: "Child", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    expect(() =>
      db.createTask(
        conn,
        { listId, stage: "pending", title: "Grandchild", parentId: child.id, dueAt: null, hasDueTime: false, position: "bottom" },
        NOW,
      ),
    ).toThrow(/invalid_input/);
  });

  it("mirrors the parent's stage and carried-days clock onto a new subtask", () => {
    const parent = db.createTask(
      conn,
      { listId, stage: "in_progress", title: "Parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child = db.createTask(
      conn,
      { listId, stage: "pending", title: "Child", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    expect(child.stage).toBe("in_progress");
    expect(child.carriedDays).toBe(parent.carriedDays);
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

  function create(title: string, stage: "pending" | "in_progress" = "pending") {
    return db.createTask(
      conn,
      { listId, stage, title, parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
  }

  it("rejects a move that would create a cycle", () => {
    const a = create("A");
    const b = create("B");
    db.moveTask(conn, { id: b.id, stage: "pending", parentId: a.id, beforeId: null, afterId: null }, NOW);
    // b is now a's child; making a a child of b would be a 2-cycle.
    expect(() =>
      db.moveTask(conn, { id: a.id, stage: "pending", parentId: b.id, beforeId: null, afterId: null }, NOW),
    ).toThrow(/cycle/);
  });

  it("rejects a move creating depth > 1", () => {
    const a = create("A");
    const b = create("B");
    const c = create("C");
    db.moveTask(conn, { id: b.id, stage: "pending", parentId: a.id, beforeId: null, afterId: null }, NOW);
    // b is already a subtask; nesting c under b would be depth 2.
    expect(() =>
      db.moveTask(conn, { id: c.id, stage: "pending", parentId: b.id, beforeId: null, afterId: null }, NOW),
    ).toThrow(/depth/);
  });

  it("promotes a task's own children to top-level siblings right after it", () => {
    const a = create("A");
    const b = create("B");
    const child1 = db.createTask(
      conn,
      { listId, stage: "pending", title: "child1", parentId: a.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child2 = db.createTask(
      conn,
      { listId, stage: "pending", title: "child2", parentId: a.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );

    // Drop A onto B: A becomes a subtask of B, and A's own children (child1,
    // child2) are promoted to top-level, placed right after A in order.
    db.moveTask(conn, { id: a.id, stage: "pending", parentId: b.id, beforeId: null, afterId: null }, NOW);

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
      { listId, stage: "pending", title: "child", parentId: a.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.moveTask(conn, { id: child.id, stage: "in_progress", parentId: null, beforeId: null, afterId: null }, NOW);
    const row = conn.prepare(`SELECT parent_id, stage, in_progress_since FROM tasks WHERE id = ?`).get(child.id) as {
      parent_id: string | null;
      stage: string;
      in_progress_since: number | null;
    };
    expect(row.parent_id).toBeNull();
    expect(row.stage).toBe("in_progress");
    expect(row.in_progress_since).not.toBeNull();
  });

  it("rebalances the sibling group when the fractional gap collapses", () => {
    const a = create("A");
    const b = create("B");
    // Repeatedly insert between a and b until the gap collapses below the
    // threshold and moveTask has to rebalance.
    let lastId = a.id;
    for (let i = 0; i < 20; i++) {
      const t = create(`mid${i}`);
      db.moveTask(conn, { id: t.id, stage: "pending", parentId: null, beforeId: b.id, afterId: lastId }, NOW);
      lastId = t.id;
    }
    const orders = (
      conn
        .prepare(`SELECT sort_order FROM tasks WHERE list_id = ? AND stage = 'pending' ORDER BY sort_order`)
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
      { listId, stage: "in_progress", title: "Parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child1 = db.createTask(
      conn,
      { listId, stage: "in_progress", title: "c1", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child2 = db.createTask(
      conn,
      { listId, stage: "in_progress", title: "c2", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
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

  it("inProgress's planned/completed count top-level rows and subtasks, and survive completion vanishing them", () => {
    const parent = db.createTask(
      conn,
      { listId, stage: "in_progress", title: "Parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.createTask(
      conn,
      { listId, stage: "in_progress", title: "c1", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    db.completeTask(conn, parent.id, NOW);

    const board = db.getBoard(conn, listId, NOW);
    expect(board.inProgress.planned).toBe(2); // parent + subtask, both stage='in_progress'
    expect(board.inProgress.completed).toBe(2);
    // Both rows are done, so they vanish from the open backlog entirely —
    // there's no separate In Progress-only tasks list to vanish from anymore.
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
      { listId: first.id, stage: "pending", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
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
      { listId, stage: "pending", title: "open", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const done = db.createTask(
      conn,
      { listId, stage: "pending", title: "done", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
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
      { listId, stage: "pending", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
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
      { listId, stage: "pending", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
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
      { listId, stage: "pending", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
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
      { listId, stage: "pending", title: "untagged", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const parent = db.createTask(
      conn,
      { listId, stage: "pending", title: "parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child = db.createTask(
      conn,
      { listId, stage: "pending", title: "child", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
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
      { listId, stage: "pending", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
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
      { listId, stage: "pending", title: "parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child = db.createTask(
      conn,
      { listId, stage: "pending", title: "child", parentId: parent.id, dueAt: null, hasDueTime: false, position: "bottom" },
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

    // The actual upgrade path: apply migrations 10-15 on top. Bounded at
    // 18 (exclusive) so this stays a test of exactly migrations 10-17 as the
    // array grows — migration 18 renames today_order away entirely, which
    // would break this test's own assertions below if it crept in.
    for (const stmt of db.MIGRATIONS.slice(10, 18)) conn.exec(stmt);

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
    // Bounded at 18 (exclusive), like the other tests in this block — a
    // fully-migrated freshDb() no longer has a `today_dismissed_day`
    // column at all (migration 18 renames it to `dismissed_day`); this
    // test is specifically about migration 16's own shape.
    const conn = new Database(":memory:");
    conn.pragma("foreign_keys = ON");
    for (const stmt of db.MIGRATIONS.slice(0, 18)) conn.exec(stmt);
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

    // The actual upgrade path: apply migration 16 on top of the legacy
    // fixture. Bounded at 18 (exclusive) — see the migration-15 test's
    // comment above for why.
    for (const stmt of db.MIGRATIONS.slice(16, 18)) conn.exec(stmt);

    const row = conn
      .prepare(`SELECT sort_order, today_order, today_dismissed_day FROM tasks WHERE id = 'tsk_today'`)
      .get() as { sort_order: number; today_order: number | null; today_dismissed_day: string | null };
    // The additive migration touches nothing that already existed.
    expect(row.sort_order).toBe(4242.5);
    expect(row.today_order).toBe(4242.5);
    expect(row.today_dismissed_day).toBeNull();
  });

  it("migration 17 applies cleanly against a pre-17 fixture and defaults existing projects to Today-expanded", () => {
    const conn = new Database(":memory:");
    conn.pragma("foreign_keys = ON");
    // Fixture: the schema exactly as it shipped before this migration
    // (statements 0-16) — mirrors the pre-16 fixture pattern above. A
    // pre-existing project is collapsed in the Backlog (its only collapse
    // bit at the time) to prove migration 17 doesn't disturb it.
    for (const stmt of db.MIGRATIONS.slice(0, 17)) conn.exec(stmt);
    conn.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES ('lst_1', 'Work', 1000, 0)`).run();
    conn
      .prepare(
        `INSERT INTO projects (id, list_id, name, color, collapsed, sort_order, created_at)
         VALUES ('prj_legacy', 'lst_1', 'Legacy project', 'blue', 1, 1000, 0)`,
      )
      .run();

    // The actual upgrade path: apply migration 17 on top of the legacy
    // fixture. Bounded at 18 (exclusive) — see the migration-15 test's
    // comment above for why.
    for (const stmt of db.MIGRATIONS.slice(17, 18)) conn.exec(stmt);

    const row = conn.prepare(`SELECT collapsed, today_collapsed FROM projects WHERE id = 'prj_legacy'`).get() as {
      collapsed: number;
      today_collapsed: number;
    };
    // The additive migration touches nothing that already existed...
    expect(row.collapsed).toBe(1);
    // ...and every existing project defaults to expanded in the column it
    // never had an opinion about.
    expect(row.today_collapsed).toBe(0);
  });
});

describe("migration 18/19 — bucket/today_order/today_dismissed_day/today_collapsed rename", () => {
  it("rebuilds `tasks` and renames `projects.today_collapsed` with zero data loss, correct stage mapping, task_tags intact, and every index recreated", () => {
    const conn = new Database(":memory:");
    conn.pragma("foreign_keys = ON");
    // Fixture: the schema exactly as it shipped before this migration
    // (statements 0-17) — a manually-scheduled ("today") top-level task
    // with a tagged subtask, a plain backlog task, and a collapsed
    // project, all wired up with task_tags rows. Applying 18/19 on top is
    // the real upgrade path every existing installation goes through.
    for (const stmt of db.MIGRATIONS.slice(0, 18)) conn.exec(stmt);

    conn.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES ('lst_1', 'Work', 1000, 0)`).run();
    conn
      .prepare(
        `INSERT INTO projects (id, list_id, name, color, collapsed, today_collapsed, sort_order, created_at)
         VALUES ('prj_1', 'lst_1', 'Q3', 'blue', 1, 1, 1000, 0)`,
      )
      .run();
    conn.prepare(`INSERT INTO tags (id, name, color, sort_order, created_at) VALUES ('tag_1', 'urgent', 'red', 1000, 0)`).run();
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, project_id, created_at, updated_at)
         VALUES ('tsk_today', 'lst_1', NULL, 'today task', NULL, 'today', '2026-08-20', 1000, NULL, 0, 'open', NULL, 0, 'prj_1', 0, 0)`,
      )
      .run();
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, project_id, created_at, updated_at)
         VALUES ('tsk_backlog', 'lst_1', NULL, 'backlog task', NULL, 'backlog', NULL, 2000, NULL, 0, 'open', NULL, 0, NULL, 0, 0)`,
      )
      .run();
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, project_id, created_at, updated_at)
         VALUES ('tsk_sub', 'lst_1', 'tsk_today', 'subtask', NULL, 'today', '2026-08-20', 3000, NULL, 0, 'open', NULL, 0, 'prj_1', 0, 0)`,
      )
      .run();
    conn.exec(`INSERT INTO task_tags (task_id, tag_id) VALUES ('tsk_today', 'tag_1')`);
    conn.exec(`INSERT INTO task_tags (task_id, tag_id) VALUES ('tsk_backlog', 'tag_1')`);
    conn.exec(`INSERT INTO task_tags (task_id, tag_id) VALUES ('tsk_sub', 'tag_1')`);

    // The real upgrade path: apply migrations 18-19 on top of the legacy
    // fixture, wrapped in one transaction — exactly how bb.storage.migrate
    // actually runs the whole array in production (server.ts sets
    // `foreign_keys = ON` before calling it, and PRAGMA foreign_keys is a
    // documented no-op inside an open transaction, so there is no point
    // where it could be switched off mid-migration). This is the
    // worst-case, most-constrained scenario for the FK-cascade risk
    // migration 18's comment describes — proving it here proves it for
    // the real migration runner too.
    conn.transaction(() => {
      for (const stmt of db.MIGRATIONS.slice(18, 20)) conn.exec(stmt);
    })();

    const tasks = conn
      .prepare(`SELECT id, stage, project_id, parent_id FROM tasks ORDER BY id`)
      .all() as { id: string; stage: string; project_id: string | null; parent_id: string | null }[];
    expect(tasks).toEqual([
      { id: "tsk_backlog", stage: "pending", project_id: null, parent_id: null },
      { id: "tsk_sub", stage: "in_progress", project_id: "prj_1", parent_id: "tsk_today" },
      { id: "tsk_today", stage: "in_progress", project_id: "prj_1", parent_id: null },
    ]);

    // No task_tags row lost — this is the FK-cascade risk migration 18's
    // comment walks through: a naive `DROP TABLE tasks` under
    // `foreign_keys = ON` would have silently wiped every one of these.
    const taskTags = conn.prepare(`SELECT task_id, tag_id FROM task_tags ORDER BY task_id`).all();
    expect(taskTags).toEqual([
      { task_id: "tsk_backlog", tag_id: "tag_1" },
      { task_id: "tsk_sub", tag_id: "tag_1" },
      { task_id: "tsk_today", tag_id: "tag_1" },
    ]);

    expect(conn.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);

    const project = conn
      .prepare(`SELECT collapsed, in_progress_collapsed FROM projects WHERE id = 'prj_1'`)
      .get() as { collapsed: number; in_progress_collapsed: number };
    expect(project.collapsed).toBe(1);
    expect(project.in_progress_collapsed).toBe(1); // renamed in place, value preserved

    const indexNames = (
      conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('tasks', 'task_tags')`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const expected of [
      "tasks_board_idx",
      "tasks_archive_idx",
      "tasks_due_idx",
      "tasks_parent_idx",
      "tasks_project_idx",
      "task_tags_tag_idx",
    ]) {
      expect(indexNames).toContain(expected);
    }

    // SQLite can't ALTER a CHECK constraint in place — this is *why*
    // migration 18 is a full rebuild rather than a rename — so prove the
    // rebuilt table actually carries the new constraint.
    expect(() =>
      conn
        .prepare(
          `INSERT INTO tasks (id, list_id, parent_id, title, notes, stage, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
           VALUES ('tsk_bad', 'lst_1', NULL, 'x', NULL, 'bogus', NULL, 9000, NULL, 0, 'open', NULL, 0, 0, 0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("survives a child row scanned before its parent — the INSERT...SELECT's ORDER BY isn't load-bearing for correctness (SQLite checks an immediate self-referential FK at end-of-statement, not per row) but this pins the safety net regardless", () => {
    const conn = new Database(":memory:");
    conn.pragma("foreign_keys = ON");
    for (const stmt of db.MIGRATIONS.slice(0, 18)) conn.exec(stmt);
    conn.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES ('lst_1', 'Work', 1000, 0)`).run();

    // `tasks.parent_id` already carries a live, immediate FK on the pre-18
    // table too (migration 1), so a child literally cannot be *inserted*
    // before a parent that doesn't exist yet — the app's own invariants
    // (a subtask's parent always exists first) guarantee that in practice.
    // To still construct a genuine "child scanned before parent" table
    // order without violating that FK, insert the parent first (so the
    // FK is satisfied) but pin it to a HIGH explicit rowid, then insert
    // the child second with a LOW explicit rowid — legal (SQLite lets you
    // assign the hidden rowid explicitly via the `rowid` pseudo-column),
    // and it reproduces the adversarial scan order this test is for.
    conn
      .prepare(
        `INSERT INTO tasks (rowid, id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
         VALUES (100, 'tsk_parent', 'lst_1', NULL, 'parent', NULL, 'today', '2026-08-20', 1000, NULL, 0, 'open', NULL, 0, 0, 0)`,
      )
      .run();
    conn
      .prepare(
        `INSERT INTO tasks (rowid, id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
         VALUES (1, 'tsk_child', 'lst_1', 'tsk_parent', 'child', NULL, 'backlog', NULL, 2000, NULL, 0, 'open', NULL, 0, 0, 0)`,
      )
      .run();
    expect((conn.prepare(`SELECT id FROM tasks`).all() as { id: string }[]).map((r) => r.id)).toEqual([
      "tsk_child",
      "tsk_parent",
    ]); // rowid order confirms the adversarial scan order is actually in play

    expect(() =>
      conn.transaction(() => {
        for (const stmt of db.MIGRATIONS.slice(18, 20)) conn.exec(stmt);
      })(),
    ).not.toThrow();

    const rows = conn.prepare(`SELECT id, parent_id, stage FROM tasks ORDER BY id`).all();
    expect(rows).toEqual([
      { id: "tsk_child", parent_id: "tsk_parent", stage: "pending" },
      { id: "tsk_parent", parent_id: null, stage: "in_progress" },
    ]);
    expect(conn.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });
});

describe("migration 20 — drop day/in_progress_order/dismissed_day, add in_progress_since", () => {
  it("drops day/in_progress_order/dismissed_day and adds a nullable in_progress_since on a fresh db", () => {
    const conn = freshDb();
    const cols = conn.prepare(`PRAGMA table_info(tasks)`).all() as { name: string; notnull: number }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain("day");
    expect(colNames).not.toContain("in_progress_order");
    expect(colNames).not.toContain("dismissed_day");
    const since = cols.find((c) => c.name === "in_progress_since");
    expect(since).toBeDefined();
    expect(since?.notnull).toBe(0);
  });

  it("backfills in_progress_since from carried_count so an existing carried streak is preserved as carried days", () => {
    const conn = new Database(":memory:");
    conn.pragma("foreign_keys = ON");
    // Fixture: the schema exactly as it shipped before this migration
    // (statements 0-19) — an open, manually-in-progress task already
    // carried forward 6 times by the old rollover mechanic, a done
    // in-progress task (should NOT be backfilled — it's not open), and a
    // plain pending task (should NOT be backfilled — never in progress).
    for (const stmt of db.MIGRATIONS.slice(0, 20)) conn.exec(stmt);
    conn.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES ('lst_1', 'Work', 1000, 0)`).run();
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, stage, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
         VALUES ('tsk_carried', 'lst_1', NULL, 'carried', NULL, 'in_progress', '2026-08-20', 1000, NULL, 0, 'open', NULL, 6, 0, 0)`,
      )
      .run();
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, stage, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
         VALUES ('tsk_done', 'lst_1', NULL, 'done', NULL, 'in_progress', '2026-08-20', 2000, NULL, 0, 'done', 0, 3, 0, 0)`,
      )
      .run();
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, stage, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
         VALUES ('tsk_pending', 'lst_1', NULL, 'pending', NULL, 'pending', NULL, 3000, NULL, 0, 'open', NULL, 0, 0, 0)`,
      )
      .run();

    conn.exec(db.MIGRATIONS[20]);

    const rows = conn.prepare(`SELECT id, in_progress_since FROM tasks ORDER BY id`).all() as {
      id: string;
      in_progress_since: number | null;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r.in_progress_since]));

    const nowMs = Date.now();
    const carried = byId.get("tsk_carried") as number;
    // ~6 days before "now" (the migration's own strftime('now'), not test
    // NOW) — assert within a generous tolerance rather than an exact value.
    expect(nowMs - carried).toBeGreaterThan(6 * 86400000 - 60000);
    expect(nowMs - carried).toBeLessThan(6 * 86400000 + 60000);

    expect(byId.get("tsk_done")).toBeNull(); // not open — untouched
    expect(byId.get("tsk_pending")).toBeNull(); // never in progress — untouched
  });
});

describe("IN_PROGRESS_MEMBERSHIP_SQL / isInProgressMember agreement (drift guard)", () => {
  // "Today" is gone entirely: membership is now SOLELY `stage =
  // 'in_progress'`, with no bound parameters and no due-date/dismissal
  // arithmetic at all. This is the load-bearing regression test for that:
  // an open, overdue, `stage = 'pending'` task must be ABSENT from In
  // Progress — the exact case the old due-date auto-inclusion used to flip
  // to `true`.
  type FixtureRow = { id: string; stage: "pending" | "in_progress"; due_at: number | null };

  const dueOverdue = new Date(2026, 7, 18, 9, 0, 0).getTime(); // well before NOW, still open

  const rows: FixtureRow[] = [
    { id: "in_progress_no_due", stage: "in_progress", due_at: null },
    { id: "in_progress_overdue", stage: "in_progress", due_at: dueOverdue },
    { id: "pending_no_due", stage: "pending", due_at: null },
    { id: "pending_overdue", stage: "pending", due_at: dueOverdue },
  ];

  function fixtureDb(): Database.Database {
    const conn = freshDb();
    conn.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES ('lst_1', 'Work', 1000, 0)`).run();
    const insert = conn.prepare(
      `INSERT INTO tasks (id, list_id, parent_id, title, notes, stage, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
       VALUES (?, 'lst_1', NULL, ?, NULL, ?, 1000, ?, 0, 'open', NULL, 0, 0, 0)`,
    );
    for (const r of rows) insert.run(r.id, r.id, r.stage, r.due_at);
    return conn;
  }

  it("SQL and TS agree on every hand-built row: a due date never grants membership, only stage does", () => {
    const conn = fixtureDb();
    const sqlIds = new Set(
      (conn.prepare(`SELECT id FROM tasks WHERE ${db.IN_PROGRESS_MEMBERSHIP_SQL}`).all() as { id: string }[]).map(
        (r) => r.id,
      ),
    );
    const tsIds = new Set(rows.filter((r) => db.isInProgressMember(r)).map((r) => r.id));

    expect(sqlIds).toEqual(tsIds);
    expect([...sqlIds].sort()).toEqual(["in_progress_no_due", "in_progress_overdue"].sort());
    // The regression this whole block exists to pin: an open, overdue,
    // stage='pending' task is absent from In Progress, due date or not.
    expect(sqlIds.has("pending_overdue")).toBe(false);
    expect(sqlIds.has("pending_no_due")).toBe(false);
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
  it("is the only code path that assigns tasks.sort_order or tasks.in_progress_order (risk mitigation from the design doc, made structurally true)", () => {
    const src = readFileSync(fileURLToPath(new URL("./db.ts", import.meta.url)), "utf8");
    const codeOnly = src.slice(src.indexOf("interface TaskRow")); // past the MIGRATIONS SQL text
    const updateStatements = codeOnly.match(/UPDATE tasks SET[^`]*/g) ?? [];
    expect(updateStatements.length).toBeGreaterThan(5); // sanity: the scan actually found statements
    for (const stmt of updateStatements) {
      if (stmt.includes("${column}")) continue; // writeOrder's own statement
      expect(stmt).not.toMatch(/\bsort_order\b/);
      expect(stmt).not.toMatch(/\bin_progress_order\b/);
    }
  });

  // Phase 2 (migration 20): `in_progress_order` (formerly `today_order`),
  // which was already abandoned (nothing read or wrote it), is now DROPPED
  // from the schema entirely, along with `day` and `dismissed_day` — all
  // three were meaningless once due dates stopped being able to grant In
  // Progress membership. `carried_count` is the one column deliberately
  // KEPT as a read-only escape hatch; `in_progress_since` is its
  // replacement, derived into `carriedDays` at read time.
  it("writeOrder never writes in_progress_order anywhere in db.ts, and day/in_progress_order/dismissed_day no longer exist in the schema", () => {
    const src = readFileSync(fileURLToPath(new URL("./db.ts", import.meta.url)), "utf8");
    const codeOnly = src.slice(src.indexOf("interface TaskRow"));
    const callSites = codeOnly.match(/writeOrder\([^):]*,\s*"in_progress_order"/g) ?? [];
    expect(callSites.length).toBe(0);

    const conn = freshDb();
    const cols = conn.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain("in_progress_order");
    expect(colNames).not.toContain("day");
    expect(colNames).not.toContain("dismissed_day");
    expect(colNames).toContain("in_progress_since");
    expect(colNames).toContain("carried_count"); // read-only escape hatch, kept for one release
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
        stage: "pending",
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
        stage: "pending",
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
    db.setProjectCollapsed(conn, project.id, true, "backlog");
    const board = db.getBoard(conn, listId, NOW);
    expect(board.projects.find((p) => p.id === project.id)?.collapsed).toBe(true);
  });

  // Regression: collapse state must be independent per column. Before
  // migration 17, both columns rendered the same single `collapsed` bit, so
  // toggling one column's chevron silently toggled the other. `column`
  // must route the write to exactly one of `collapsed` / `in_progress_collapsed`,
  // never both.
  it("setProjectCollapsed writes only the given column's collapse bit, leaving the other untouched", () => {
    const project = db.createProject(conn, { listId, name: "Q3 Launch", color: "blue" }, NOW);
    expect(project.collapsed).toBe(false);
    expect(project.inProgressCollapsed).toBe(false);

    db.setProjectCollapsed(conn, project.id, true, "in_progress");
    let board = db.getBoard(conn, listId, NOW);
    let found = board.projects.find((p) => p.id === project.id);
    expect(found?.inProgressCollapsed).toBe(true);
    expect(found?.collapsed).toBe(false); // backlog's bit is untouched

    db.setProjectCollapsed(conn, project.id, true, "backlog");
    board = db.getBoard(conn, listId, NOW);
    found = board.projects.find((p) => p.id === project.id);
    expect(found?.collapsed).toBe(true);
    expect(found?.inProgressCollapsed).toBe(true); // still true from the prior call, not flipped back

    db.setProjectCollapsed(conn, project.id, false, "in_progress");
    board = db.getBoard(conn, listId, NOW);
    found = board.projects.find((p) => p.id === project.id);
    expect(found?.inProgressCollapsed).toBe(false);
    expect(found?.collapsed).toBe(true); // backlog's bit is still untouched by the in-progress write
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
        stage: "pending",
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
      db.moveTask(conn, { id: child.id, stage: "pending", parentId: null, beforeId: null, afterId: null }, NOW),
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
        stage: "pending",
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
        stage: "pending",
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
      { id: looseTask.id, stage: "pending", parentId: parentInB.id, beforeId: null, afterId: null },
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
        stage: "pending",
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
      { id: parent.id, stage: "pending", parentId: null, beforeId: null, afterId: null, projectId: projectB.id },
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
          stage: "pending",
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
        { id: task.id, stage: "pending", parentId: null, beforeId: null, afterId: null, projectId: otherProject.id },
        NOW,
      ),
    ).toThrow(/invalid_input/);
  });

  it("invariant 4: scheduling a subtask into In Progress does not schedule its parent, and scheduling a parent does not drag its subtasks along", () => {
    const parent = create("parent");
    const child = db.createTask(
      conn,
      {
        listId,
        stage: "pending",
        title: "child",
        parentId: parent.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      },
      NOW,
    );

    db.moveTask(conn, { id: child.id, stage: "in_progress", parentId: parent.id, beforeId: null, afterId: null }, NOW);
    const parentAfterChildScheduled = conn.prepare(`SELECT stage FROM tasks WHERE id = ?`).get(parent.id) as {
      stage: string;
    };
    expect(parentAfterChildScheduled.stage).toBe("pending"); // parent untouched
    const childRow = conn.prepare(`SELECT stage, parent_id FROM tasks WHERE id = ?`).get(child.id) as {
      stage: string;
      parent_id: string | null;
    };
    expect(childRow.stage).toBe("in_progress");
    expect(childRow.parent_id).toBe(parent.id); // the central change: parent_id survives

    // Reset, then schedule the parent instead.
    db.moveTask(conn, { id: child.id, stage: "pending", parentId: parent.id, beforeId: null, afterId: null }, NOW);
    db.moveTask(conn, { id: parent.id, stage: "in_progress", parentId: null, beforeId: null, afterId: null }, NOW);
    const childAfterParentScheduled = conn.prepare(`SELECT stage FROM tasks WHERE id = ?`).get(child.id) as {
      stage: string;
    };
    expect(childAfterParentScheduled.stage).toBe("pending"); // subtask not dragged along
  });

  it("invariant 5 (revised — Phase 2): in_progress_since starts the carried-days clock on entry and RESETS to NULL on park", () => {
    const task = create("t");
    let row = conn.prepare(`SELECT stage, in_progress_since FROM tasks WHERE id = ?`).get(task.id) as {
      stage: string;
      in_progress_since: number | null;
    };
    expect(row.stage).toBe("pending");
    expect(row.in_progress_since).toBeNull();

    db.moveTask(conn, { id: task.id, stage: "in_progress", parentId: null, beforeId: null, afterId: null }, NOW);
    row = conn.prepare(`SELECT stage, in_progress_since FROM tasks WHERE id = ?`).get(task.id) as {
      stage: string;
      in_progress_since: number | null;
    };
    expect(row.stage).toBe("in_progress");
    expect(row.in_progress_since).toBe(NOW.getTime());

    // Parking clears the clock back to NULL — the counter resets, it does
    // not pause and resume.
    db.moveTask(conn, { id: task.id, stage: "pending", parentId: null, beforeId: null, afterId: null }, NOW);
    row = conn.prepare(`SELECT stage, in_progress_since FROM tasks WHERE id = ?`).get(task.id) as {
      stage: string;
      in_progress_since: number | null;
    };
    expect(row.stage).toBe("pending");
    expect(row.in_progress_since).toBeNull();

    // Restarting days later starts the clock fresh from "now", not from
    // wherever it left off.
    const later = new Date(NOW.getTime() + 3 * 86400000);
    db.moveTask(conn, { id: task.id, stage: "in_progress", parentId: null, beforeId: null, afterId: null }, later);
    row = conn.prepare(`SELECT stage, in_progress_since FROM tasks WHERE id = ?`).get(task.id) as {
      stage: string;
      in_progress_since: number | null;
    };
    expect(row.in_progress_since).toBe(later.getTime());
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
        stage: "pending",
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

  it("project task -> In Progress: flags scheduled, keeps its project and home slot (no reposition without an explicit drop target)", () => {
    const project = db.createProject(conn, { listId, name: "Q3", color: "blue" }, NOW);
    const task = create("t", { projectId: project.id });
    const before = conn.prepare(`SELECT sort_order FROM tasks WHERE id = ?`).get(task.id) as {
      sort_order: number;
    };

    db.moveTask(conn, { id: task.id, stage: "in_progress", parentId: null, beforeId: null, afterId: null }, NOW);

    const after = conn
      .prepare(`SELECT stage, sort_order, project_id, in_progress_since FROM tasks WHERE id = ?`)
      .get(task.id) as {
      stage: string;
      sort_order: number;
      project_id: string | null;
      in_progress_since: number | null;
    };
    expect(after.stage).toBe("in_progress");
    expect(after.project_id).toBe(project.id);
    expect(after.sort_order).toBe(before.sort_order); // home slot untouched — no beforeId/afterId given
    expect(after.in_progress_since).toBe(NOW.getTime()); // carried-days clock starts on entry
  });

  it("In Progress row -> Backlog (anywhere): unschedule snaps home to its own slot, ignoring beforeId/afterId, and clears in_progress_since", () => {
    const a = create("a");
    const b = create("b");
    const scheduled = create("scheduled");
    const homeBefore = conn.prepare(`SELECT sort_order, project_id, parent_id FROM tasks WHERE id = ?`).get(
      scheduled.id,
    ) as { sort_order: number; project_id: string | null; parent_id: string | null };

    db.moveTask(conn, { id: scheduled.id, stage: "in_progress", parentId: null, beforeId: null, afterId: null }, NOW);
    // Unschedule, dropped "between a and b" — snap-home must ignore this.
    db.moveTask(conn, { id: scheduled.id, stage: "pending", parentId: null, beforeId: b.id, afterId: a.id }, NOW);

    const row = conn
      .prepare(`SELECT stage, sort_order, project_id, parent_id, in_progress_since FROM tasks WHERE id = ?`)
      .get(scheduled.id) as {
      stage: string;
      sort_order: number;
      project_id: string | null;
      parent_id: string | null;
      in_progress_since: number | null;
    };
    expect(row.stage).toBe("pending");
    expect(row.sort_order).toBe(homeBefore.sort_order); // snapped home, not between a and b
    expect(row.project_id).toBe(homeBefore.project_id);
    expect(row.parent_id).toBe(homeBefore.parent_id);
    // The carried-days clock resets on park — this row must start from 0
    // again if it's ever restarted, not resume from where it left off.
    expect(row.in_progress_since).toBeNull();
  });

  it("In Progress row -> a different project's header: unschedule AND re-home, and still clears in_progress_since", () => {
    const projectA = db.createProject(conn, { listId, name: "A", color: "blue" }, NOW);
    const projectB = db.createProject(conn, { listId, name: "B", color: "red" }, NOW);
    const task = create("t", { projectId: projectA.id });

    db.moveTask(conn, { id: task.id, stage: "in_progress", parentId: null, beforeId: null, afterId: null }, NOW);
    db.moveTask(
      conn,
      { id: task.id, stage: "pending", parentId: null, beforeId: null, afterId: null, projectId: projectB.id },
      NOW,
    );

    const row = conn.prepare(`SELECT stage, project_id, in_progress_since FROM tasks WHERE id = ?`).get(task.id) as {
      stage: string;
      project_id: string | null;
      in_progress_since: number | null;
    };
    expect(row.stage).toBe("pending");
    expect(row.project_id).toBe(projectB.id);
    expect(row.in_progress_since).toBeNull();
  });

  it("In Progress row -> In Progress: reorder writes sort_order directly — In Progress shares the Backlog's order column now, so this is visible there too", () => {
    const a = create("a");
    const b = create("b");
    db.moveTask(conn, { id: a.id, stage: "in_progress", parentId: null, beforeId: null, afterId: null }, NOW);
    db.moveTask(conn, { id: b.id, stage: "in_progress", parentId: null, beforeId: null, afterId: null }, NOW);

    db.moveTask(conn, { id: a.id, stage: "in_progress", parentId: null, beforeId: b.id, afterId: null }, NOW);

    const aAfter = conn.prepare(`SELECT sort_order, in_progress_since FROM tasks WHERE id = ?`).get(a.id) as {
      sort_order: number;
      in_progress_since: number | null;
    };
    const bRow = conn.prepare(`SELECT sort_order FROM tasks WHERE id = ?`).get(b.id) as { sort_order: number };
    expect(aAfter.sort_order).toBeLessThan(bRow.sort_order);
    // Reordering within the same stage is not a flip, so the clock is
    // untouched, not restamped.
    expect(aAfter.in_progress_since).toBe(NOW.getTime());
  });

  it("project task -> another project (no stage change): re-home writes sort_order only, in_progress_since untouched", () => {
    const projectA = db.createProject(conn, { listId, name: "A", color: "blue" }, NOW);
    const projectB = db.createProject(conn, { listId, name: "B", color: "red" }, NOW);
    const task = create("t", { projectId: projectA.id });
    db.moveTask(
      conn,
      { id: task.id, stage: "pending", parentId: null, beforeId: null, afterId: null, projectId: projectB.id },
      NOW,
    );
    const row = conn.prepare(`SELECT project_id, in_progress_since FROM tasks WHERE id = ?`).get(task.id) as {
      project_id: string | null;
      in_progress_since: number | null;
    };
    expect(row.project_id).toBe(projectB.id);
    expect(row.in_progress_since).toBeNull(); // was never in progress in the first place
  });

  it("project task -> loose area: project_id becomes NULL", () => {
    const project = db.createProject(conn, { listId, name: "A", color: "blue" }, NOW);
    const task = create("t", { projectId: project.id });
    db.moveTask(
      conn,
      { id: task.id, stage: "pending", parentId: null, beforeId: null, afterId: null, projectId: null },
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
      { id: task.id, stage: "pending", parentId: null, beforeId: null, afterId: null, projectId: project.id },
      NOW,
    );
    const row = conn.prepare(`SELECT project_id FROM tasks WHERE id = ?`).get(task.id) as {
      project_id: string | null;
    };
    expect(row.project_id).toBe(project.id);
  });

  it("subtask -> In Progress: flags scheduled, parent_id kept (the central change)", () => {
    const parent = create("parent");
    const child = db.createTask(
      conn,
      {
        listId,
        stage: "pending",
        title: "child",
        parentId: parent.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      },
      NOW,
    );
    db.moveTask(conn, { id: child.id, stage: "in_progress", parentId: parent.id, beforeId: null, afterId: null }, NOW);
    const row = conn.prepare(`SELECT parent_id, stage FROM tasks WHERE id = ?`).get(child.id) as {
      parent_id: string | null;
      stage: string;
    };
    expect(row.parent_id).toBe(parent.id);
    expect(row.stage).toBe("in_progress");
  });
});

describe("In Progress membership is solely stage-based — due dates never grant it", () => {
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  // The load-bearing regression this whole feature exists to fix: an open,
  // overdue, stage='pending' task must be ABSENT from In Progress. Due
  // dates are just due dates now — they never pull a task in, and moving a
  // manually-scheduled-but-overdue task back to `pending` can never
  // "boomerang" it back in either, since there is no due-date branch left
  // to re-satisfy.
  it("an open, overdue, stage='pending' task is absent from In Progress", () => {
    const overdueMs = new Date(2026, 7, 10, 9, 0, 0).getTime();
    const task = db.createTask(
      conn,
      {
        listId,
        stage: "pending",
        title: "overdue, never scheduled",
        parentId: null,
        dueAt: overdueMs,
        hasDueTime: true,
        position: "bottom",
      },
      NOW,
    );

    const row = conn.prepare(`SELECT stage FROM tasks WHERE id = ?`).get(task.id) as {
      stage: "pending" | "in_progress";
    };
    expect(db.isInProgressMember(row)).toBe(false);

    const board = db.getBoard(conn, listId, NOW);
    const dto = board.backlog.tasks.find((t) => t.id === task.id)!;
    expect(dto.inProgress).toBe(false);
  });

  it("an overdue, manually-scheduled task moved in_progress->pending is absent from In Progress afterwards", () => {
    const overdueMs = new Date(2026, 7, 10, 9, 0, 0).getTime();
    const task = db.createTask(
      conn,
      {
        listId,
        stage: "in_progress",
        title: "overdue and scheduled",
        parentId: null,
        dueAt: overdueMs,
        hasDueTime: true,
        position: "bottom",
      },
      NOW,
    );

    db.moveTask(conn, { id: task.id, stage: "pending", parentId: null, beforeId: null, afterId: null }, NOW);

    const row = conn.prepare(`SELECT stage FROM tasks WHERE id = ?`).get(task.id) as {
      stage: "pending" | "in_progress";
    };
    expect(db.isInProgressMember(row)).toBe(false);

    const board = db.getBoard(conn, listId, NOW);
    const dto = board.backlog.tasks.find((t) => t.id === task.id)!;
    expect(dto.inProgress).toBe(false);
  });
});

describe("setTaskStage", () => {
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    conn = freshDb();
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  function createPending() {
    return db.createTask(
      conn,
      {
        listId,
        stage: "pending",
        title: "a task",
        parentId: null,
        dueAt: new Date(2026, 7, 18, 9, 0, 0).getTime(),
        hasDueTime: true,
        position: "bottom",
      },
      NOW,
    );
  }

  it("stage: 'pending' on an already-pending row is a no-op on in_progress_since (nothing to reset)", () => {
    const task = createPending();
    const before = conn.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task.id) as Record<string, unknown>;

    db.setTaskStage(conn, task.id, "pending", NOW);

    const after = conn.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task.id) as Record<string, unknown>;
    for (const key of Object.keys(before)) {
      if (key === "updated_at") continue;
      expect(after[key]).toEqual(before[key]);
    }
  });

  it("stage: 'in_progress' stamps in_progress_since to now and places the row at the top of its home-sibling group", () => {
    const older = db.createTask(
      conn,
      { listId, stage: "pending", title: "older", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const task = createPending();

    db.setTaskStage(conn, task.id, "in_progress", NOW);

    const row = conn.prepare(`SELECT stage, in_progress_since, sort_order FROM tasks WHERE id = ?`).get(task.id) as {
      stage: string;
      in_progress_since: number | null;
      sort_order: number;
    };
    const olderRow = conn.prepare(`SELECT sort_order FROM tasks WHERE id = ?`).get(older.id) as {
      sort_order: number;
    };
    expect(row.stage).toBe("in_progress");
    expect(row.in_progress_since).toBe(NOW.getTime());
    expect(row.sort_order).toBeLessThan(olderRow.sort_order); // top of its home-sibling group
  });

  it("stage: 'pending' RESETS the carried-days clock — restarting later starts from 0, not from where it left off", () => {
    const task = createPending();
    db.setTaskStage(conn, task.id, "in_progress", NOW);

    const parkDay = new Date(NOW.getTime() + 5 * 86400000);
    db.setTaskStage(conn, task.id, "pending", parkDay);
    let row = conn.prepare(`SELECT in_progress_since FROM tasks WHERE id = ?`).get(task.id) as {
      in_progress_since: number | null;
    };
    expect(row.in_progress_since).toBeNull();

    const restartDay = new Date(parkDay.getTime() + 2 * 86400000);
    db.setTaskStage(conn, task.id, "in_progress", restartDay);
    row = conn.prepare(`SELECT in_progress_since FROM tasks WHERE id = ?`).get(task.id) as {
      in_progress_since: number | null;
    };
    expect(row.in_progress_since).toBe(restartDay.getTime()); // fresh clock, not resumed
  });

  it("throws not_found for an unknown id", () => {
    expect(() => db.setTaskStage(conn, "tsk_missing", "pending", NOW)).toThrow(/not_found/);
  });
});

describe("getBoard — ring survives the vanish", () => {
  it("a stage='in_progress' task still counts in inProgress.completed after it completes and vanishes from the open backlog", () => {
    const conn = freshDb();
    db.seed(conn, NOW);
    const listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
    const task = db.createTask(
      conn,
      { listId, stage: "in_progress", title: "scheduled", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );

    const before = db.getBoard(conn, listId, NOW);
    expect(before.backlog.tasks.find((t) => t.id === task.id)?.inProgress).toBe(true);
    expect(before.inProgress.planned).toBe(1);
    expect(before.inProgress.completed).toBe(0);

    db.completeTask(conn, task.id, NOW);

    // completeTask never touches `stage` — the row is simply still
    // `stage = 'in_progress'` after it's done, which is what keeps it
    // counted with no special stamping needed anymore.
    const stageRow = conn.prepare(`SELECT stage FROM tasks WHERE id = ?`).get(task.id) as { stage: string };
    expect(stageRow.stage).toBe("in_progress");

    const after = db.getBoard(conn, listId, NOW);
    expect(after.backlog.tasks.find((t) => t.id === task.id)).toBeUndefined(); // vanished (done, no longer open)
    expect(after.inProgress.completed).toBe(1);
    expect(after.inProgress.planned).toBe(1); // denominator survives the vanish
  });
});

describe("TaskDto.inProgress drift guard", () => {
  it("board.backlog.tasks' inProgress always matches isInProgressMember recomputed independently from the raw columns", () => {
    const conn = freshDb();
    db.seed(conn, NOW);
    const listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;

    const manual = db.createTask(
      conn,
      { listId, stage: "in_progress", title: "manual", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const overdue = db.createTask(
      conn,
      {
        listId,
        stage: "pending",
        title: "overdue, never scheduled",
        parentId: null,
        dueAt: new Date(2026, 7, 18, 9, 0, 0).getTime(),
        hasDueTime: true,
        position: "bottom",
      },
      NOW,
    );
    const plain = db.createTask(
      conn,
      { listId, stage: "pending", title: "plain", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );

    const board = db.getBoard(conn, listId, NOW);
    for (const dto of board.backlog.tasks) {
      const row = conn.prepare(`SELECT stage FROM tasks WHERE id = ?`).get(dto.id) as {
        stage: "pending" | "in_progress";
      };
      expect(dto.inProgress).toBe(db.isInProgressMember(row));
    }
    expect(board.backlog.tasks.find((t) => t.id === manual.id)?.inProgress).toBe(true);
    // A due date — even overdue — never grants membership anymore.
    expect(board.backlog.tasks.find((t) => t.id === overdue.id)?.inProgress).toBe(false);
    expect(board.backlog.tasks.find((t) => t.id === plain.id)?.inProgress).toBe(false);
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

  it("backlog.tasks is comprehensive: a manually-scheduled task appears once, undimmed, and a due-today (but never scheduled) task is NOT flagged inProgress — no ghost concept, and no due-date auto-inclusion", () => {
    const project = db.createProject(conn, { listId, name: "Q3", color: "blue" }, NOW);
    const plain = db.createTask(
      conn,
      {
        listId,
        stage: "pending",
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
        stage: "pending",
        title: "will be scheduled",
        parentId: null,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
        projectId: project.id,
      },
      NOW,
    );
    db.moveTask(conn, { id: scheduled.id, stage: "in_progress", parentId: null, beforeId: null, afterId: null }, NOW);
    const dueToday = db.createTask(
      conn,
      {
        listId,
        stage: "pending",
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
    expect(scheduledDto.stage).toBe("in_progress");
    expect(scheduledDto.inProgress).toBe(true);

    const dueTodayDto = board.backlog.tasks.find((t) => t.id === dueToday.id)!;
    expect(dueTodayDto.stage).toBe("pending"); // never manually scheduled
    expect(dueTodayDto.inProgress).toBe(false); // a due date never grants In Progress membership
  });

  it("inProgress is true for a subtask scheduled on its own, without scheduling its parent", () => {
    const parent = db.createTask(
      conn,
      { listId, stage: "pending", title: "parent", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const child = db.createTask(
      conn,
      {
        listId,
        stage: "pending",
        title: "child",
        parentId: parent.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      },
      NOW,
    );
    db.moveTask(conn, { id: child.id, stage: "in_progress", parentId: parent.id, beforeId: null, afterId: null }, NOW);

    const board = db.getBoard(conn, listId, NOW);
    const parentDto = board.backlog.tasks.find((t) => t.id === parent.id)!;
    expect(parentDto.inProgress).toBe(false); // scheduling the subtask did not schedule the parent
    const childDto = parentDto.subtasks.find((t) => t.id === child.id)!;
    expect(childDto.inProgress).toBe(true);
    expect(childDto.stage).toBe("in_progress");
  });

  it("trail is null for a loose top-level task, and populated with project name/color and parent title otherwise", () => {
    const project = db.createProject(conn, { listId, name: "Q3 Launch", color: "violet" }, NOW);
    const loose = db.createTask(
      conn,
      { listId, stage: "pending", title: "loose", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const parent = db.createTask(
      conn,
      {
        listId,
        stage: "pending",
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
        stage: "pending",
        title: "Get legal sign-off",
        parentId: parent.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      },
      NOW,
    );
    db.moveTask(conn, { id: child.id, stage: "in_progress", parentId: parent.id, beforeId: null, afterId: null }, NOW);

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
      { listId, stage: "pending", title: "day1", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
      NOW,
    );
    const dayTwoTask = db.createTask(
      conn,
      { listId, stage: "pending", title: "day2", parentId: null, dueAt: null, hasDueTime: false, position: "bottom" },
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
