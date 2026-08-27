import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "./db.js";
import { localDay } from "./day.js";
import { runRollover } from "./rollover.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const stmt of MIGRATIONS) db.exec(stmt);
  db.prepare(`INSERT INTO lists (id, name, sort_order, created_at) VALUES ('lst_1', 'Work', 1000, 0)`).run();
  return db;
}

function insertTask(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    bucket: "backlog" | "today";
    day: string | null;
    status: "open" | "done";
    carried: number;
  }>,
): void {
  const t = {
    id: "tsk_1",
    bucket: "today" as const,
    day: "2026-08-18",
    status: "open" as const,
    carried: 0,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
     VALUES (?, 'lst_1', NULL, 'task', NULL, ?, ?, 1000, NULL, 0, ?, NULL, ?, 0, 0)`,
  ).run(t.id, t.bucket, t.day, t.status, t.carried);
}

describe("runRollover", () => {
  let db: Database.Database;
  const now = new Date(2026, 7, 20, 9, 0, 0); // 2026-08-20 local

  beforeEach(() => {
    db = freshDb();
  });

  it("carries forward open today tasks whose day is before today", () => {
    insertTask(db, { id: "tsk_old", day: "2026-08-18" });
    runRollover(db, now);
    const row = db.prepare(`SELECT day, carried_count FROM tasks WHERE id = 'tsk_old'`).get() as {
      day: string;
      carried_count: number;
    };
    expect(row.day).toBe(localDay(now));
    expect(row.carried_count).toBe(1);
  });

  it("never touches backlog rows", () => {
    insertTask(db, { id: "tsk_backlog", bucket: "backlog", day: null });
    runRollover(db, now);
    const row = db.prepare(`SELECT day, bucket FROM tasks WHERE id = 'tsk_backlog'`).get() as {
      day: string | null;
      bucket: string;
    };
    expect(row.day).toBeNull();
    expect(row.bucket).toBe("backlog");
  });

  it("does not touch done tasks", () => {
    insertTask(db, { id: "tsk_done", day: "2026-08-18", status: "done" });
    runRollover(db, now);
    const row = db.prepare(`SELECT day FROM tasks WHERE id = 'tsk_done'`).get() as { day: string };
    expect(row.day).toBe("2026-08-18");
  });

  it("does not touch a task already on today's day", () => {
    insertTask(db, { id: "tsk_today", day: localDay(now) });
    runRollover(db, now);
    const row = db.prepare(`SELECT carried_count FROM tasks WHERE id = 'tsk_today'`).get() as {
      carried_count: number;
    };
    expect(row.carried_count).toBe(0);
  });

  it("is idempotent: running twice on the same day changes nothing the second time", () => {
    insertTask(db, { id: "tsk_old", day: "2026-08-18" });
    const first = runRollover(db, now);
    const second = runRollover(db, now);
    expect(first).toBe(1);
    expect(second).toBe(0);
    const row = db.prepare(`SELECT carried_count FROM tasks WHERE id = 'tsk_old'`).get() as {
      carried_count: number;
    };
    expect(row.carried_count).toBe(1);
  });

  it("carries forward correctly even after a multi-day gap (stale/missing guard)", () => {
    insertTask(db, { id: "tsk_stale", day: "2026-08-10" });
    runRollover(db, now);
    const row = db.prepare(`SELECT day, carried_count FROM tasks WHERE id = 'tsk_stale'`).get() as {
      day: string;
      carried_count: number;
    };
    expect(row.day).toBe(localDay(now));
    expect(row.carried_count).toBe(1);
  });

  // Regression: a live-server repro found rows dated both 1 day and 7 days
  // back rolling forward correctly in isolation, a done row staying frozen,
  // and double-invocation incrementing exactly once — all together, in one
  // pass, the way the lazy path actually calls this.
  it("rolls a 1-day-stale row and a 7-day-stale row forward together, leaves a done row frozen, and only increments once across two runs", () => {
    insertTask(db, { id: "tsk_1day", day: "2026-08-19", carried: 2 });
    insertTask(db, { id: "tsk_7day", day: "2026-08-13", carried: 0 });
    insertTask(db, { id: "tsk_done", day: "2026-08-19", status: "done" });

    const first = runRollover(db, now);
    expect(first).toBe(2); // only the two open rows

    const rows = db
      .prepare(`SELECT id, day, carried_count, status FROM tasks ORDER BY id`)
      .all() as { id: string; day: string; carried_count: number; status: string }[];
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get("tsk_1day")).toMatchObject({ day: localDay(now), carried_count: 3 });
    expect(byId.get("tsk_7day")).toMatchObject({ day: localDay(now), carried_count: 1 });
    // The done row is untouched — frozen on its original completion day.
    expect(byId.get("tsk_done")).toMatchObject({ day: "2026-08-19", status: "done" });

    const second = runRollover(db, now);
    expect(second).toBe(0);
    const after = db.prepare(`SELECT carried_count FROM tasks WHERE id = 'tsk_1day'`).get() as {
      carried_count: number;
    };
    expect(after.carried_count).toBe(3); // unchanged by the second run
  });

  it("carries a subtask forward along with its parent, mirroring the parent's new day", () => {
    insertTask(db, { id: "tsk_parent", day: "2026-08-18" });
    db.prepare(
      `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
       VALUES ('tsk_child', 'lst_1', 'tsk_parent', 'child', NULL, 'today', '2026-08-18', 1000, NULL, 0, 'open', NULL, 0, 0, 0)`,
    ).run();

    runRollover(db, now);

    const parent = db.prepare(`SELECT day, carried_count FROM tasks WHERE id = 'tsk_parent'`).get() as {
      day: string;
      carried_count: number;
    };
    const child = db.prepare(`SELECT day, carried_count FROM tasks WHERE id = 'tsk_child'`).get() as {
      day: string;
      carried_count: number;
    };
    expect(parent.day).toBe(localDay(now));
    expect(child.day).toBe(localDay(now));
    expect(child.day).toBe(parent.day);
    expect(child.carried_count).toBe(1);
  });

  // Phase 2 requirement: prove runRollover (untouched by the projects
  // feature) still carries a task forward correctly across several days,
  // AND that its trail — computed by lib/db.ts, entirely outside
  // runRollover — still resolves in full afterward. Carry-forward and the
  // project/parent trail are orthogonal: rollover only ever touches
  // day/carried_count, never project_id or parent_id.
  it("a task carried several times still resolves its full trail (project + parent) afterward", () => {
    db.prepare(
      `INSERT INTO projects (id, list_id, name, color, collapsed, sort_order, created_at)
       VALUES ('prj_1', 'lst_1', 'Q3 Launch', 'violet', 0, 1000, 0)`,
    ).run();
    insertTask(db, { id: "tsk_parent", day: "2026-08-15" });
    db.prepare(`UPDATE tasks SET project_id = 'prj_1', title = 'Rewrite the onboarding email' WHERE id = 'tsk_parent'`).run();
    db.prepare(
      `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, project_id, today_order, created_at, updated_at)
       VALUES ('tsk_child', 'lst_1', 'tsk_parent', 'Get legal sign-off', NULL, 'today', '2026-08-15', 1000, NULL, 0, 'open', NULL, 0, 'prj_1', 1000, 0, 0)`,
    ).run();

    // Carry forward three separate days, same as a task nobody touches for
    // a while — each call simulates one lazy getBoard's rollover pass.
    runRollover(db, new Date(2026, 7, 18, 9, 0, 0));
    runRollover(db, new Date(2026, 7, 19, 9, 0, 0));
    runRollover(db, now); // 2026-08-20

    const child = db.prepare(`SELECT day, carried_count, parent_id, project_id FROM tasks WHERE id = 'tsk_child'`).get() as {
      day: string;
      carried_count: number;
      parent_id: string | null;
      project_id: string | null;
    };
    expect(child.day).toBe(localDay(now));
    expect(child.carried_count).toBe(3);
    // The trail's two anchors — parent_id and project_id — are exactly what
    // they were before any rollover ran; runRollover never touches them.
    expect(child.parent_id).toBe("tsk_parent");
    expect(child.project_id).toBe("prj_1");
  });
});
