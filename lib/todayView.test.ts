import { describe, expect, it } from "vitest";
import type { ProjectDto, TaskDto } from "@/contract";
import { selectTodayView } from "./todayView";

function makeTask(overrides: Partial<TaskDto> & { id: string }): TaskDto {
  return {
    listId: "lst_1",
    parentId: null,
    title: overrides.id,
    notes: null,
    bucket: "backlog",
    day: null,
    sortOrder: 1000,
    dueAt: null,
    hasDueTime: false,
    status: "open",
    completedAt: null,
    carriedCount: 0,
    createdAt: 0,
    updatedAt: 0,
    subtasks: [],
    subtaskCounts: { total: 0, done: 0 },
    tags: [],
    projectId: null,
    trail: null,
    inToday: false,
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
    todayCollapsed: false,
    openCount: 0,
    todayCount: 0,
    overdueCount: 0,
    ...overrides,
  };
}

describe("selectTodayView", () => {
  it("includes a manually scheduled top-level task (bucket='today', inToday)", () => {
    const prj = makeProject({ id: "prj_1", sortOrder: 1000 });
    const task = makeTask({
      id: "tsk_1",
      bucket: "today",
      projectId: "prj_1",
      inToday: true,
    });
    const view = selectTodayView([task], [prj]);
    expect(view.projects).toHaveLength(1);
    expect(view.projects[0].project.id).toBe("prj_1");
    expect(view.projects[0].tasks.map((t) => t.id)).toEqual(["tsk_1"]);
    expect(view.projects[0].orphanSubtasks).toEqual([]);
  });

  it("includes an auto-included top-level task (bucket='backlog', inToday due today/overdue)", () => {
    const prj = makeProject({ id: "prj_1" });
    const task = makeTask({
      id: "tsk_1",
      bucket: "backlog",
      projectId: "prj_1",
      dueAt: 1,
      inToday: true,
    });
    const view = selectTodayView([task], [prj]);
    expect(view.projects[0].tasks.map((t) => t.id)).toEqual(["tsk_1"]);
  });

  it("includes both a manual and an auto-included task in the same project group", () => {
    const prj = makeProject({ id: "prj_1" });
    const manual = makeTask({
      id: "tsk_manual",
      bucket: "today",
      projectId: "prj_1",
      inToday: true,
    });
    const auto = makeTask({
      id: "tsk_auto",
      bucket: "backlog",
      projectId: "prj_1",
      dueAt: 1,
      inToday: true,
    });
    const view = selectTodayView([manual, auto], [prj]);
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
      bucket: "today",
      inToday: true,
    });
    const parent = makeTask({
      id: "tsk_parent",
      projectId: "prj_1",
      inToday: false,
      subtasks: [sub],
    });
    const view = selectTodayView([parent], [prj]);
    expect(view.projects[0].tasks).toEqual([]);
    expect(view.projects[0].orphanSubtasks.map((t) => t.id)).toEqual(["tsk_sub"]);
  });

  it("nests a qualifying subtask under its qualifying parent (no orphan)", () => {
    const prj = makeProject({ id: "prj_1" });
    const sub = makeTask({
      id: "tsk_sub",
      parentId: "tsk_parent",
      projectId: "prj_1",
      bucket: "today",
      inToday: true,
    });
    const nonQualifyingSub = makeTask({
      id: "tsk_sub2",
      parentId: "tsk_parent",
      projectId: "prj_1",
      inToday: false,
    });
    const parent = makeTask({
      id: "tsk_parent",
      projectId: "prj_1",
      inToday: true,
      subtasks: [sub, nonQualifyingSub],
    });
    const view = selectTodayView([parent], [prj]);
    expect(view.projects[0].tasks).toHaveLength(1);
    expect(view.projects[0].tasks[0].id).toBe("tsk_parent");
    // Narrowed to inToday-only — the non-qualifying sibling is dropped, not
    // orphaned (its parent IS in Today; there's simply nothing to show).
    expect(view.projects[0].tasks[0].subtasks.map((t) => t.id)).toEqual(["tsk_sub"]);
    expect(view.projects[0].orphanSubtasks).toEqual([]);
  });

  it("hides an empty project group (no qualifying tasks or orphans)", () => {
    const prj1 = makeProject({ id: "prj_1" });
    const prj2 = makeProject({ id: "prj_2" });
    const task = makeTask({ id: "tsk_1", projectId: "prj_1", inToday: false });
    const view = selectTodayView([task], [prj1, prj2]);
    expect(view.projects).toEqual([]);
  });

  it("puts a loose (projectId null) inToday task into looseTasks", () => {
    const task = makeTask({ id: "tsk_1", projectId: null, inToday: true, bucket: "today" });
    const view = selectTodayView([task], []);
    expect(view.projects).toEqual([]);
    expect(view.looseTasks.map((t) => t.id)).toEqual(["tsk_1"]);
  });

  it("puts a loose orphan subtask (parent loose, not inToday) into looseOrphanSubtasks", () => {
    const sub = makeTask({
      id: "tsk_sub",
      parentId: "tsk_parent",
      projectId: null,
      bucket: "today",
      inToday: true,
    });
    const parent = makeTask({
      id: "tsk_parent",
      projectId: null,
      inToday: false,
      subtasks: [sub],
    });
    const view = selectTodayView([parent], []);
    expect(view.looseTasks).toEqual([]);
    expect(view.looseOrphanSubtasks.map((t) => t.id)).toEqual(["tsk_sub"]);
  });

  it("orders project groups by the `projects` array's sortOrder, not backlogTasks order", () => {
    const prjB = makeProject({ id: "prj_b", sortOrder: 2000 });
    const prjA = makeProject({ id: "prj_a", sortOrder: 1000 });
    const taskB = makeTask({ id: "tsk_b", projectId: "prj_b", inToday: true, bucket: "today" });
    const taskA = makeTask({ id: "tsk_a", projectId: "prj_a", inToday: true, bucket: "today" });
    // backlogTasks in reverse of the intended output order; `projects` is
    // passed already in its real sortOrder (prj_a, then prj_b).
    const view = selectTodayView([taskB, taskA], [prjA, prjB]);
    expect(view.projects.map((g) => g.project.id)).toEqual(["prj_a", "prj_b"]);
  });

  it("never surfaces a task with inToday: false, anywhere", () => {
    const prj = makeProject({ id: "prj_1" });
    const sub = makeTask({
      id: "tsk_sub",
      parentId: "tsk_parent",
      projectId: "prj_1",
      inToday: false,
    });
    const parent = makeTask({
      id: "tsk_parent",
      projectId: "prj_1",
      inToday: false,
      subtasks: [sub],
    });
    const looseTask = makeTask({ id: "tsk_loose", projectId: null, inToday: false });
    const view = selectTodayView([parent, looseTask], [prj]);
    expect(view.projects).toEqual([]);
    expect(view.looseTasks).toEqual([]);
    expect(view.looseOrphanSubtasks).toEqual([]);
  });
});
