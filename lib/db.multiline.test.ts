// SQLite round trips for multiline titles: the title stays one TEXT value
// through create, rename, archive, restore, and a real close-and-reopen.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as db from "./db.js";

const NOW = new Date(2026, 7, 20, 12, 0, 0);
const THREE_LINES = "Review the release notes\nCheck the API changes\nhttps://example.com/release";

function open(path: string): Database.Database {
  const conn = new Database(path);
  conn.pragma("foreign_keys = ON");
  // The host's `bb.storage.migrate` applies each migration once. Mirror that
  // with `user_version` so reopening the same file does not replay them.
  const applied = conn.pragma("user_version", { simple: true }) as number;
  for (const stmt of db.MIGRATIONS.slice(applied)) conn.exec(stmt);
  conn.pragma(`user_version = ${db.MIGRATIONS.length}`);
  return conn;
}

function newTask(conn: Database.Database, listId: string, title: string, parentId: string | null = null) {
  return db.createTask(
    conn,
    { listId, stage: "pending", title, parentId, dueAt: null, hasDueTime: false, position: "bottom" },
    NOW,
  );
}

describe("multiline titles in SQLite", () => {
  let dir: string;
  let path: string;
  let conn: Database.Database;
  let listId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "todo-multiline-"));
    path = join(dir, "todo.db");
    conn = open(path);
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
  });

  afterEach(() => {
    if (conn.open) conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const titlesOnBoard = (c: Database.Database) =>
    db.getBoard(c, listId, NOW).backlog.tasks.map((t) => t.title);

  it("keeps all three lines after create and a reload", () => {
    newTask(conn, listId, THREE_LINES);
    expect(titlesOnBoard(conn)).toEqual([THREE_LINES]);

    conn.close();
    const reopened = open(path);
    try {
      expect(titlesOnBoard(reopened)).toEqual([THREE_LINES]);
      const raw = reopened.prepare(`SELECT title FROM tasks`).get() as { title: string };
      expect(raw.title).toBe(THREE_LINES);
    } finally {
      reopened.close();
    }
  });

  it("preserves blank lines inside the title", () => {
    newTask(conn, listId, "one\n\n\ntwo");
    expect(titlesOnBoard(conn)).toEqual(["one\n\n\ntwo"]);
  });

  it("normalises CRLF to LF and trims only the outside on create", () => {
    const created = newTask(conn, listId, "  \r\nfirst\r\nsecond\r\n  ");
    expect(created.title).toBe("first\nsecond");
    expect((conn.prepare(`SELECT title FROM tasks`).get() as { title: string }).title).toBe("first\nsecond");
  });

  it("normalises CRLF on rename and keeps the new lines after a reload", () => {
    const task = newTask(conn, listId, "old");
    const renamed = db.updateTask(conn, { id: task.id, title: "new one\r\nnew two" }, NOW);
    expect(renamed.title).toBe("new one\nnew two");

    conn.close();
    const reopened = open(path);
    try {
      expect(titlesOnBoard(reopened)).toEqual(["new one\nnew two"]);
    } finally {
      reopened.close();
    }
  });

  it("rejects a title that is only whitespace and newlines", () => {
    expect(() => newTask(conn, listId, " \n\r\n ")).toThrow(/invalid_input/);
    const task = newTask(conn, listId, "keep");
    expect(() => db.updateTask(conn, { id: task.id, title: "\n\n" }, NOW)).toThrow(/invalid_input/);
  });

  it("keeps multiline titles for subtasks", () => {
    const parent = newTask(conn, listId, "Parent\nwith detail");
    newTask(conn, listId, "Child line 1\nChild line 2", parent.id);
    const [top] = db.getBoard(conn, listId, NOW).backlog.tasks;
    expect(top?.title).toBe("Parent\nwith detail");
    expect(top?.subtasks.map((s) => s.title)).toEqual(["Child line 1\nChild line 2"]);
  });

  it("keeps the full title through archive and restore", () => {
    const task = newTask(conn, listId, THREE_LINES);
    db.completeTask(conn, task.id, NOW);
    expect(titlesOnBoard(conn)).toEqual([]);

    const archive = db.getArchive(conn, listId, 100, 0, NOW);
    expect(archive.groups.flatMap((g) => g.tasks.map((t) => t.title))).toEqual([THREE_LINES]);

    db.restoreTasks(conn, [task.id], NOW);
    expect(titlesOnBoard(conn)).toEqual([THREE_LINES]);
  });

  it("carries a multiline parent title into a subtask's trail", () => {
    const parent = newTask(conn, listId, "Parent line\nsecond line");
    const child = newTask(conn, listId, "child", parent.id);
    db.setTaskStage(conn, child.id, "in_progress", NOW);
    const sub = db.getBoard(conn, listId, NOW).backlog.tasks[0]?.subtasks[0];
    expect(sub?.trail?.parentTitle).toBe("Parent line\nsecond line");
  });

  it("stores markup-like text verbatim", () => {
    const html = '<img src=x onerror=alert(1)>\n<b>bold</b>';
    newTask(conn, listId, html);
    expect(titlesOnBoard(conn)).toEqual([html]);
  });
});
