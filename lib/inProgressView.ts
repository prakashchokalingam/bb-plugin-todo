// Pure, DOM-free derivation of the grouped In Progress view from the
// Backlog's task tree — the client-side counterpart to the server dropping
// `inProgress.tasks` from the wire (Phase 2). Same discipline as
// `lib/order.ts`: no I/O, table-tested, safe to call from both the render
// path and any optimistic drag projection so the two can never disagree.
//
// LOAD-BEARING DEPENDENCY — READ BEFORE TOUCHING ANYTHING NEAR THIS FILE:
// `selectInProgressView` is correct ONLY because its `backlogTasks` argument
// is comprehensive — every open top-level task in the active list, always,
// per Phase 2's rewrite of `getBoard` (the Backlog query dropped its stage
// filter entirely). If the Backlog is EVER virtualized or lazily paged,
// this function goes SILENTLY BLIND to anything outside the loaded window:
// a task due today that hasn't been fetched yet simply will not appear in
// In Progress, with no error, no warning, nothing. Do not add pagination or
// virtualization to the Backlog without redesigning this module first —
// In Progress would need its own fetch at that point.
import type { ProjectDto, TaskDto } from "@/contract";

/**
 * One ordered row of a single In Progress card (a project card, or the
 * loose/Unfiled group). This replaced tag-subgrouping as the ONLY grouping
 * axis inside a card — tags no longer group anything here, they just render
 * as inline chips per row (the render layer's concern, not this module's).
 *
 * - `"task"` — a top-level `inProgress` task, rendered as its own row. If it
 *   has qualifying subtasks, they're already narrowed onto `task.subtasks`
 *   (see `selectInProgressView`'s loop) and the render layer (`TaskRow`)
 *   nests them itself; if it has none, this is a bare row with no header.
 * - `"parentGroup"` — a top-level task that is NOT itself `inProgress` but
 *   has one or more `inProgress` subtasks. There is no parent row to nest
 *   under here (the parent doesn't qualify for In Progress), so its
 *   qualifying children are pulled out under a synthetic header keyed by
 *   the parent's own id/title. This is the grouping-level replacement for
 *   what used to be rendered as standalone "orphan" rows with a repeated
 *   `Project > Parent` breadcrumb per row — now there's one header for the
 *   whole clutch of siblings.
 */
export type InProgressRow =
  | { kind: "task"; task: TaskDto }
  | { kind: "parentGroup"; parentId: string; parentTitle: string; tasks: TaskDto[] };

export interface InProgressProjectGroup {
  project: ProjectDto;
  /** Top-level tasks that are themselves `inProgress`, with `subtasks`
   * narrowed to inProgress-only (exactly like the Backlog's nesting, minus
   * the rows that don't qualify — there's no orphaning here, since the
   * parent row is right here to nest under). Kept for dnd-kit sortable-id
   * registration and the hide-empty-project-group check; every task here
   * also appears, in the same relative order, as a `"task"` row in `rows`. */
  tasks: TaskDto[];
  /** `inProgress` subtasks whose PARENT is NOT `inProgress` — there is no
   * parent row in this view to nest them under, so they render standalone
   * and need a trail (`TrailLine`) so they don't look homeless. Kept for
   * dnd-kit sortable-id registration; every subtask here also appears,
   * grouped by parent, inside a `"parentGroup"` row in `rows`. */
  orphanSubtasks: TaskDto[];
  /** `tasks` and `orphanSubtasks` above, re-interleaved into ONE ordered
   * list of rows for this card's rendering — a `"task"` row per qualifying
   * top-level task (in `backlogTasks`/Backlog `sortOrder`), and a
   * `"parentGroup"` row per non-qualifying parent that has qualifying
   * children, ALSO ordered by that parent's own position in
   * `backlogTasks`. The two kinds interleave by that shared order; there
   * is no separate hoisting of one kind before the other and no new sort
   * key introduced beyond the Backlog's own. Every row in `tasks` and
   * every row in `orphanSubtasks` appears in exactly one place here — this
   * is a repartition, not an additional filter, so the total task count
   * always matches. */
  rows: InProgressRow[];
}

