// bb-plugin-todo — server entry. Thin wiring only: open the db, migrate,
// seed, register the rpc contract, and publish realtime signals after
// mutations. All SQL and business logic live under lib/.
//
// There is no more carry-forward/rollover here: "Today" as a concept (and
// the `day`-based carry-forward it required) is deleted entirely. In
// Progress membership is now solely `stage = 'in_progress'`, which never
// goes stale with the passage of a calendar day, so there is nothing left
// to roll over lazily or on a cron.
import { dirname, join } from "node:path";
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract.js";

// Re-exported so app.tsx's `import type { rpcContract } from "./server"`
// (the scaffold's frontend wiring, out of scope here) keeps resolving.
// contract.ts remains the single source of truth.
export { rpcContract } from "./contract.js";
import * as db from "./lib/db.js";
import { configureImageUrls, ImageStore, isImageId } from "./lib/images.js";

export default async function plugin(bb: BbPluginApi) {
  const conn = bb.storage.database();
  // better-sqlite3 defaults foreign_keys off; ON DELETE CASCADE is inert
  // without this.
  conn.pragma("foreign_keys = ON");
  bb.storage.migrate(conn, db.MIGRATIONS);
  db.seed(conn, new Date());

  // Image bytes live next to data.db (the plugin's own data dir), never in
  // the plugin source. The db holds the metadata and the delete queue.
  configureImageUrls(bb.pluginId);
  const imageStore = new ImageStore(join(dirname(conn.name), "images"));
  imageStore.start(conn, new Date());

  /** Drain the delete queue after a mutation. Never throws; failures stay queued. */
  function drainImages(): void {
    imageStore.processCleanup(conn, new Date());
  }

  // Authenticated ("local" auth: BB app origin or same-origin GET) image
  // bytes. Exact-match routes have no params, so the id is a query value.
  bb.http.route("GET", "/image", (c) => {
    const id = c.req.query("id") ?? "";
    const row = isImageId(id) ? db.getImageFile(conn, id) : undefined;
    const bytes = row ? imageStore.read(row.fileName) : null;
    if (!row || !bytes) return c.json({ ok: false, error: "image not found" }, 404);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": row.mime,
        "Content-Length": String(bytes.length),
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        // Ids are never reused and image bytes never change.
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  });

  // Reconcile abandoned files and retry failed deletions, also after a
  // restart (the queue is a table).
  bb.background.schedule("image-cleanup", "*/5 * * * *", () => {
    imageStore.start(conn, new Date());
  });

  function publish(listId: string | null): void {
    bb.realtime.publish("board", { listId });
  }

  bb.rpc.register(rpcContract, {
    async getBoard({ listId }) {
      const now = new Date();
      return db.getBoard(conn, listId, now);
    },

    async getArchive({ listId, limit, offset }) {
      const now = new Date();
      return db.getArchive(conn, listId, limit, offset, now);
    },

    createTask({ images, ...input }) {
      const now = new Date();
      const task = imageStore.withStaged(
        conn,
        images ?? [],
        (staged) => db.createTask(conn, { ...input, images: staged }, now),
        now,
      );
      publish(task.listId);
      return { task };
    },

    updateTask({ addImages, ...input }) {
      const now = new Date();
      const task = imageStore.withStaged(
        conn,
        addImages ?? [],
        (staged) => db.updateTask(conn, { ...input, addImages: staged }, now),
        now,
      );
      if (input.removeImageIds?.length) drainImages();
      publish(task.listId);
      return { task };
    },

    moveTask(input) {
      const { listId } = db.moveTask(conn, input, new Date());
      publish(listId);
      return { ok: true as const };
    },

    completeTask({ id }) {
      const { listId, completedIds } = db.completeTask(conn, id, new Date());
      publish(listId);
      return { completedIds };
    },

    setTaskStage({ id, stage }) {
      const { listId } = db.setTaskStage(conn, id, stage, new Date());
      publish(listId);
      return { ok: true as const };
    },

    restoreTasks({ ids }) {
      const { listIds } = db.restoreTasks(conn, ids, new Date());
      if (listIds.length === 0) {
        publish(null);
      } else {
        for (const listId of listIds) publish(listId);
      }
      return { ok: true as const };
    },

    deleteTask({ id }) {
      const { listId } = db.deleteTask(conn, id);
      drainImages();
      publish(listId);
      return { ok: true as const };
    },

    createList({ name }) {
      const list = db.createList(conn, name, new Date());
      publish(list.id);
      return { list };
    },

    renameList({ id, name }) {
      const lists = db.renameList(conn, id, name, new Date());
      publish(id);
      return { lists };
    },

    deleteList({ id }) {
      const lists = db.deleteList(conn, id, new Date());
      drainImages();
      publish(id);
      return { lists };
    },

    reorderLists({ ids }) {
      const lists = db.reorderLists(conn, ids, new Date());
      publish(null);
      return { lists };
    },

    clearArchive({ listId }) {
      const deleted = db.clearArchive(conn, listId);
      drainImages();
      publish(listId);
      return { deleted };
    },

    // Tags are global — every mutation publishes on the whole board (null),
    // since any open list's picker/chips could be showing the changed tag.
    createTag(input) {
      const tag = db.createTag(conn, input, new Date());
      publish(null);
      return { tag };
    },

    updateTag(input) {
      const tag = db.updateTag(conn, input, new Date());
      publish(null);
      return { tag };
    },

    deleteTag({ id }) {
      db.deleteTag(conn, id);
      publish(null);
      return { ok: true as const };
    },

    reorderTags({ ids }) {
      const tags = db.reorderTags(conn, ids);
      publish(null);
      return { tags };
    },

    setTaskTags({ taskId, tagIds }) {
      const task = db.setTaskTags(conn, taskId, tagIds, new Date());
      publish(task.listId);
      return { task };
    },

    createProject(input) {
      const project = db.createProject(conn, input, new Date());
      publish(project.listId);
      return { project };
    },

    updateProject(input) {
      const project = db.updateProject(conn, input, new Date());
      publish(project.listId);
      return { project };
    },

    deleteProject({ id }) {
      const { listId } = db.deleteProject(conn, id);
      publish(listId);
      return { ok: true as const };
    },

    reorderProjects({ listId, ids }) {
      const projects = db.reorderProjects(conn, listId, ids, new Date());
      publish(listId);
      return { projects };
    },

    setProjectCollapsed({ id, collapsed, column }) {
      const { listId } = db.setProjectCollapsed(conn, id, collapsed, column);
      publish(listId);
      return { ok: true as const };
    },
  });

  bb.onDispose(() => {
    bb.log.info("todo plugin disposed");
  });
}
