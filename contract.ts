// bb-plugin-todo — shared RPC contract. Both server.ts and app.tsx import
// this file; it is the single source of truth for wire shapes. Keep it in
// sync with docs/SPEC.md's "RPC contract" section exactly — no extra fields,
// no extra methods.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Palette keys, in swatch order. Stored on the tag row and resolved to
 * Tailwind classes client-side by `lib/tag-colors.ts` — a stored hex would be
 * unreadable in one of the two themes. */
export const TAG_COLORS = [
  "slate",
  "red",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/** The denormalized form embedded in every TaskDto. */
export interface TagRefDto {
  id: string;
  name: string;
  color: TagColor;
}

/** The catalog form: returned by getBoard and by the tag mutations. */
export interface TagDto extends TagRefDto {
  sortOrder: number;
  /** Global count across every list, not just the active one. */
  taskCount: number;
}

/**
 * Denormalized breadcrumb for a task's home, computed server-side in the
 * same pass that denormalizes tags — the client never does a lookup to
 * render the trail line. `null` for a loose top-level task (no project, no
 * parent); those rows render exactly as they do today.
 */
export interface TrailDto {
  projectId: string | null;
  projectName: string | null;
  projectColor: TagColor | null;
  parentId: string | null;
  parentTitle: string | null;
}

export interface TaskDto {
  id: string;
  listId: string;
  parentId: string | null;
  title: string;
  notes: string | null;
  bucket: "backlog" | "today";
  day: string | null;
  sortOrder: number;
  dueAt: number | null;
  hasDueTime: boolean;
  status: "open" | "done";
  completedAt: number | null;
  carriedCount: number;
  createdAt: number;
  updatedAt: number;
  /** Present on top-level rows only; always [] on subtasks. */
  subtasks: TaskDto[];
  /** `done` counts done subtasks. */
  subtaskCounts: { total: number; done: number };
  /** Ordered by tag sortOrder. Populated on subtasks too. */
  tags: TagRefDto[];
  /** NULL = loose (not filed into a project). */
  projectId: string | null;
  trail: TrailDto | null;
  /**
   * Computed server-side from the shared Today-membership predicate
   * (`isTodayMember`/`TODAY_MEMBERSHIP_SQL` in lib/db.ts): true if manually
   * scheduled (`bucket = 'today'`) OR due today/overdue and not dismissed
   * for today. The one bit the client can't reconstruct on its own, since
   * `today_dismissed_day` itself is never sent.
   */
  inToday: boolean;
}

export interface ListDto {
  id: string;
  name: string;
  sortOrder: number;
  openCount: number;
  overdueCount: number;
}

export interface ProjectDto {
  id: string;
  listId: string;
  name: string;
  color: TagColor;
  sortOrder: number;
  collapsed: boolean;
  openCount: number;
  todayCount: number;
  overdueCount: number;
}

const idSchema = z.string().min(1);

const tagRefDtoSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    color: z.enum(TAG_COLORS),
  })
  .strict();

const tagDtoSchema = tagRefDtoSchema
  .extend({
    sortOrder: z.number(),
    taskCount: z.number().int(),
  })
  .strict();

const trailDtoSchema = z
  .object({
    projectId: idSchema.nullable(),
    projectName: z.string().nullable(),
    projectColor: z.enum(TAG_COLORS).nullable(),
    parentId: idSchema.nullable(),
    parentTitle: z.string().nullable(),
  })
  .strict();

// Recursive schema needs an explicit type annotation — zod can't infer a
// self-referential shape from z.lazy() alone. The wire shape always
// includes projectId/trail (unlike the TS interface's `?`, which is only a
// source-compat concession for older fixtures — see TaskDto's comment).
const taskDtoSchema: z.ZodType<TaskDto> = z.lazy(() =>
  z
    .object({
      id: idSchema,
      listId: idSchema,
      parentId: idSchema.nullable(),
      title: z.string(),
      notes: z.string().nullable(),
      bucket: z.enum(["backlog", "today"]),
      day: z.string().nullable(),
      sortOrder: z.number(),
      dueAt: z.number().nullable(),
      hasDueTime: z.boolean(),
      status: z.enum(["open", "done"]),
      completedAt: z.number().nullable(),
      carriedCount: z.number().int(),
      createdAt: z.number(),
      updatedAt: z.number(),
      subtasks: z.array(taskDtoSchema),
      subtaskCounts: z
        .object({ total: z.number().int(), done: z.number().int() })
        .strict(),
      tags: z.array(tagRefDtoSchema),
      projectId: idSchema.nullable(),
      trail: trailDtoSchema.nullable(),
      inToday: z.boolean(),
    })
    .strict(),
);

const listDtoSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    sortOrder: z.number(),
    openCount: z.number().int(),
    overdueCount: z.number().int(),
  })
  .strict();

