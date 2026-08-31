import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import plugin from "./server.js";

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  await plugin(bb);
  return { bb, harness };
}

async function getBoard(harness: Awaited<ReturnType<typeof setup>>["harness"], listId: string | null = null) {
  return harness.callRpc("getBoard", { listId }) as Promise<any>;
}

describe("server.ts rpc surface", () => {
  it("seeds Work and Personal on first load", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    expect(board.lists.map((l: any) => l.name)).toEqual(["Work", "Personal"]);
    expect(board.activeListId).toBe(board.lists[0].id);
  });

  it("create -> move -> complete -> restore -> delete round-trip", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;

    const created = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "Write the report",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    expect(created.task.title).toBe("Write the report");
    expect(created.task.bucket).toBe("backlog");

    await harness.callRpc("moveTask", {
      id: created.task.id,
      bucket: "today",
      parentId: null,
      beforeId: null,
      afterId: null,
    });
    let boardAfterMove = await getBoard(harness, listId);
    let movedDto = boardAfterMove.backlog.tasks.find((t: any) => t.id === created.task.id);
    expect(movedDto.bucket).toBe("today");
    expect(movedDto.inToday).toBe(true);

    const completed = (await harness.callRpc("completeTask", { id: created.task.id })) as any;
    expect(completed.completedIds).toEqual([created.task.id]);
    let boardAfterComplete = await getBoard(harness, listId);
    expect(boardAfterComplete.backlog.tasks.map((t: any) => t.id)).not.toContain(created.task.id); // done, vanished
    expect(boardAfterComplete.today.completed).toBe(1);

    await harness.callRpc("restoreTasks", { ids: completed.completedIds });
    let boardAfterRestore = await getBoard(harness, listId);
    expect(boardAfterRestore.backlog.tasks.map((t: any) => t.id)).toContain(created.task.id);

    await harness.callRpc("deleteTask", { id: created.task.id });
    let boardAfterDelete = await getBoard(harness, listId);
    expect(boardAfterDelete.backlog.tasks.map((t: any) => t.id)).not.toContain(created.task.id);
  });

  it("rejects an empty title on createTask", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    await expect(
      harness.callRpc("createTask", {
        listId: board.activeListId,
        bucket: "backlog",
        title: "   ",
        parentId: null,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      }),
    ).rejects.toBeTruthy();
  });

  it("rejects a parentId that is itself a subtask", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;
    const parent = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "Parent",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    const child = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "Child",
      parentId: parent.task.id,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    await expect(
      harness.callRpc("createTask", {
        listId,
        bucket: "backlog",
        title: "Grandchild",
        parentId: child.task.id,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
      }),
    ).rejects.toBeTruthy();
  });

  it("rejects a moveTask that would create a cycle", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;
    const a = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "A",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    const b = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "B",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    await harness.callRpc("moveTask", {
      id: b.task.id,
      bucket: "backlog",
      parentId: a.task.id,
      beforeId: null,
      afterId: null,
    });
    await expect(
      harness.callRpc("moveTask", {
        id: a.task.id,
        bucket: "backlog",
        parentId: b.task.id,
        beforeId: null,
        afterId: null,
      }),
    ).rejects.toBeTruthy();
  });

  it("rollover is idempotent across repeated getBoard calls the same day", async () => {
    const { harness } = await setup();
    const board1 = await getBoard(harness);
    const board2 = await getBoard(harness);
    expect(board2.today.day).toBe(board1.today.day);
  });

  // Regression: a stale rollover:lastDay kv key (already "today" from an
  // earlier getBoard call) must never gate the carry-forward UPDATE. A row
  // that becomes stale AFTER the day's first getBoard call — inserted
  // directly, or a slept machine catching up mid-day — has to be rolled by
  // the very next getBoard, not left dangling until the kv key itself
  // changes.
  it("rolls forward a row that goes stale after the kv key is already set to today", async () => {
    const { bb, harness } = await setup();
    const board1 = await getBoard(harness);
    const listId = board1.activeListId;

    // getBoard already ran once above, so rollover:lastDay is now "today" —
    // exactly the state that used to short-circuit the lazy rollover.
    const conn = bb.storage.database();
    const staleId = "tsk_regress_stale_guard_hole_0001";
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, bucket, day, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
         VALUES (?, ?, NULL, 'stale row', NULL, 'today', '2020-01-01', 999999, NULL, 0, 'open', NULL, 3, 0, 0)`,
      )
      .run(staleId, listId);

    const board2 = await getBoard(harness, listId);
    const row = board2.backlog.tasks.find((t: any) => t.id === staleId);
    expect(row).toBeDefined();
    expect(row.day).toBe(board2.today.day);
    expect(row.carriedCount).toBe(4);
    // The Today counter and the Today membership flag must agree: the row
    // that shows up as inToday is counted in planned.
    expect(row.inToday).toBe(true);
    expect(board2.today.planned).toBeGreaterThan(0);
  });

  // Regression: today.planned/completed must be derived from the same
  // predicate as inToday, so they can never disagree — including for
  // subtasks, which planned counts but only nest under backlog.tasks.
  it("today.planned/completed can never disagree with the count of inToday rows across backlog.tasks (including subtasks)", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;

    const parent = (await harness.callRpc("createTask", {
      listId,
      bucket: "today",
      title: "parent",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    await harness.callRpc("createTask", {
      listId,
      bucket: "today",
      title: "child",
      parentId: parent.task.id,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    });

    const after = await getBoard(harness, listId);
    const openInTodayCount = after.backlog.tasks.reduce(
      (sum: number, t: any) => sum + (t.inToday ? 1 : 0) + t.subtasks.filter((s: any) => s.inToday).length,
      0,
    );
    expect(after.today.planned).toBe(openInTodayCount);
    expect(after.today.completed).toBe(0);
  });

  it("archive grouping and clearArchive", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;
    const created = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "Archive me",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    await harness.callRpc("completeTask", { id: created.task.id });

    const archive = (await harness.callRpc("getArchive", { listId, limit: 100, offset: 0 })) as any;
    expect(archive.total).toBe(1);
    expect(archive.groups[0].tasks[0].id).toBe(created.task.id);

    const cleared = (await harness.callRpc("clearArchive", { listId })) as any;
    expect(cleared.deleted).toBe(1);
    const archiveAfter = (await harness.callRpc("getArchive", { listId, limit: 100, offset: 0 })) as any;
    expect(archiveAfter.total).toBe(0);
  });

  it("list CRUD and last-list refusal", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    expect(board.lists.length).toBe(2);

    const created = (await harness.callRpc("createList", { name: "Side project" })) as any;
    expect(created.list.name).toBe("Side project");

    const renamed = (await harness.callRpc("renameList", {
      id: created.list.id,
      name: "Renamed",
    })) as any;
    expect(renamed.lists.find((l: any) => l.id === created.list.id).name).toBe("Renamed");

    // Delete down to one list, then refuse the last one.
    const afterFirstDelete = (await harness.callRpc("deleteList", { id: board.lists[1].id })) as any;
    expect(afterFirstDelete.lists.length).toBe(2);
    const afterSecondDelete = (await harness.callRpc("deleteList", { id: created.list.id })) as any;
    expect(afterSecondDelete.lists.length).toBe(1);
    await expect(harness.callRpc("deleteList", { id: afterSecondDelete.lists[0].id })).rejects.toBeTruthy();
  });

  it("publishes a board realtime signal on every mutation", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const before = harness.realtimeSignals.length;
    await harness.callRpc("createTask", {
      listId: board.activeListId,
      bucket: "backlog",
      title: "Signal check",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    });
    const signals = harness.realtimeSignals.slice(before);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].channel).toBe("board");
    expect((signals[0].payload as any).listId).toBe(board.activeListId);
  });

  it("createTag / updateTag / deleteTag / reorderTags / setTaskTags round-trip and reject malformed input", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;

    const createdTag = (await harness.callRpc("createTag", { name: "urgent", color: "red" })) as any;
    expect(createdTag.tag.name).toBe("urgent");
    expect(createdTag.tag.color).toBe("red");
    expect(createdTag.tag.taskCount).toBe(0);

    // Bad color key is rejected at the contract boundary.
    await expect(harness.callRpc("createTag", { name: "other", color: "chartreuse" })).rejects.toBeTruthy();

    const secondTag = (await harness.callRpc("createTag", { name: "bug", color: "amber" })) as any;

    const updated = (await harness.callRpc("updateTag", {
      id: createdTag.tag.id,
      name: "urgent-ish",
      color: "violet",
    })) as any;
    expect(updated.tag.name).toBe("urgent-ish");
    expect(updated.tag.color).toBe("violet");

    // Unknown id is rejected.
    await expect(harness.callRpc("updateTag", { id: "tag_missing", name: "x" })).rejects.toBeTruthy();

    const reordered = (await harness.callRpc("reorderTags", {
      ids: [secondTag.tag.id, updated.tag.id],
    })) as any;
    expect(reordered.tags.map((t: any) => t.id)).toEqual([secondTag.tag.id, updated.tag.id]);

    const created = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "Tag me",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;

    const tagged = (await harness.callRpc("setTaskTags", {
      taskId: created.task.id,
      tagIds: [secondTag.tag.id, updated.tag.id],
    })) as any;
    expect(tagged.task.tags.map((t: any) => t.id)).toEqual([secondTag.tag.id, updated.tag.id]);

    // Unknown tag id is rejected.
    await expect(
      harness.callRpc("setTaskTags", { taskId: created.task.id, tagIds: ["tag_missing"] }),
    ).rejects.toBeTruthy();

    const deleted = (await harness.callRpc("deleteTag", { id: secondTag.tag.id })) as any;
    expect(deleted.ok).toBe(true);

    const boardAfterDelete = await getBoard(harness, listId);
    expect(boardAfterDelete.tags.map((t: any) => t.id)).not.toContain(secondTag.tag.id);
    const taskAfterTagDelete = boardAfterDelete.backlog.tasks.find((t: any) => t.id === created.task.id);
    expect(taskAfterTagDelete.tags.map((t: any) => t.id)).toEqual([updated.tag.id]);
  });

  it("tag mutations publish a board-wide realtime signal (listId: null); setTaskTags publishes the task's listId", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);

    const before = harness.realtimeSignals.length;
    const tag = (await harness.callRpc("createTag", { name: "focus", color: "blue" })) as any;
    const afterCreate = harness.realtimeSignals.slice(before);
    expect(afterCreate.at(-1)?.channel).toBe("board");
    expect((afterCreate.at(-1)?.payload as any).listId).toBeNull();

    const created = (await harness.callRpc("createTask", {
      listId: board.activeListId,
      bucket: "backlog",
      title: "Tag signal check",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;

    const beforeSetTags = harness.realtimeSignals.length;
    await harness.callRpc("setTaskTags", { taskId: created.task.id, tagIds: [tag.tag.id] });
    const afterSetTags = harness.realtimeSignals.slice(beforeSetTags);
    expect(afterSetTags.at(-1)?.channel).toBe("board");
    expect((afterSetTags.at(-1)?.payload as any).listId).toBe(board.activeListId);
  });

  it("createProject / updateProject / reorderProjects / setProjectCollapsed / deleteProject round-trip via RPC", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;
    expect(board.projects).toEqual([]);

    const created = (await harness.callRpc("createProject", {
      listId,
      name: "Q3 Launch",
      color: "blue",
    })) as any;
    expect(created.project.name).toBe("Q3 Launch");
    expect(created.project.color).toBe("blue");
    expect(created.project.collapsed).toBe(false);

    const secondProject = (await harness.callRpc("createProject", {
      listId,
      name: "Personal errands",
      color: "green",
    })) as any;

    const updated = (await harness.callRpc("updateProject", {
      id: created.project.id,
      name: "Q3 Launch (revised)",
      color: "violet",
    })) as any;
    expect(updated.project.name).toBe("Q3 Launch (revised)");
    expect(updated.project.color).toBe("violet");

    await expect(harness.callRpc("updateProject", { id: "prj_missing", name: "x" })).rejects.toBeTruthy();

    const reordered = (await harness.callRpc("reorderProjects", {
      listId,
      ids: [secondProject.project.id, updated.project.id],
    })) as any;
    expect(reordered.projects.map((p: any) => p.id)).toEqual([secondProject.project.id, updated.project.id]);

    const collapsed = (await harness.callRpc("setProjectCollapsed", {
      id: updated.project.id,
      collapsed: true,
      column: "backlog",
    })) as any;
    expect(collapsed.ok).toBe(true);
    const boardAfterCollapse = await getBoard(harness, listId);
    const afterCollapse = boardAfterCollapse.projects.find((p: any) => p.id === updated.project.id);
    expect(afterCollapse.collapsed).toBe(true);
    expect(afterCollapse.todayCollapsed).toBe(false); // the other column's bit is untouched

    // Filing a task, then deleting the project, releases it to loose rather
    // than deleting it (invariant 6, exercised end-to-end through the RPC).
    const filedTask = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "Filed task",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
      projectId: updated.project.id,
    })) as any;
    expect(filedTask.task.projectId).toBe(updated.project.id);

    const deleted = (await harness.callRpc("deleteProject", { id: updated.project.id })) as any;
    expect(deleted.ok).toBe(true);

    const boardAfterDelete = await getBoard(harness, listId);
    expect(boardAfterDelete.projects.map((p: any) => p.id)).not.toContain(updated.project.id);
    const looseTask = boardAfterDelete.backlog.tasks.find((t: any) => t.id === filedTask.task.id);
    expect(looseTask.projectId).toBeNull();
  });

  it("project mutations publish a board realtime signal scoped to the project's listId", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const before = harness.realtimeSignals.length;
    await harness.callRpc("createProject", { listId: board.activeListId, name: "Signal check", color: "red" });
    const signals = harness.realtimeSignals.slice(before);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.at(-1)?.channel).toBe("board");
    expect((signals.at(-1)?.payload as any).listId).toBe(board.activeListId);
  });

  // Regression for the reported bug: collapsing/expanding a project in one
  // column silently collapsed/expanded it in the other, because both
  // columns rendered the same single `collapsed` bit. `column` now routes
  // the write to exactly one of `collapsed` / `todayCollapsed`.
  it("setProjectCollapsed({ column }) writes only that column's collapse bit, over RPC, and still publishes board", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;
    const project = (await harness.callRpc("createProject", { listId, name: "Q3 Launch", color: "blue" })) as any;
    expect(project.project.collapsed).toBe(false);
    expect(project.project.todayCollapsed).toBe(false);

    const before = harness.realtimeSignals.length;
    const todayCollapsed = (await harness.callRpc("setProjectCollapsed", {
      id: project.project.id,
      collapsed: true,
      column: "today",
    })) as any;
    expect(todayCollapsed.ok).toBe(true);
    const signals = harness.realtimeSignals.slice(before);
    expect(signals.at(-1)?.channel).toBe("board");
    expect((signals.at(-1)?.payload as any).listId).toBe(listId);

    let board2 = await getBoard(harness, listId);
    let found = board2.projects.find((p: any) => p.id === project.project.id);
    expect(found.todayCollapsed).toBe(true);
    expect(found.collapsed).toBe(false); // backlog's bit is untouched by a today write

    // And the mirror: a backlog write leaves today's bit alone.
    await harness.callRpc("setProjectCollapsed", {
      id: project.project.id,
      collapsed: true,
      column: "backlog",
    });
    board2 = await getBoard(harness, listId);
    found = board2.projects.find((p: any) => p.id === project.project.id);
    expect(found.collapsed).toBe(true);
    expect(found.todayCollapsed).toBe(true); // unchanged from the earlier today write, not reset
  });

  it("moveTask + projectId re-homes a task and its trail; a plain Backlog drop snaps it back to its own slot", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;

    const project = (await harness.callRpc("createProject", { listId, name: "Q3 Launch", color: "blue" })) as any;
    const otherProject = (await harness.callRpc("createProject", { listId, name: "Other", color: "red" })) as any;
    const task = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "Rewrite the onboarding email",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
      projectId: project.project.id,
    })) as any;

    // Schedule it — it stays filed under `project`, comprehensive Backlog
    // means it's the same row, just now bucket='today'/inToday.
    await harness.callRpc("moveTask", {
      id: task.task.id,
      bucket: "today",
      parentId: null,
      beforeId: null,
      afterId: null,
    });
    let afterSchedule = await getBoard(harness, listId);
    let scheduledRow = afterSchedule.backlog.tasks.find((t: any) => t.id === task.task.id);
    expect(scheduledRow.bucket).toBe("today");
    expect(scheduledRow.inToday).toBe(true);
    expect(scheduledRow.trail.projectId).toBe(project.project.id);
    expect(scheduledRow.trail.projectName).toBe("Q3 Launch");

    // Unschedule with no projectId: snaps home, stays in `project`.
    await harness.callRpc("moveTask", {
      id: task.task.id,
      bucket: "backlog",
      parentId: null,
      beforeId: null,
      afterId: null,
    });
    let afterSnapHome = await getBoard(harness, listId);
    let snapped = afterSnapHome.backlog.tasks.find((t: any) => t.id === task.task.id);
    expect(snapped.projectId).toBe(project.project.id);
    expect(snapped.bucket).toBe("backlog");
    expect(snapped.inToday).toBe(false);

    // Re-home to a different project.
    await harness.callRpc("moveTask", {
      id: task.task.id,
      bucket: "backlog",
      parentId: null,
      beforeId: null,
      afterId: null,
      projectId: otherProject.project.id,
    });
    const afterRehome = await getBoard(harness, listId);
    const rehomed = afterRehome.backlog.tasks.find((t: any) => t.id === task.task.id);
    expect(rehomed.projectId).toBe(otherProject.project.id);
  });

  it("scheduling a subtask into Today keeps its parent_id and shows it as a flat, trailed row — the parent is not scheduled", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;

    const parent = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "Rewrite the onboarding email",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    const child = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "Get legal sign-off",
      parentId: parent.task.id,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;

    await harness.callRpc("moveTask", {
      id: child.task.id,
      bucket: "today",
      parentId: parent.task.id,
      beforeId: null,
      afterId: null,
    });

    const after = await getBoard(harness, listId);
    const parentRow = after.backlog.tasks.find((t: any) => t.id === parent.task.id);
    expect(parentRow.bucket).toBe("backlog"); // scheduling the subtask did not schedule the parent
    const childRow = parentRow.subtasks.find((t: any) => t.id === child.task.id);
    expect(childRow.bucket).toBe("today");
    expect(childRow.inToday).toBe(true);
    expect(childRow.trail.parentTitle).toBe("Rewrite the onboarding email");
  });

  it("today counts survive completion vanishing rows from the board", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;
    const t1 = (await harness.callRpc("createTask", {
      listId,
      bucket: "today",
      title: "one",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    await harness.callRpc("createTask", {
      listId,
      bucket: "today",
      title: "two",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    });
    await harness.callRpc("completeTask", { id: t1.task.id });

    const after = await getBoard(harness, listId);
    expect(after.today.planned).toBe(2);
    expect(after.today.completed).toBe(1);
    const openInToday = after.backlog.tasks.filter((t: any) => t.inToday).length;
    expect(openInToday).toBe(1); // t1 done and vanished; t2 still open and inToday
  });

  it("dismissFromToday stamps today_dismissed_day so an auto-included row stops rendering inToday, and publishes a board realtime signal", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;

    const overdue = (await harness.callRpc("createTask", {
      listId,
      bucket: "backlog",
      title: "overdue, never scheduled",
      parentId: null,
      dueAt: Date.now() - 1000 * 60 * 60 * 24 * 3,
      hasDueTime: false,
      position: "bottom",
    })) as any;

    const beforeDismiss = await getBoard(harness, listId);
    const beforeDto = beforeDismiss.backlog.tasks.find((t: any) => t.id === overdue.task.id);
    expect(beforeDto.inToday).toBe(true);

    const before = harness.realtimeSignals.length;
    const result = (await harness.callRpc("dismissFromToday", { id: overdue.task.id })) as any;
    expect(result.ok).toBe(true);
    const signals = harness.realtimeSignals.slice(before);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.at(-1)?.channel).toBe("board");
    expect((signals.at(-1)?.payload as any).listId).toBe(listId);

    const afterDismiss = await getBoard(harness, listId);
    const afterDto = afterDismiss.backlog.tasks.find((t: any) => t.id === overdue.task.id);
    expect(afterDto.inToday).toBe(false);
    expect(afterDto.bucket).toBe("backlog"); // dismissFromToday never touches bucket

    await expect(harness.callRpc("dismissFromToday", { id: "tsk_missing" })).rejects.toBeTruthy();
  });
});