export interface InProgressView {
  /** Only groups with >= 1 task or orphan, in `projects`' `sortOrder`.
   * In Progress HIDES empty project groups — unlike the Backlog, which
   * never does (a project is a durable container there; here it's an
   * ephemeral filtered view, and an empty box in it is pure noise). */
  projects: InProgressProjectGroup[];
  looseTasks: TaskDto[];
  looseOrphanSubtasks: TaskDto[];
  /** `looseTasks` + `looseOrphanSubtasks`, re-interleaved into rows — the
   * Unfiled group gets the same parent-grouping treatment as a project
   * card. See `InProgressProjectGroup.rows`. */
  looseRows: InProgressRow[];
}

/**
 * Derives what In Progress looks like, grouped by project, from the same
 * tree the Backlog renders.
 *
 * Membership is NEVER recomputed here — `task.inProgress` is the sole,
 * authoritative signal. It is computed server-side by the shared In
 * Progress-membership predicate (`IN_PROGRESS_MEMBERSHIP_SQL` in
 * `lib/db.ts`), and the dismissal state it depends on
 * (`today_dismissed_day`) is deliberately never sent to the client — so
 * this function could not reconstruct membership from `dueAt`/`stage`
 * alone even if it tried. Trust the flag.
 *
 * Grouping inside each card is by PARENT TASK, not by tag (tags are no
 * longer a grouping axis anywhere in this view — see `InProgressRow`'s doc
 * comment). Row order follows `backlogTasks`' own order (the Backlog's
 * `sortOrder`) for both kinds of row: a qualifying top-level task's own
 * position produces its `"task"` row there, and a non-qualifying parent's
 * own position produces its `"parentGroup"` row there — the two interleave
 * naturally by walking `backlogTasks` once, in order, and appending as we
 * go. No new sort key is introduced.
 */
export function selectInProgressView(
  backlogTasks: TaskDto[],
  projects: ProjectDto[],
): InProgressView {
  const byProject = new Map<
    string,
    { tasks: TaskDto[]; orphanSubtasks: TaskDto[]; rows: InProgressRow[] }
  >();
  const looseTasks: TaskDto[] = [];
  const looseOrphanSubtasks: TaskDto[] = [];
  const looseRows: InProgressRow[] = [];

  function entryFor(projectId: string | null) {
    if (projectId === null) return null;
    let entry = byProject.get(projectId);
    if (!entry) {
      entry = { tasks: [], orphanSubtasks: [], rows: [] };
      byProject.set(projectId, entry);
    }
    return entry;
  }

  for (const task of backlogTasks) {
    const qualifyingSubtasks = task.subtasks.filter((s) => s.inProgress);

    if (task.inProgress) {
      // Reuse the task object as-is when every subtask already qualifies
      // (the common case: a task with no subtasks, or all-qualifying
      // ones) — only copy when narrowing is actually needed.
      const row: TaskDto =
        qualifyingSubtasks.length === task.subtasks.length
          ? task
          : { ...task, subtasks: qualifyingSubtasks };
      const entry = entryFor(task.projectId);
      if (entry) {
        entry.tasks.push(row);
        entry.rows.push({ kind: "task", task: row });
      } else {
        looseTasks.push(row);
        looseRows.push({ kind: "task", task: row });
      }
    } else if (qualifyingSubtasks.length > 0) {
      // The parent doesn't qualify, but one or more of its subtasks do —
      // those subtasks are pulled into a `parentGroup` row keyed by this
      // (non-qualifying) parent, since there is no parent row here to
      // nest them under directly.
      const entry = entryFor(task.projectId);
      const groupRow: InProgressRow = {
        kind: "parentGroup",
        parentId: task.id,
        parentTitle: task.title,
        tasks: qualifyingSubtasks,
      };
      if (entry) {
        entry.orphanSubtasks.push(...qualifyingSubtasks);
        entry.rows.push(groupRow);
      } else {
        looseOrphanSubtasks.push(...qualifyingSubtasks);
        looseRows.push(groupRow);
      }
    }
  }

  const projectGroups: InProgressProjectGroup[] = [];
  for (const project of projects) {
    const entry = byProject.get(project.id);
    if (!entry) continue;
    if (entry.tasks.length === 0 && entry.orphanSubtasks.length === 0) continue;
    projectGroups.push({
      project,
      tasks: entry.tasks,
      orphanSubtasks: entry.orphanSubtasks,
      rows: entry.rows,
    });
  }

  return {
    projects: projectGroups,
    looseTasks,
    looseOrphanSubtasks,
    looseRows,
  };
}