const projectDtoSchema = z
  .object({
    id: idSchema,
    listId: idSchema,
    name: z.string(),
    color: z.enum(TAG_COLORS),
    sortOrder: z.number(),
    collapsed: z.boolean(),
    openCount: z.number().int(),
    todayCount: z.number().int(),
    overdueCount: z.number().int(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  getBoard: {
    input: z.object({ listId: idSchema.nullable() }).strict(),
    output: z
      .object({
        lists: z.array(listDtoSchema),
        activeListId: idSchema,
        // No `tasks` here — the Backlog is now comprehensive, so
        // `backlog.tasks` already carries everything a Today row needs
        // (via `inToday`); the client derives its own grouped Today view
        // from that single tree instead of trusting a second traversal.
        today: z
          .object({
            day: z.string(),
            planned: z.number().int(),
            completed: z.number().int(),
          })
          .strict(),
        backlog: z
          .object({
            total: z.number().int(),
            overdue: z.number().int(),
            tasks: z.array(taskDtoSchema),
          })
          .strict(),
        totalOverdue: z.number().int(),
        serverNow: z.number(),
        /** The full tag catalog with usage counts, so the picker needs no extra fetch. */
        tags: z.array(tagDtoSchema),
        /** Every project in the active list, in sortOrder. */
        projects: z.array(projectDtoSchema),
      })
      .strict(),
  },
  getArchive: {
    input: z
      .object({
        listId: idSchema,
        limit: z.number().int().min(1).max(200).default(100),
        offset: z.number().int().min(0).default(0),
      })
      .strict(),
    output: z
      .object({
        groups: z.array(
          z.object({ day: z.string(), tasks: z.array(taskDtoSchema) }).strict(),
        ),
        total: z.number().int(),
        hasMore: z.boolean(),
      })
      .strict(),
  },
  createTask: {
    input: z
      .object({
        listId: idSchema,
        bucket: z.enum(["backlog", "today"]),
        title: z.string(),
        parentId: idSchema.nullable(),
        dueAt: z.number().nullable(),
        hasDueTime: z.boolean(),
        position: z.enum(["top", "bottom"]),
        // Optional, defaulting to loose (null) when omitted — not just
        // "unchanged" like moveTask's, since there is no prior row to keep
        // unchanged from. Optional (rather than required) so existing
        // callers that don't yet know about projects keep working.
        projectId: idSchema.nullable().optional(),
      })
      .strict(),
    output: z.object({ task: taskDtoSchema }).strict(),
  },
  updateTask: {
    input: z
      .object({
        id: idSchema,
        title: z.string().optional(),
        notes: z.string().nullable().optional(),
        dueAt: z.number().nullable().optional(),
        hasDueTime: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ task: taskDtoSchema }).strict(),
  },
  moveTask: {
    input: z
      .object({
        id: idSchema,
        bucket: z.enum(["backlog", "today"]),
        parentId: idSchema.nullable(),
        beforeId: idSchema.nullable(),
        afterId: idSchema.nullable(),
        /** Target home. Omit = unchanged (snap-home / no re-file). */
        projectId: idSchema.nullable().optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  completeTask: {
    input: z.object({ id: idSchema }).strict(),
    output: z.object({ completedIds: z.array(idSchema) }).strict(),
  },
  // Counterpart to moveTask's today->backlog dismissal stamp, for a task
  // that was never manually scheduled (bucket = 'backlog') but renders in
  // Today purely because it's due today or overdue — there's nothing to
  // move, so this is a single-column stamp of today_dismissed_day.
  dismissFromToday: {
    input: z.object({ id: idSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  restoreTasks: {
    input: z.object({ ids: z.array(idSchema) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  deleteTask: {
    input: z.object({ id: idSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  createList: {
    input: z.object({ name: z.string() }).strict(),
    output: z.object({ list: listDtoSchema }).strict(),
  },
  renameList: {
    input: z.object({ id: idSchema, name: z.string() }).strict(),
    output: z.object({ lists: z.array(listDtoSchema) }).strict(),
  },
  deleteList: {
    input: z.object({ id: idSchema }).strict(),
    output: z.object({ lists: z.array(listDtoSchema) }).strict(),
  },
  reorderLists: {
    input: z.object({ ids: z.array(idSchema) }).strict(),
    output: z.object({ lists: z.array(listDtoSchema) }).strict(),
  },
  clearArchive: {
    input: z.object({ listId: idSchema }).strict(),
    output: z.object({ deleted: z.number().int() }).strict(),
  },
  createTag: {
    input: z.object({ name: z.string(), color: z.enum(TAG_COLORS) }).strict(),
    output: z.object({ tag: tagDtoSchema }).strict(),
  },
  updateTag: {
    input: z
      .object({
        id: idSchema,
        name: z.string().optional(),
        color: z.enum(TAG_COLORS).optional(),
      })
      .strict(),
    output: z.object({ tag: tagDtoSchema }).strict(),
  },
  deleteTag: {
    input: z.object({ id: idSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  reorderTags: {
    input: z.object({ ids: z.array(idSchema) }).strict(),
    output: z.object({ tags: z.array(tagDtoSchema) }).strict(),
  },
  setTaskTags: {
    input: z.object({ taskId: idSchema, tagIds: z.array(idSchema) }).strict(),
    output: z.object({ task: taskDtoSchema }).strict(),
  },
  createProject: {
    input: z.object({ listId: idSchema, name: z.string(), color: z.enum(TAG_COLORS) }).strict(),
    output: z.object({ project: projectDtoSchema }).strict(),
  },
  updateProject: {
    input: z
      .object({
        id: idSchema,
        name: z.string().optional(),
        color: z.enum(TAG_COLORS).optional(),
      })
      .strict(),
    output: z.object({ project: projectDtoSchema }).strict(),
  },
  deleteProject: {
    input: z.object({ id: idSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  reorderProjects: {
    input: z.object({ listId: idSchema, ids: z.array(idSchema) }).strict(),
    output: z.object({ projects: z.array(projectDtoSchema) }).strict(),
  },
  setProjectCollapsed: {
    input: z.object({ id: idSchema, collapsed: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});
