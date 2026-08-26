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
    expect(board.today.tasks).toEqual([]); // vanished from the visible list
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

    const archive = db.getArchive(conn, listId, 100, 0);
    expect(archive.total).toBe(2);
    expect(archive.groups.map((g) => g.day)).toEqual(["2026-08-19", "2026-08-18"]);
    expect(archive.groups[0].tasks[0].id).toBe(dayTwoTask.id);
  });
});
