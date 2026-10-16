// Image storage lifecycle: validation, staging failures, the delete trigger
// and cleanup queue (including retry after a "restart"), and reconciliation
// of abandoned files without racing an upload that is still committing.
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMAGE_LIMITS } from "../contract.js";
import * as db from "./db.js";
import { ImageStore, RECONCILE_GRACE_MS, sniffImageMime, type ImageInput } from "./images.js";

const NOW = new Date(2026, 7, 20, 12, 0, 0);
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A tiny but correctly-signed PNG; `pad` makes each one unique/larger. */
function png(pad = 0): ImageInput {
  return { data: Buffer.concat([PNG_HEAD, Buffer.alloc(16 + pad, 7)]).toString("base64") };
}
function raw(bytes: number[], pad = 16): ImageInput {
  return { data: Buffer.concat([Buffer.from(bytes), Buffer.alloc(pad)]).toString("base64") };
}

describe("sniffImageMime", () => {
  it("accepts PNG, JPEG, GIF, and WebP by signature", () => {
    expect(sniffImageMime(PNG_HEAD)).toBe("image/png");
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("GIF89a....", "latin1"))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))).toBe("image/webp");
  });

  it("rejects SVG, HTML, and plain text", () => {
    expect(sniffImageMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageMime(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffImageMime(Buffer.from("hello"))).toBeNull();
    expect(sniffImageMime(Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1"))).toBeNull();
  });
});

describe("image lifecycle", () => {
  let dir: string;
  let conn: Database.Database;
  let store: ImageStore;
  let listId: string;
  let unlinkFails: boolean;

  const files = () => readdirSync(join(dir, "images")).sort();
  const queue = () => conn.prepare(`SELECT * FROM image_cleanup ORDER BY file_name`).all() as any[];
  const imageRows = () => conn.prepare(`SELECT * FROM task_images`).all() as any[];

  function open(): ImageStore {
    return new ImageStore(join(dir, "images"), {
      unlink: (p) => {
        if (unlinkFails) throw Object.assign(new Error("EBUSY: file is locked"), { code: "EBUSY" });
        rmSync(p);
      },
    });
  }

  function addTask(title: string, images: ImageInput[] = [], parentId: string | null = null) {
    return store.withStaged(
      conn,
      images,
      (staged) =>
        db.createTask(
          conn,
          { listId, stage: "pending", title, parentId, dueAt: null, hasDueTime: false, position: "bottom", images: staged },
          NOW,
        ),
      NOW,
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "todo-images-"));
    conn = new Database(join(dir, "data.db"));
    conn.pragma("foreign_keys = ON");
    for (const stmt of db.MIGRATIONS) conn.exec(stmt);
    db.seed(conn, NOW);
    listId = (conn.prepare(`SELECT id FROM lists ORDER BY sort_order LIMIT 1`).get() as { id: string }).id;
    unlinkFails = false;
    store = open();
  });

  afterEach(() => {
    if (conn.open) conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("validation", () => {
    it("stores metadata in the task DTO and bytes on disk, not in the row", () => {
      const task = addTask("with image", [png()]);
      expect(task.images).toHaveLength(1);
      expect(task.images[0]).toMatchObject({ mime: "image/png", size: PNG_HEAD.length + 16 });
      expect(task.images[0].url).toContain(`image?id=${task.images[0].id}`);
      expect(files()).toHaveLength(1);
      expect(files()[0]).toBe(`${task.images[0].id}.png`);
      // No base64 anywhere in the task tables.
      const dump = JSON.stringify(conn.prepare(`SELECT * FROM tasks`).all()) + JSON.stringify(imageRows());
      expect(dump).not.toContain(png().data.slice(0, 20));
    });

    it("rejects non-images, bad base64, oversize, and too many, leaving nothing behind", () => {
      const bad: [string, ImageInput[]][] = [
        ["svg", [{ data: Buffer.from("<svg/>").toString("base64") }]],
        ["not base64", [{ data: "@@@@" }]],
        ["bad padding length", [{ data: "abc" }]],
        ["empty", [{ data: "" }]],
        ["oversize", [png(IMAGE_LIMITS.maxBytes)]],
        ["too many", Array.from({ length: IMAGE_LIMITS.maxPerTask + 1 }, (_, i) => png(i))],
        ["one bad among good", [png(1), { data: Buffer.from("nope").toString("base64") }]],
      ];
      for (const [, inputs] of bad) {
        expect(() => addTask("x", inputs)).toThrow(/invalid_input/);
      }
      expect(files()).toEqual([]);
      expect(imageRows()).toEqual([]);
      expect(db.getBoard(conn, listId, NOW).backlog.tasks).toEqual([]);
    });

    it("rejects a request whose images together exceed the request budget", () => {
      const big = IMAGE_LIMITS.maxBytes - 64;
      const inputs = [png(big), png(big + 1), png(big + 2), png(big + 3)];
      expect(() => addTask("x", inputs)).toThrow(/total more than/);
      expect(files()).toEqual([]);
    });
  });

  describe("failure during staging", () => {
    it("removes the temp file, the earlier files, and the in-flight guard when a write fails", () => {
      let writes = 0;
      store = new ImageStore(join(dir, "images"), {
        writeFile: (path, bytes) => {
          writes++;
          writeFileSync(path, bytes);
          if (writes === 2) throw new Error("ENOSPC: no space left on device");
        },
      });
      expect(() => addTask("x", [png(1), png(2)])).toThrow(/upload_failed/);
      expect(files()).toEqual([]);
      expect(db.getBoard(conn, listId, NOW).backlog.tasks).toEqual([]);
    });

    it("removes the temp file when rename fails", () => {
      store = new ImageStore(join(dir, "images"), {
        rename: () => {
          throw new Error("EXDEV: cross-device link");
        },
      });
      expect(() => addTask("x", [png()])).toThrow(/upload_failed/);
      expect(files()).toEqual([]);
    });

    it("leaves a survivor reclaimable by reconciliation, not protected forever", () => {
      // The write succeeds, rename fails, and the cleanup unlink also fails:
      // the temp file survives. It must not stay in `inFlight`.
      store = new ImageStore(join(dir, "images"), {
        rename: () => {
          throw new Error("EXDEV");
        },
        unlink: () => {
          throw new Error("EBUSY");
        },
      });
      expect(() => addTask("x", [png()])).toThrow(/upload_failed/);
      expect(files()).toHaveLength(1);
      expect(files()[0]).toMatch(/^\.tmp-img_/);

      // Fresh: protected by the grace period.
      store = open();
      store.reconcile(conn, new Date(Date.now()));
      expect(files()).toHaveLength(1);

      // Old enough: reclaimed.
      store.reconcile(conn, new Date(Date.now() + RECONCILE_GRACE_MS + 1000));
      expect(files()).toEqual([]);
    });

    it("discards the files when the DB commit fails (task over its image cap)", () => {
      const task = addTask("full", Array.from({ length: IMAGE_LIMITS.maxPerTask }, (_, i) => png(i)));
      expect(files()).toHaveLength(IMAGE_LIMITS.maxPerTask);
      expect(() =>
        store.withStaged(conn, [png(99)], (staged) => db.updateTask(conn, { id: task.id, addImages: staged }, NOW), NOW),
      ).toThrow(/at most/);
      expect(files()).toHaveLength(IMAGE_LIMITS.maxPerTask);
      expect(imageRows()).toHaveLength(IMAGE_LIMITS.maxPerTask);
      expect(queue()).toEqual([]);
    });

    it("discards the files when the task is gone by commit time", () => {
      const task = addTask("doomed");
      conn.prepare(`DELETE FROM tasks WHERE id = ?`).run(task.id);
      expect(() =>
        store.withStaged(conn, [png()], (staged) => db.updateTask(conn, { id: task.id, addImages: staged }, NOW), NOW),
      ).toThrow(/not_found/);
      expect(files()).toEqual([]);
    });

    it("keeps a failed discard in the durable queue", () => {
      unlinkFails = true;
      expect(() => addTask("   ", [png()])).toThrow(/title must not be empty/);
      expect(files()).toHaveLength(1);
      expect(queue()).toHaveLength(1);
      expect(queue()[0].attempts).toBe(1);
      unlinkFails = false;
      store.processCleanup(conn, new Date(Date.now() + 3_600_000));
      expect(files()).toEqual([]);
      expect(queue()).toEqual([]);
    });

    it("makes a task update with additions and removals atomic", () => {
      const task = addTask("t", [png(1), png(2)]);
      const [first] = task.images;
      expect(() =>
        store.withStaged(
          conn,
          [png(3)],
          (staged) => db.updateTask(conn, { id: task.id, title: "   ", removeImageIds: [first.id], addImages: staged }, NOW),
          NOW,
        ),
      ).toThrow(/title must not be empty/);
      expect(imageRows()).toHaveLength(2);
      expect(files()).toHaveLength(2);
    });
  });

  describe("permanent deletion removes files", () => {
    const drain = () => store.processCleanup(conn, NOW);

    it("deletes the file when one image is removed from a task", () => {
      const task = addTask("t", [png(1), png(2)]);
      db.updateTask(conn, { id: task.id, removeImageIds: [task.images[0].id] }, NOW);
      drain();
      expect(files()).toEqual([`${task.images[1].id}.png`]);
      expect(imageRows()).toHaveLength(1);
    });

    it("ignores an image id that belongs to another task", () => {
      const a = addTask("a", [png(1)]);
      const b = addTask("b", [png(2)]);
      db.updateTask(conn, { id: a.id, removeImageIds: [b.images[0].id] }, NOW);
      drain();
      expect(files()).toHaveLength(2);
    });

    it("deletes files of a deleted task and of its cascaded subtasks", () => {
      const parent = addTask("parent", [png(1)]);
      addTask("child", [png(2)], parent.id);
      expect(files()).toHaveLength(2);
      db.deleteTask(conn, parent.id);
      drain();
      expect(files()).toEqual([]);
      expect(imageRows()).toEqual([]);
      expect(queue()).toEqual([]);
    });

    it("deletes files when a whole list is deleted", () => {
      const other = db.createList(conn, "Other", NOW);
      store.withStaged(
        conn,
        [png(1)],
        (staged) =>
          db.createTask(
            conn,
            { listId: other.id, stage: "pending", title: "in other", parentId: null, dueAt: null, hasDueTime: false, position: "bottom", images: staged },
            NOW,
          ),
        NOW,
      );
      addTask("stays", [png(2)]);
      expect(files()).toHaveLength(2);
      db.deleteList(conn, other.id, NOW);
      drain();
      expect(files()).toHaveLength(1);
      expect(imageRows()).toHaveLength(1);
    });

    it("deletes files on clear archive, but not for open tasks", () => {
      const done = addTask("done", [png(1)]);
      addTask("open", [png(2)]);
      db.completeTask(conn, done.id, NOW);
      expect(db.clearArchive(conn, listId)).toBe(1);
      drain();
      expect(files()).toHaveLength(1);
      expect(imageRows()).toHaveLength(1);
    });

    it("keeps images through complete, archive, and restore", () => {
      const task = addTask("keep me", [png(1)]);
      db.completeTask(conn, task.id, NOW);
      expect(queue()).toEqual([]);
      const archived = db.getArchive(conn, listId, 10, 0, NOW).groups[0].tasks[0];
      expect(archived.images.map((i) => i.id)).toEqual([task.images[0].id]);
      db.restoreTasks(conn, [task.id], NOW);
      const restored = db.getBoard(conn, listId, NOW).backlog.tasks[0];
      expect(restored.images.map((i) => i.id)).toEqual([task.images[0].id]);
      expect(files()).toHaveLength(1);
    });

    it("keeps images when a project is deleted (its tasks survive)", () => {
      const project = db.createProject(conn, { listId, name: "P", color: "blue" }, NOW);
      const task = store.withStaged(
        conn,
        [png()],
        (staged) =>
          db.createTask(
            conn,
            { listId, stage: "pending", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom", projectId: project.id, images: staged },
            NOW,
          ),
        NOW,
      );
      db.deleteProject(conn, project.id);
      drain();
      expect(files()).toEqual([`${task.images[0].id}.png`]);
    });
  });

  describe("cleanup queue", () => {
    it("retries a failing unlink with backoff and succeeds later", () => {
      const task = addTask("t", [png()]);
      db.deleteTask(conn, task.id);
      expect(queue()).toHaveLength(1);

      unlinkFails = true;
      expect(store.processCleanup(conn, NOW)).toEqual({ removed: 0, failed: 1 });
      expect(files()).toHaveLength(1);
      const [row] = queue();
      expect(row.attempts).toBe(1);
      expect(row.last_error).toMatch(/EBUSY/);
      expect(row.next_attempt_at).toBeGreaterThan(NOW.getTime());

      // Not due yet: not even attempted.
      unlinkFails = false;
      expect(store.processCleanup(conn, NOW)).toEqual({ removed: 0, failed: 0 });
      expect(files()).toHaveLength(1);

      // Due: removed and dequeued.
      expect(store.processCleanup(conn, new Date(row.next_attempt_at + 1))).toEqual({ removed: 1, failed: 0 });
      expect(files()).toEqual([]);
      expect(queue()).toEqual([]);
    });

    it("grows the delay on repeated failures", () => {
      const task = addTask("t", [png()]);
      db.deleteTask(conn, task.id);
      unlinkFails = true;
      store.processCleanup(conn, NOW);
      const next1 = queue()[0].next_attempt_at;
      store.processCleanup(conn, new Date(next1));
      const next2 = queue()[0].next_attempt_at;
      expect(queue()[0].attempts).toBe(2);
      expect(next2 - next1).toBeGreaterThan(next1 - NOW.getTime());
    });

    it("survives a restart: a new store and a reopened db finish the deletion", () => {
      const task = addTask("t", [png()]);
      db.deleteTask(conn, task.id);
      unlinkFails = true;
      store.processCleanup(conn, NOW);
      expect(files()).toHaveLength(1);

      conn.close();
      conn = new Database(join(dir, "data.db"));
      conn.pragma("foreign_keys = ON");
      unlinkFails = false;
      const restarted = open();
      restarted.start(conn, new Date(NOW.getTime() + 3_600_000 + 1));
      expect(files()).toEqual([]);
      expect(queue()).toEqual([]);
    });

    it("treats an already-missing file as done", () => {
      const task = addTask("t", [png()]);
      rmSync(join(dir, "images", files()[0]));
      db.deleteTask(conn, task.id);
      expect(store.processCleanup(conn, NOW)).toEqual({ removed: 1, failed: 0 });
      expect(queue()).toEqual([]);
    });

    it("never unlinks outside the images dir, whatever the queue says", () => {
      const victim = join(dir, "data.db-victim");
      writeFileSync(victim, "keep");
      conn
        .prepare(`INSERT INTO image_cleanup (file_name, queued_at, attempts, next_attempt_at) VALUES (?, 0, 0, 0)`)
        .run("../data.db-victim");
      store.processCleanup(conn, NOW);
      expect(existsSync(victim)).toBe(true);
      expect(queue()).toEqual([]);
    });
  });

  describe("reconciliation", () => {
    const old = (name: string) => {
      const t = new Date(Date.now() - RECONCILE_GRACE_MS - 60_000);
      utimesSync(join(dir, "images", name), t, t);
    };
    const later = () => new Date(Date.now());

    it("removes an old file that has no row and no queue entry", () => {
      writeFileSync(join(dir, "images", "img_00000000000000000000aa.png"), "orphan");
      old("img_00000000000000000000aa.png");
      store.reconcile(conn, later());
      expect(files()).toEqual([]);
    });

    it("keeps a fresh unreferenced file (an upload may still be committing)", () => {
      writeFileSync(join(dir, "images", "img_00000000000000000000bb.png"), "fresh");
      store.reconcile(conn, later());
      expect(files()).toHaveLength(1);
    });

    it("keeps files that a row references, however old", () => {
      addTask("t", [png()]);
      old(files()[0]);
      store.reconcile(conn, later());
      expect(files()).toHaveLength(1);
    });

    it("keeps an old file while its upload is still in flight", () => {
      let during: string[] = [];
      store.withStaged(
        conn,
        [png()],
        (staged) => {
          old(staged[0].fileName);
          store.reconcile(conn, later()); // sweeper fires mid-commit
          during = files();
          return db.createTask(
            conn,
            { listId, stage: "pending", title: "t", parentId: null, dueAt: null, hasDueTime: false, position: "bottom", images: staged },
            NOW,
          );
        },
        NOW,
      );
      expect(during).toHaveLength(1);
      expect(files()).toHaveLength(1);
      expect(imageRows()).toHaveLength(1);
      expect(queue()).toEqual([]);
    });

    it("ignores files that do not look like ours", () => {
      writeFileSync(join(dir, "images", "notes.txt"), "mine");
      old("notes.txt");
      store.reconcile(conn, later());
      expect(files()).toEqual(["notes.txt"]);
    });
  });

  it("queues files when raw SQL deletes a task (the trigger, not app code, does it)", () => {
    const task = addTask("t", [png()]);
    conn.prepare(`DELETE FROM tasks WHERE id = ?`).run(task.id);
    expect(imageRows()).toEqual([]);
    expect(queue().map((r) => r.file_name)).toEqual([`${task.images[0].id}.png`]);
  });
});
