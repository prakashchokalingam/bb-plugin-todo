import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
      stage: "pending",
      title: "Write the report",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    expect(created.task.title).toBe("Write the report");
    expect(created.task.stage).toBe("pending");

    await harness.callRpc("moveTask", {
      id: created.task.id,
      stage: "in_progress",
      parentId: null,
      beforeId: null,
      afterId: null,
    });
    let boardAfterMove = await getBoard(harness, listId);
    let movedDto = boardAfterMove.backlog.tasks.find((t: any) => t.id === created.task.id);
    expect(movedDto.stage).toBe("in_progress");
    expect(movedDto.inProgress).toBe(true);

    const completed = (await harness.callRpc("completeTask", { id: created.task.id })) as any;
    expect(completed.completedIds).toEqual([created.task.id]);
    let boardAfterComplete = await getBoard(harness, listId);
    expect(boardAfterComplete.backlog.tasks.map((t: any) => t.id)).not.toContain(created.task.id); // done, vanished
    expect(boardAfterComplete.inProgress.completed).toBe(1);

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
        stage: "pending",
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
      stage: "pending",
      title: "Parent",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    const child = (await harness.callRpc("createTask", {
      listId,
      stage: "pending",
      title: "Child",
      parentId: parent.task.id,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    await expect(
      harness.callRpc("createTask", {
        listId,
        stage: "pending",
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
      stage: "pending",
      title: "A",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    const b = (await harness.callRpc("createTask", {
      listId,
      stage: "pending",
      title: "B",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    await harness.callRpc("moveTask", {
      id: b.task.id,
      stage: "pending",
      parentId: a.task.id,
      beforeId: null,
      afterId: null,
    });
    await expect(
      harness.callRpc("moveTask", {
        id: a.task.id,
        stage: "pending",
        parentId: b.task.id,
        beforeId: null,
        afterId: null,
      }),
    ).rejects.toBeTruthy();
  });

  // There is no more carry-forward/rollover: In Progress membership is
  // solely `stage = 'in_progress'`, which never goes stale with the
  // passage of a calendar day, so repeated getBoard calls the same (or a
  // later) day must never mutate a row's carriedDays on their own — only an
  // actual stage flip (moveTask/setTaskStage) does that.
  it("repeated getBoard calls never mutate a row's carriedDays or stage on their own", async () => {
    const { harness } = await setup();
    const board1 = await getBoard(harness);
    const listId = board1.activeListId;
    const created = (await harness.callRpc("createTask", {
      listId,
      stage: "in_progress",
      title: "scheduled",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;

    const boardA = await getBoard(harness, listId);
    const boardB = await getBoard(harness, listId);
    const rowA = boardA.backlog.tasks.find((t: any) => t.id === created.task.id);
    const rowB = boardB.backlog.tasks.find((t: any) => t.id === created.task.id);
    expect(rowA.carriedDays).toBe(rowB.carriedDays);
    expect(rowA.stage).toBe("in_progress");
    expect(rowB.stage).toBe("in_progress");
  });

  // Regression: an open, overdue, stage='pending' task must be ABSENT from
  // In Progress — a due date, however overdue, never grants membership.
  it("an open, overdue, stage='pending' task is absent from In Progress", async () => {
    const { bb, harness } = await setup();
    const board1 = await getBoard(harness);
    const listId = board1.activeListId;

    const conn = bb.storage.database();
    const overdueId = "tsk_regress_overdue_pending_0001";
    conn
      .prepare(
        `INSERT INTO tasks (id, list_id, parent_id, title, notes, stage, sort_order, due_at, has_due_time, status, completed_at, carried_count, created_at, updated_at)
         VALUES (?, ?, NULL, 'overdue, never scheduled', NULL, 'pending', 999999, ?, 1, 'open', NULL, 0, 0, 0)`,
      )
      .run(overdueId, listId, new Date(2020, 0, 1).getTime());

    const board2 = await getBoard(harness, listId);
    const row = board2.backlog.tasks.find((t: any) => t.id === overdueId);
    expect(row).toBeDefined();
    expect(row.stage).toBe("pending");
    expect(row.inProgress).toBe(false);
  });

  // Regression: inProgress.planned/completed must be derived from the same
  // predicate as inProgress (the per-row flag), so they can never disagree —
  // including for subtasks, which planned counts but only nest under
  // backlog.tasks.
  it("inProgress.planned/completed can never disagree with the count of inProgress rows across backlog.tasks (including subtasks)", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;

    const parent = (await harness.callRpc("createTask", {
      listId,
      stage: "in_progress",
      title: "parent",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    await harness.callRpc("createTask", {
      listId,
      stage: "in_progress",
      title: "child",
      parentId: parent.task.id,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    });

    const after = await getBoard(harness, listId);
    const openInProgressCount = after.backlog.tasks.reduce(
      (sum: number, t: any) => sum + (t.inProgress ? 1 : 0) + t.subtasks.filter((s: any) => s.inProgress).length,
      0,
    );
    expect(after.inProgress.planned).toBe(openInProgressCount);
    expect(after.inProgress.completed).toBe(0);
  });

  it("archive grouping and clearArchive", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;
    const created = (await harness.callRpc("createTask", {
      listId,
      stage: "pending",
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
      stage: "pending",
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
      stage: "pending",
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
      stage: "pending",
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
    expect(afterCollapse.inProgressCollapsed).toBe(false); // the other column's bit is untouched

    // Filing a task, then deleting the project, releases it to loose rather
    // than deleting it (invariant 6, exercised end-to-end through the RPC).
    const filedTask = (await harness.callRpc("createTask", {
      listId,
      stage: "pending",
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
  // the write to exactly one of `collapsed` / `inProgressCollapsed`.
  it("setProjectCollapsed({ column }) writes only that column's collapse bit, over RPC, and still publishes board", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;
    const project = (await harness.callRpc("createProject", { listId, name: "Q3 Launch", color: "blue" })) as any;
    expect(project.project.collapsed).toBe(false);
    expect(project.project.inProgressCollapsed).toBe(false);

    const before = harness.realtimeSignals.length;
    const inProgressCollapsed = (await harness.callRpc("setProjectCollapsed", {
      id: project.project.id,
      collapsed: true,
      column: "in_progress",
    })) as any;
    expect(inProgressCollapsed.ok).toBe(true);
    const signals = harness.realtimeSignals.slice(before);
    expect(signals.at(-1)?.channel).toBe("board");
    expect((signals.at(-1)?.payload as any).listId).toBe(listId);

    let board2 = await getBoard(harness, listId);
    let found = board2.projects.find((p: any) => p.id === project.project.id);
    expect(found.inProgressCollapsed).toBe(true);
    expect(found.collapsed).toBe(false); // backlog's bit is untouched by an in-progress write

    // And the mirror: a backlog write leaves in progress's bit alone.
    await harness.callRpc("setProjectCollapsed", {
      id: project.project.id,
      collapsed: true,
      column: "backlog",
    });
    board2 = await getBoard(harness, listId);
    found = board2.projects.find((p: any) => p.id === project.project.id);
    expect(found.collapsed).toBe(true);
    expect(found.inProgressCollapsed).toBe(true); // unchanged from the earlier in-progress write, not reset
  });

  it("moveTask + projectId re-homes a task and its trail; a plain Backlog drop snaps it back to its own slot", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;

    const project = (await harness.callRpc("createProject", { listId, name: "Q3 Launch", color: "blue" })) as any;
    const otherProject = (await harness.callRpc("createProject", { listId, name: "Other", color: "red" })) as any;
    const task = (await harness.callRpc("createTask", {
      listId,
      stage: "pending",
      title: "Rewrite the onboarding email",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
      projectId: project.project.id,
    })) as any;

    // Schedule it — it stays filed under `project`, comprehensive Backlog
    // means it's the same row, just now stage='in_progress'/inProgress.
    await harness.callRpc("moveTask", {
      id: task.task.id,
      stage: "in_progress",
      parentId: null,
      beforeId: null,
      afterId: null,
    });
    let afterSchedule = await getBoard(harness, listId);
    let scheduledRow = afterSchedule.backlog.tasks.find((t: any) => t.id === task.task.id);
    expect(scheduledRow.stage).toBe("in_progress");
    expect(scheduledRow.inProgress).toBe(true);
    expect(scheduledRow.trail.projectId).toBe(project.project.id);
    expect(scheduledRow.trail.projectName).toBe("Q3 Launch");

    // Unschedule with no projectId: snaps home, stays in `project`.
    await harness.callRpc("moveTask", {
      id: task.task.id,
      stage: "pending",
      parentId: null,
      beforeId: null,
      afterId: null,
    });
    let afterSnapHome = await getBoard(harness, listId);
    let snapped = afterSnapHome.backlog.tasks.find((t: any) => t.id === task.task.id);
    expect(snapped.projectId).toBe(project.project.id);
    expect(snapped.stage).toBe("pending");
    expect(snapped.inProgress).toBe(false);

    // Re-home to a different project.
    await harness.callRpc("moveTask", {
      id: task.task.id,
      stage: "pending",
      parentId: null,
      beforeId: null,
      afterId: null,
      projectId: otherProject.project.id,
    });
    const afterRehome = await getBoard(harness, listId);
    const rehomed = afterRehome.backlog.tasks.find((t: any) => t.id === task.task.id);
    expect(rehomed.projectId).toBe(otherProject.project.id);
  });

  it("scheduling a subtask into In Progress keeps its parent_id and shows it as a flat, trailed row — the parent is not scheduled", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;

    const parent = (await harness.callRpc("createTask", {
      listId,
      stage: "pending",
      title: "Rewrite the onboarding email",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    const child = (await harness.callRpc("createTask", {
      listId,
      stage: "pending",
      title: "Get legal sign-off",
      parentId: parent.task.id,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;

    await harness.callRpc("moveTask", {
      id: child.task.id,
      stage: "in_progress",
      parentId: parent.task.id,
      beforeId: null,
      afterId: null,
    });

    const after = await getBoard(harness, listId);
    const parentRow = after.backlog.tasks.find((t: any) => t.id === parent.task.id);
    expect(parentRow.stage).toBe("pending"); // scheduling the subtask did not schedule the parent
    const childRow = parentRow.subtasks.find((t: any) => t.id === child.task.id);
    expect(childRow.stage).toBe("in_progress");
    expect(childRow.inProgress).toBe(true);
    expect(childRow.trail.parentTitle).toBe("Rewrite the onboarding email");
  });

  it("in-progress counts survive completion vanishing rows from the board", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;
    const t1 = (await harness.callRpc("createTask", {
      listId,
      stage: "in_progress",
      title: "one",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;
    await harness.callRpc("createTask", {
      listId,
      stage: "in_progress",
      title: "two",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    });
    await harness.callRpc("completeTask", { id: t1.task.id });

    const after = await getBoard(harness, listId);
    expect(after.inProgress.planned).toBe(2);
    expect(after.inProgress.completed).toBe(1);
    const openInProgress = after.backlog.tasks.filter((t: any) => t.inProgress).length;
    expect(openInProgress).toBe(1); // t1 done and vanished; t2 still open and inProgress
  });

  // setTaskStage("pending") flips stage away from In Progress and RESETS
  // the carried-days clock — an auto-included/due-date row is no longer a
  // thing that can exist, so this only ever affects a genuinely
  // manually-scheduled row.
  it("setTaskStage(\"pending\") flips stage, resets carriedDays, and publishes a board realtime signal", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;

    const scheduled = (await harness.callRpc("createTask", {
      listId,
      stage: "in_progress",
      title: "scheduled",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;

    const beforePark = await getBoard(harness, listId);
    const beforeDto = beforePark.backlog.tasks.find((t: any) => t.id === scheduled.task.id);
    expect(beforeDto.inProgress).toBe(true);

    const before = harness.realtimeSignals.length;
    const result = (await harness.callRpc("setTaskStage", { id: scheduled.task.id, stage: "pending" })) as any;
    expect(result.ok).toBe(true);
    const signals = harness.realtimeSignals.slice(before);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.at(-1)?.channel).toBe("board");
    expect((signals.at(-1)?.payload as any).listId).toBe(listId);

    const afterPark = await getBoard(harness, listId);
    const afterDto = afterPark.backlog.tasks.find((t: any) => t.id === scheduled.task.id);
    expect(afterDto.inProgress).toBe(false);
    expect(afterDto.stage).toBe("pending");
    expect(afterDto.carriedDays).toBe(0); // the counter resets on park

    await expect(harness.callRpc("setTaskStage", { id: "tsk_missing", stage: "pending" })).rejects.toBeTruthy();
  });

  // The other direction: setTaskStage("in_progress") is a plain manual
  // schedule — stamps in_progress_since to now and publishes board like
  // every other mutation.
  it("setTaskStage(\"in_progress\") manually schedules a task and publishes a board realtime signal", async () => {
    const { harness } = await setup();
    const board = await getBoard(harness);
    const listId = board.activeListId;

    const task = (await harness.callRpc("createTask", {
      listId,
      stage: "pending",
      title: "not due, not scheduled",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
    })) as any;

    const before = await getBoard(harness, listId);
    const beforeDto = before.backlog.tasks.find((t: any) => t.id === task.task.id);
    expect(beforeDto.inProgress).toBe(false);

    const beforeSignals = harness.realtimeSignals.length;
    const result = (await harness.callRpc("setTaskStage", { id: task.task.id, stage: "in_progress" })) as any;
    expect(result.ok).toBe(true);
    const signals = harness.realtimeSignals.slice(beforeSignals);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.at(-1)?.channel).toBe("board");
    expect((signals.at(-1)?.payload as any).listId).toBe(listId);

    const after = await getBoard(harness, listId);
    const afterDto = after.backlog.tasks.find((t: any) => t.id === task.task.id);
    expect(afterDto.stage).toBe("in_progress");
    expect(afterDto.inProgress).toBe(true);
    expect(afterDto.carriedDays).toBe(0); // just entered, same day
  });
});

// ---------------------------------------------------------------------------
// Image attachments: RPC + the authenticated bytes route
// ---------------------------------------------------------------------------

const PNG_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 3),
]).toString("base64");

describe("server.ts image attachments", () => {
  async function withBoard() {
    const { bb, harness } = await setup();
    const board = await getBoard(harness);
    const imagesDir = join(dirname(bb.storage.database().name), "images");
    const create = (input: Record<string, unknown> = {}) =>
      harness.callRpc("createTask", {
        listId: board.activeListId,
        stage: "pending",
        title: "with image",
        parentId: null,
        dueAt: null,
        hasDueTime: false,
        position: "bottom",
        ...input,
      }) as Promise<any>;
    return { bb, harness, board, imagesDir, create };
  }

  it("creates a task with images and returns metadata only", async () => {
    const { create, imagesDir } = await withBoard();
    const { task } = await create({ images: [{ data: PNG_B64 }] });
    expect(task.images).toHaveLength(1);
    expect(task.images[0]).toEqual({
      id: expect.stringMatching(/^img_/),
      mime: "image/png",
      size: 32,
      createdAt: expect.any(Number),
      url: `/api/v1/plugins/todo/http/image?id=${task.images[0].id}`,
    });
    expect(JSON.stringify(task)).not.toContain(PNG_B64);
    expect(readdirSync(imagesDir)).toEqual([`${task.images[0].id}.png`]);
  });

  it("serves the bytes with safe headers, by query id", async () => {
    const { harness, create } = await withBoard();
    const { task } = await create({ images: [{ data: PNG_B64 }] });
    const res = await harness.fetchHttp("GET", `/image?id=${task.images[0].id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(Buffer.from(await res.arrayBuffer()).toString("base64")).toBe(PNG_B64);
  });

  it("returns 404 for unknown, malformed, and missing ids, and for a deleted task", async () => {
    const { harness, create } = await withBoard();
    const { task } = await create({ images: [{ data: PNG_B64 }] });
    const id = task.images[0].id;
    expect((await harness.fetchHttp("GET", "/image")).status).toBe(404);
    expect((await harness.fetchHttp("GET", "/image?id=img_00000000000000000000zz")).status).toBe(404);
    expect((await harness.fetchHttp("GET", "/image?id=../../data.db")).status).toBe(404);
    // Exact-match routes: a path-param style URL is not a route at all.
    await expect(harness.fetchHttp("GET", `/image/${id}`)).rejects.toThrow(/no http route/);
    await harness.callRpc("deleteTask", { id: task.id });
    expect((await harness.fetchHttp("GET", `/image?id=${id}`)).status).toBe(404);
  });

  it("rejects an invalid image and creates no task or file", async () => {
    const { harness, board, create, imagesDir } = await withBoard();
    await expect(create({ images: [{ data: Buffer.from("<svg/>").toString("base64") }] })).rejects.toThrow(
      /PNG, JPEG, GIF, or WebP/,
    );
    expect((await getBoard(harness, board.activeListId)).backlog.tasks).toEqual([]);
    expect(readdirSync(imagesDir)).toEqual([]);
  });

  it("adds and removes images through updateTask, deleting the removed file", async () => {
    const { harness, create, imagesDir } = await withBoard();
    const { task } = await create({ images: [{ data: PNG_B64 }] });
    const first = task.images[0].id;
    const { task: updated } = (await harness.callRpc("updateTask", {
      id: task.id,
      title: "edited",
      addImages: [{ data: PNG_B64 }],
      removeImageIds: [first],
    })) as any;
    expect(updated.title).toBe("edited");
    expect(updated.images).toHaveLength(1);
    expect(updated.images[0].id).not.toBe(first);
    expect(readdirSync(imagesDir)).toEqual([`${updated.images[0].id}.png`]);
  });

  it("deletes files on task delete, list delete, and clear archive", async () => {
    const { harness, board, create, imagesDir } = await withBoard();
    const a = (await create({ images: [{ data: PNG_B64 }] })).task;
    await harness.callRpc("deleteTask", { id: a.id });
    expect(readdirSync(imagesDir)).toEqual([]);

    const b = (await create({ images: [{ data: PNG_B64 }] })).task;
    await harness.callRpc("completeTask", { id: b.id });
    expect(readdirSync(imagesDir)).toHaveLength(1); // archive keeps it
    await harness.callRpc("clearArchive", { listId: board.activeListId });
    expect(readdirSync(imagesDir)).toEqual([]);

    const { list } = (await harness.callRpc("createList", { name: "Scratch" })) as any;
    await harness.callRpc("createTask", {
      listId: list.id,
      stage: "pending",
      title: "in scratch",
      parentId: null,
      dueAt: null,
      hasDueTime: false,
      position: "bottom",
      images: [{ data: PNG_B64 }],
    });
    expect(readdirSync(imagesDir)).toHaveLength(1);
    await harness.callRpc("deleteList", { id: list.id });
    expect(readdirSync(imagesDir)).toEqual([]);
  });

  it("registers a cleanup schedule that removes abandoned files after the grace period", async () => {
    const { harness, imagesDir } = await withBoard();
    const orphan = join(imagesDir, "img_00000000000000000000cc.png");
    writeFileSync(orphan, "orphan");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(orphan, old, old);
    await harness.runSchedule("image-cleanup");
    expect(existsSync(orphan)).toBe(false);
  });
});
