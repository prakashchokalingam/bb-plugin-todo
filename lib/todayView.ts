// Pure, DOM-free derivation of the grouped Today view from the Backlog's
// task tree — the client-side counterpart to the server dropping
// `today.tasks` from the wire (Phase 2). Same discipline as `lib/order.ts`:
// no I/O, table-tested, safe to call from both the render path and any
// optimistic drag projection so the two can never disagree.
//
// LOAD-BEARING DEPENDENCY — READ BEFORE TOUCHING ANYTHING NEAR THIS FILE:
// `selectTodayView` is correct ONLY because its `backlogTasks` argument is
// comprehensive — every open top-level task in the active list, always, per
// Phase 2's rewrite of `getBoard` (the Backlog query dropped its bucket
// filter entirely). If the Backlog is EVER virtualized or lazily paged,
// this function goes SILENTLY BLIND to anything outside the loaded window:
// a task due today that hasn't been fetched yet simply will not appear in
// Today, with no error, no warning, nothing. Do not add pagination or
// virtualization to the Backlog without redesigning this module first —
// Today would need its own fetch at that point.
import type { ProjectDto, TaskDto } from "@/contract";

export interface TodayProjectGroup {
  project: ProjectDto;
  /** Top-level tasks that are themselves `inToday`, with `subtasks` narrowed
   * to inToday-only (exactly like the Backlog's nesting, minus the rows
   * that don't qualify — there's no orphaning here, since the parent row
   * is right here to nest under). */
  tasks: TaskDto[];
  /** `inToday` subtasks whose PARENT is NOT `inToday` — there is no parent
   * row in this view to nest them under, so they render standalone and
   * need a trail (`TrailLine`) so they don't look homeless. */
  orphanSubtasks: TaskDto[];
}

export interface TodayView {
  /** Only groups with >= 1 task or orphan, in `projects`' `sortOrder`.
   * Today HIDES empty project groups — unlike the Backlog, which never
   * does (a project is a durable container there; here it's an ephemeral
   * filtered view, and an empty box in it is pure noise). */
  projects: TodayProjectGroup[];
  looseTasks: TaskDto[];
  looseOrphanSubtasks: TaskDto[];
}

/**
 * Derives what Today looks like, grouped by project, from the same tree the
 * Backlog renders.
 *
 * Membership is NEVER recomputed here — `task.inToday` is the sole,
 * authoritative signal. It is computed server-side by the shared
 * Today-membership predicate (`TODAY_MEMBERSHIP_SQL` in `lib/db.ts`), and
 * the dismissal state it depends on (`today_dismissed_day`) is deliberately
 * never sent to the client — so this function could not reconstruct
 * membership from `dueAt`/`bucket` alone even if it tried. Trust the flag.
 */
export function selectTodayView(
  backlogTasks: TaskDto[],
  projects: ProjectDto[],
): TodayView {
  const byProject = new Map<
    string,
    { tasks: TaskDto[]; orphanSubtasks: TaskDto[] }
  >();
  const looseTasks: TaskDto[] = [];
  const looseOrphanSubtasks: TaskDto[] = [];

  function entryFor(projectId: string | null) {
    if (projectId === null) return null;
    let entry = byProject.get(projectId);
    if (!entry) {
      entry = { tasks: [], orphanSubtasks: [] };
      byProject.set(projectId, entry);
    }
    return entry;
  }

  for (const task of backlogTasks) {
    const qualifyingSubtasks = task.subtasks.filter((s) => s.inToday);

    if (task.inToday) {
      // Reuse the task object as-is when every subtask already qualifies
      // (the common case: a task with no subtasks, or all-qualifying
      // ones) — only copy when narrowing is actually needed.
      const row: TaskDto =
        qualifyingSubtasks.length === task.subtasks.length
          ? task
          : { ...task, subtasks: qualifyingSubtasks };
      const entry = entryFor(task.projectId);
      if (entry) entry.tasks.push(row);
      else looseTasks.push(row);
    } else if (qualifyingSubtasks.length > 0) {
      // The parent doesn't qualify, but one or more of its subtasks do —
      // those subtasks are orphaned into a standalone, trailed row.
      const entry = entryFor(task.projectId);
      const target = entry ? entry.orphanSubtasks : looseOrphanSubtasks;
      target.push(...qualifyingSubtasks);
    }
  }

  const projectGroups: TodayProjectGroup[] = [];
  for (const project of projects) {
    const entry = byProject.get(project.id);
    if (!entry) continue;
    if (entry.tasks.length === 0 && entry.orphanSubtasks.length === 0) continue;
    projectGroups.push({
      project,
      tasks: entry.tasks,
      orphanSubtasks: entry.orphanSubtasks,
    });
  }

  return { projects: projectGroups, looseTasks, looseOrphanSubtasks };
}
