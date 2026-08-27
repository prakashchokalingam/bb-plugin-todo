// bb-plugin-todo — server entry. Thin wiring only: open the db, migrate,
// seed, register the rpc contract, schedule the rollover cron, and publish
// realtime signals after mutations. All SQL and business logic live under
// lib/.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract.js";

// Re-exported so app.tsx's `import type { rpcContract } from "./server"`
// (the scaffold's frontend wiring, out of scope here) keeps resolving.
// contract.ts remains the single source of truth.
export { rpcContract } from "./contract.js";
import * as db from "./lib/db.js";
import { localDay } from "./lib/day.js";
import { runRollover } from "./lib/rollover.js";

const ROLLOVER_KV_KEY = "rollover:lastDay";

export default async function plugin(bb: BbPluginApi) {
  const conn = bb.storage.database();
  // better-sqlite3 defaults foreign_keys off; ON DELETE CASCADE is inert
  // without this.
  conn.pragma("foreign_keys = ON");
  bb.storage.migrate(conn, db.MIGRATIONS);
  db.seed(conn, new Date());

  // Lazy rollover: runs the carry-forward UPDATE unconditionally on every
  // call. `rollover:lastDay` is bookkeeping only — never a correctness
  // gate. It used to guard the call ("skip the UPDATE if we've already
  // rolled today"), but that let any row that became stale after the day's
  // first getBoard call — one created directly, or a slept machine
  // catching up mid-day — sit with a stale `day` and no carried_count bump
  // until the kv key itself changed at midnight+5. runRollover()'s UPDATE
  // is a single indexed statement that matches nothing once a row's `day`
  // is already today, so calling it unconditionally costs nothing
  // measurable and is the only way to stay correct if the kv key is stale
  // or missing, per SPEC.md.
  async function ensureRollover(now: Date): Promise<void> {
    runRollover(conn, now);
    await bb.storage.kv.set(ROLLOVER_KV_KEY, localDay(now));
  }

  function publish(listId: string | null): void {
    bb.realtime.publish("board", { listId });
  }

  bb.rpc.register(rpcContract, {
    async getBoard({ listId }) {
      const now = new Date();
      await ensureRollover(now);
      return db.getBoard(conn, listId, now);
    },

    async getArchive({ listId, limit, offset }) {
      const now = new Date();
      await ensureRollover(now);
      return db.getArchive(conn, listId, limit, offset);
    },

    createTask(input) {
      const task = db.createTask(conn, input, new Date());
      publish(task.listId);
      return { task };
    },

    updateTask(input) {
      const task = db.updateTask(conn, input, new Date());
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

    setProjectCollapsed({ id, collapsed }) {
      const { listId } = db.setProjectCollapsed(conn, id, collapsed);
      publish(listId);
      return { ok: true as const };
    },
  });

  bb.background.schedule("rollover", "5 0 * * *", async () => {
    const now = new Date();
    runRollover(conn, now);
    await bb.storage.kv.set(ROLLOVER_KV_KEY, localDay(now));
  });

  bb.onDispose(() => {
    bb.log.info("todo plugin disposed");
  });
}
