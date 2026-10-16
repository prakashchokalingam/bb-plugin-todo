import { describe, expect, it } from "vitest";
import type { ProjectDto, TaskDto } from "@/contract";
import { selectInProgressView } from "./inProgressView";

function makeTask(overrides: Partial<TaskDto> & { id: string }): TaskDto {
  return {
    listId: "lst_1",
    parentId: null,
    title: overrides.id,
    notes: null,
    stage: "pending",
    sortOrder: 1000,
    dueAt: null,
    hasDueTime: false,
    status: "open",
    completedAt: null,
    carriedDays: 0,
    createdAt: 0,
    updatedAt: 0,
    subtasks: [],
    subtaskCounts: { total: 0, done: 0 },
    tags: [],
    images: [],
    projectId: null,
    trail: null,
    inProgress: false,
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectDto> & { id: string }): ProjectDto {
  return {
    listId: "lst_1",
    name: overrides.id,
    color: "teal",
    sortOrder: 1000,
    collapsed: false,
    inProgressCollapsed: false,
    openCount: 0,
    inProgressCount: 0,
    overdueCount: 0,
    ...overrides,
  };
}

describe("selectInProgressView", () => {
  it("includes a manually scheduled top-level task (stage='in_progress', inProgress)", () => {
    const prj = makeProject({ id: "prj_1", sortOrder: 1000 });
    const task = makeTask({
      id: "tsk_1",
      stage: "in_progress",
      projectId: "prj_1",
      inProgress: true,
    });
    const view = selectInProgressView([task], [prj]);
    expect(view.projects).toHaveLength(1);
    expect(view.projects[0].project.id).toBe("prj_1");
    expect(view.projects[0].tasks.map((t) => t.id)).toEqual(["tsk_1"]);
    expect(view.projects[0].orphanSubtasks).toEqual([]);
  });

  it("includes an auto-included top-level task (stage='pending', inProgress due today/overdue)", () => {
    const prj = makeProject({ id: "prj_1" });
    const task = makeTask({
      id: "tsk_1",
      stage: "pending",
      projectId: "prj_1",
      dueAt: 1,
      inProgress: true,
    });
    const view = selectInProgressView([task], [prj]);
    expect(view.projects[0].tasks.map((t) => t.id)).toEqual(["tsk_1"]);
  });

  it("includes both a manual and an auto-included task in the same project group", () => {
    const prj = makeProject({ id: "prj_1" });
    const manual = makeTask({
      id: "tsk_manual",
      stage: "in_progress",
      projectId: "prj_1",
      inProgress: true,
    });
    const auto = makeTask({
      id: "tsk_auto",
      stage: "pending",
      projectId: "prj_1",
      dueAt: 1,
      inProgress: true,
    });
    const view = selectInProgressView([manual, auto], [prj]);
    expect(view.projects).toHaveLength(1);
    expect(view.projects[0].tasks.map((t) => t.id).sort()).toEqual(
      ["tsk_auto", "tsk_manual"].sort(),
    );
  });

  it("orphans a qualifying subtask whose parent does not qualify", () => {
    const prj = makeProject({ id: "prj_1" });
    const sub = makeTask({
      id: "tsk_sub",
      parentId: "tsk_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
    });
    const parent = makeTask({
      id: "tsk_parent",
      projectId: "prj_1",
      inProgress: false,
      subtasks: [sub],
    });
    const view = selectInProgressView([parent], [prj]);
    expect(view.projects[0].tasks).toEqual([]);
    expect(view.projects[0].orphanSubtasks.map((t) => t.id)).toEqual(["tsk_sub"]);
  });

  it("nests a qualifying subtask under its qualifying parent (no orphan)", () => {
    const prj = makeProject({ id: "prj_1" });
    const sub = makeTask({
      id: "tsk_sub",
      parentId: "tsk_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
    });
    const nonQualifyingSub = makeTask({
      id: "tsk_sub2",
      parentId: "tsk_parent",
      projectId: "prj_1",
      inProgress: false,
    });
    const parent = makeTask({
      id: "tsk_parent",
      projectId: "prj_1",
      inProgress: true,
      subtasks: [sub, nonQualifyingSub],
    });
    const view = selectInProgressView([parent], [prj]);
    expect(view.projects[0].tasks).toHaveLength(1);
    expect(view.projects[0].tasks[0].id).toBe("tsk_parent");
    // Narrowed to inProgress-only — the non-qualifying sibling is dropped,
    // not orphaned (its parent IS in In Progress; there's simply nothing to
    // show).
    expect(view.projects[0].tasks[0].subtasks.map((t) => t.id)).toEqual(["tsk_sub"]);
    expect(view.projects[0].orphanSubtasks).toEqual([]);
  });

  it("hides an empty project group (no qualifying tasks or orphans)", () => {
    const prj1 = makeProject({ id: "prj_1" });
    const prj2 = makeProject({ id: "prj_2" });
    const task = makeTask({ id: "tsk_1", projectId: "prj_1", inProgress: false });
    const view = selectInProgressView([task], [prj1, prj2]);
    expect(view.projects).toEqual([]);
  });

  it("puts a loose (projectId null) inProgress task into looseTasks", () => {
    const task = makeTask({ id: "tsk_1", projectId: null, inProgress: true, stage: "in_progress" });
    const view = selectInProgressView([task], []);
    expect(view.projects).toEqual([]);
    expect(view.looseTasks.map((t) => t.id)).toEqual(["tsk_1"]);
  });

  it("puts a loose orphan subtask (parent loose, not inProgress) into looseOrphanSubtasks", () => {
    const sub = makeTask({
      id: "tsk_sub",
      parentId: "tsk_parent",
      projectId: null,
      stage: "in_progress",
      inProgress: true,
    });
    const parent = makeTask({
      id: "tsk_parent",
      projectId: null,
      inProgress: false,
      subtasks: [sub],
    });
    const view = selectInProgressView([parent], []);
    expect(view.looseTasks).toEqual([]);
    expect(view.looseOrphanSubtasks.map((t) => t.id)).toEqual(["tsk_sub"]);
  });

  it("orders project groups by the `projects` array's sortOrder, not backlogTasks order", () => {
    const prjB = makeProject({ id: "prj_b", sortOrder: 2000 });
    const prjA = makeProject({ id: "prj_a", sortOrder: 1000 });
    const taskB = makeTask({ id: "tsk_b", projectId: "prj_b", inProgress: true, stage: "in_progress" });
    const taskA = makeTask({ id: "tsk_a", projectId: "prj_a", inProgress: true, stage: "in_progress" });
    // backlogTasks in reverse of the intended output order; `projects` is
    // passed already in its real sortOrder (prj_a, then prj_b).
    const view = selectInProgressView([taskB, taskA], [prjA, prjB]);
    expect(view.projects.map((g) => g.project.id)).toEqual(["prj_a", "prj_b"]);
  });

  it("never surfaces a task with inProgress: false, anywhere", () => {
    const prj = makeProject({ id: "prj_1" });
    const sub = makeTask({
      id: "tsk_sub",
      parentId: "tsk_parent",
      projectId: "prj_1",
      inProgress: false,
    });
    const parent = makeTask({
      id: "tsk_parent",
      projectId: "prj_1",
      inProgress: false,
      subtasks: [sub],
    });
    const looseTask = makeTask({ id: "tsk_loose", projectId: null, inProgress: false });
    const view = selectInProgressView([parent, looseTask], [prj]);
    expect(view.projects).toEqual([]);
    expect(view.looseTasks).toEqual([]);
    expect(view.looseOrphanSubtasks).toEqual([]);
  });
});

describe("selectInProgressView — parent grouping (rows)", () => {
  it("a card that is entirely orphan groups: one non-inProgress parent with 3 inProgress children -> exactly one parentGroup with 3 tasks", () => {
    const prj = makeProject({ id: "prj_1" });
    const sub1 = makeTask({
      id: "tsk_sub1",
      parentId: "tsk_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
    });
    const sub2 = makeTask({
      id: "tsk_sub2",
      parentId: "tsk_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
    });
    const sub3 = makeTask({
      id: "tsk_sub3",
      parentId: "tsk_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
    });
    const parent = makeTask({
      id: "tsk_parent",
      title: "Parent Title",
      projectId: "prj_1",
      inProgress: false,
      subtasks: [sub1, sub2, sub3],
    });
    const view = selectInProgressView([parent], [prj]);
    expect(view.projects[0].rows).toHaveLength(1);
    const [row] = view.projects[0].rows;
    expect(row).toEqual({
      kind: "parentGroup",
      parentId: "tsk_parent",
      parentTitle: "Parent Title",
      tasks: [sub1, sub2, sub3],
    });
  });

  it("a parent that IS inProgress with inProgress children -> a single task row with subtasks narrowed, not a parentGroup", () => {
    const prj = makeProject({ id: "prj_1" });
    const sub = makeTask({
      id: "tsk_sub",
      parentId: "tsk_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
    });
    const nonQualifyingSub = makeTask({
      id: "tsk_sub2",
      parentId: "tsk_parent",
      projectId: "prj_1",
      inProgress: false,
    });
    const parent = makeTask({
      id: "tsk_parent",
      projectId: "prj_1",
      inProgress: true,
      subtasks: [sub, nonQualifyingSub],
    });
    const view = selectInProgressView([parent], [prj]);
    expect(view.projects[0].rows).toHaveLength(1);
    const [row] = view.projects[0].rows;
    expect(row.kind).toBe("task");
    if (row.kind !== "task") throw new Error("expected task row");
    expect(row.task.id).toBe("tsk_parent");
    expect(row.task.subtasks.map((t) => t.id)).toEqual(["tsk_sub"]);
  });

  it("a parentless/childless inProgress top-level task -> bare task row", () => {
    const prj = makeProject({ id: "prj_1" });
    const task = makeTask({
      id: "tsk_1",
      projectId: "prj_1",
      inProgress: true,
      stage: "in_progress",
    });
    const view = selectInProgressView([task], [prj]);
    expect(view.projects[0].rows).toEqual([{ kind: "task", task }]);
  });

  it("a non-inProgress parent with zero qualifying children contributes no row", () => {
    const prj = makeProject({ id: "prj_1" });
    const sub = makeTask({
      id: "tsk_sub",
      parentId: "tsk_parent",
      projectId: "prj_1",
      inProgress: false,
    });
    const parent = makeTask({
      id: "tsk_parent",
      projectId: "prj_1",
      inProgress: false,
      subtasks: [sub],
    });
    const other = makeTask({
      id: "tsk_other",
      projectId: "prj_1",
      inProgress: true,
      stage: "in_progress",
    });
    const view = selectInProgressView([parent, other], [prj]);
    expect(view.projects[0].rows).toEqual([{ kind: "task", task: other }]);
  });

  it("a mixed card interleaves task rows and parentGroup rows in backlogTasks order", () => {
    const prj = makeProject({ id: "prj_1" });
    // Order: plain task, then a non-qualifying parent (-> parentGroup),
    // then a qualifying parent with a qualifying child (-> nested task row).
    const plain = makeTask({
      id: "tsk_plain",
      projectId: "prj_1",
      inProgress: true,
      stage: "in_progress",
    });
    const orphanChild = makeTask({
      id: "tsk_orphan_child",
      parentId: "tsk_orphan_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
    });
    const orphanParent = makeTask({
      id: "tsk_orphan_parent",
      title: "Orphan Parent",
      projectId: "prj_1",
      inProgress: false,
      subtasks: [orphanChild],
    });
    const nestedChild = makeTask({
      id: "tsk_nested_child",
      parentId: "tsk_qualifying_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
    });
    const qualifyingParent = makeTask({
      id: "tsk_qualifying_parent",
      projectId: "prj_1",
      inProgress: true,
      subtasks: [nestedChild],
    });
    const view = selectInProgressView(
      [plain, orphanParent, qualifyingParent],
      [prj],
    );
    const rows = view.projects[0].rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ kind: "task", task: plain });
    expect(rows[1]).toEqual({
      kind: "parentGroup",
      parentId: "tsk_orphan_parent",
      parentTitle: "Orphan Parent",
      tasks: [orphanChild],
    });
    expect(rows[2].kind).toBe("task");
    if (rows[2].kind !== "task") throw new Error("expected task row");
    expect(rows[2].task.id).toBe("tsk_qualifying_parent");
    expect(rows[2].task.subtasks.map((t) => t.id)).toEqual(["tsk_nested_child"]);
  });

  it("empty project groups still hidden; looseRows built by identical rules for the Unfiled group", () => {
    const prj = makeProject({ id: "prj_1" });
    const nonQualifying = makeTask({ id: "tsk_1", projectId: "prj_1", inProgress: false });
    const looseTask = makeTask({
      id: "tsk_loose",
      projectId: null,
      inProgress: true,
      stage: "in_progress",
    });
    const looseSub = makeTask({
      id: "tsk_loose_sub",
      parentId: "tsk_loose_parent",
      projectId: null,
      stage: "in_progress",
      inProgress: true,
    });
    const looseParent = makeTask({
      id: "tsk_loose_parent",
      title: "Loose Parent",
      projectId: null,
      inProgress: false,
      subtasks: [looseSub],
    });
    const view = selectInProgressView(
      [nonQualifying, looseTask, looseParent],
      [prj],
    );
    // `prj_1` has nothing qualifying -> hidden entirely.
    expect(view.projects).toEqual([]);
    expect(view.looseRows).toEqual([
      { kind: "task", task: looseTask },
      {
        kind: "parentGroup",
        parentId: "tsk_loose_parent",
        parentTitle: "Loose Parent",
        tasks: [looseSub],
      },
    ]);
  });

  it("regression guard: tasks/orphanSubtasks/looseTasks/looseOrphanSubtasks still populated as before, and total row task count matches", () => {
    const prj = makeProject({ id: "prj_1" });
    const sub1 = makeTask({
      id: "tsk_sub1",
      parentId: "tsk_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
    });
    const sub2 = makeTask({
      id: "tsk_sub2",
      parentId: "tsk_parent",
      projectId: "prj_1",
      stage: "in_progress",
      inProgress: true,
    });
    const parent = makeTask({
      id: "tsk_parent",
      projectId: "prj_1",
      inProgress: false,
      subtasks: [sub1, sub2],
    });
    const plain = makeTask({
      id: "tsk_plain",
      projectId: "prj_1",
      inProgress: true,
      stage: "in_progress",
    });
    const view = selectInProgressView([parent, plain], [prj]);
    const group = view.projects[0];
    expect(group.tasks.map((t) => t.id)).toEqual(["tsk_plain"]);
    expect(group.orphanSubtasks.map((t) => t.id)).toEqual(["tsk_sub1", "tsk_sub2"]);

    function countRowTasks(rows: typeof group.rows): number {
      return rows.reduce(
        (n, row) => n + (row.kind === "task" ? 1 : row.tasks.length),
        0,
      );
    }
    expect(countRowTasks(group.rows)).toBe(
      group.tasks.length + group.orphanSubtasks.length,
    );
  });
});
