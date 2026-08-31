# Backlog as source of truth, Today as a filtered lens — design

Status: approved 2026-08-31
Date: 2026-08-31

## Problem

`docs/design/2026-08-27-projects.md` shipped ghost rows deliberately, and
named its own top risk on the way out the door: *"Ghost rows double the
Backlog's visual weight if a user schedules twenty things."* That risk has
now landed. Scheduling even a modest chunk of a project's tasks makes the
Backlog card fill up with dimmed `◌` rows that are visually present but not
actionable there — you have to look past every ghost to find the tasks that
still need triage.

It's compounded by two more things that were true from the start but only
bite once the ghost weight is real:

- **One long scroll.** Backlog and Today are stacked sections separated only
  by whitespace (`gap-8`), so a Backlog heavy with ghosts pushes Today
  further down the page every time.
- **Two halves that read as different apps.** The Backlog is grouped by
  project; Today has always been a flat list. Once ghosts are visually loud,
  the mismatch in structure — not just position — makes the board feel like
  two separate tools bolted together rather than one board viewed two ways.

The report that triggered this change — *"messy, not organised, between
backlog and today"* — is this risk landing, not a new problem.

## Core decision

**The Backlog is the source of truth. Today is a filtered lens over it, not
a second place things live.**

This supersedes the predecessor doc's core decision, *"Today stops being a
place and becomes a flag."* That doc was already halfway to this one — a
task's home never moved, and Today already didn't own its own copy of a
task's identity — but it still rendered Today's membership as something a
task *carried into a second list*, complete with a duplicate row (the
ghost) marking where it "really" lived. This doc removes the duplication
rather than dimming it: a task that belongs to Today is simply a Backlog row
with `inToday: true`, rendered once in the Backlog and, because Today is a
lens, rendered again — undimmed, identical, fully interactive — in the
Today column. There is no ghost, because there is no second identity to be
a ghost *of*.

Concretely: `getBoard`'s backlog query drops its bucket filter entirely and
becomes unconditionally every open top-level task; `getBoard`'s `today`
object loses its `tasks` array; and Today membership is now a *derived*
predicate — `TODAY_MEMBERSHIP_SQL` / `isTodayMember` in `lib/db.ts` — read
off `backlog.tasks` client-side by a new pure `lib/todayView.ts`, rather
than being a separately-populated bucket of rows.

## Why `today_dismissed_day` rather than the alternatives

Today membership is now `manually scheduled ∪ (due today OR overdue)`, and
the second half of that union has no on/off switch on the row — a task with
a due date is a Today member purely because of arithmetic on `due_at`. But a
user still needs to say "not today" to an auto-included task without it
reappearing the instant they refresh. Something has to record that refusal
somewhere, since there's no `bucket='today'` flag to clear.

Two alternatives were considered and rejected:

- **Disallow the drag.** Today must be as fully operable as the Backlog —
  that's decision 2 of the plan and rule 7 of the spec. Making an
  auto-included row un-draggable while a manually-scheduled row next to it
  drags freely would be a visible, unexplainable inconsistency.
- **Clear or push out the due date.** This is the more tempting option
  because it reuses an existing column, but it's wrong on two counts. First,
  a view gesture — "get this out of my Today lens for today" — must never
  mutate a fact the user didn't touch; the due date is a Backlog-owned fact,
  and silently rewriting it to satisfy a Today-only action breaks that
  boundary. Second, it would erase the task's overdue-ness as a side effect:
  an overdue task removed from Today by pushing its due date to tomorrow
  would stop being overdue in the Backlog too, which is a correctness bug
  dressed up as a UI action.

`today_dismissed_day` stores the local day (`YYYY-MM-DD`) the task was last
explicitly removed from Today, and nothing else. It answers exactly the
question being asked — "is this refusal still in effect?" — and nothing
more.

It is **self-expiring by construction**, reusing the same idiom
`runRollover` already relies on for "day < today is inert"
(`lib/rollover.ts:20`): the predicate only suppresses membership while
`today_dismissed_day` equals *today*. A dismissed-but-still-overdue task
returns to Today on its own the next day, with no rollover write and
nothing to clean up — the same value that recorded the refusal also expires
it, just by the calendar moving on.

Two write paths route off `task.bucket`, which is already on the wire:
`moveTask`'s existing `today -> backlog` transition stamps
`today_dismissed_day` as one more field in the same update (unconditional,
harmless on a task with no due date — this is what stops a
manually-scheduled *and* overdue task from boomeranging straight back in);
and the new `dismissFromToday({ id })` RPC handles the case `moveTask`
cannot express — a task that was never `bucket='today'` at all, with nothing
to move, so it's a single-column stamp.

## Why `today_order` was abandoned but not dropped

With Today grouped by project and rendered as a lens rather than a separate
list, it inherits `sort_order` — there is exactly one order column, and
reordering a task in the Today column reorders it in the Backlog too. That
is the direct, intended consequence of "Today is a filtered view": both
columns are showing you the same underlying order, from two different
filters, so they cannot disagree.

`today_order` (migration 13) is not deleted. Every migration in this
codebase is additive-only (the predecessor doc states this explicitly, and
it still holds); a dropped column makes a code rollback unrecoverable, and
an inert column costs nothing sitting in the schema. Concretely: `writeOrder`
narrows to accept only `"sort_order"`, and a source-scanning test in
`lib/db.test.ts` asserts zero `today_order` writes anywhere in `lib/db.ts` —
so the column is not just conventionally unused, it's structurally
unwritable by anything short of a raw SQL statement outside `writeOrder`.

This also doubles as the escape hatch. If shared ordering between the two
columns turns out to grate in practice — a user reorders Today to plan their
day and is surprised their Backlog project shuffled — `today_order` is still
sitting in the table, backfilled correctly as of migration 15, ready to be
revived without a new migration.

## Why `today.tasks` left the wire

The predecessor doc's Today query was already "genuinely flat" — a second,
independently-built server-side traversal (`buildTodayDto`) that forced
`subtasks: []` on every row so a scheduled-alone subtask could render
without dragging its parent along. That traversal is deleted, not fixed,
because the reason for its existence disappeared: once the Backlog became
comprehensive (no bucket filter), every field a Today row needs —`bucket`,
`day`, `dueAt`, `inToday`, `projectId`, `parentId`, `trail` — already sits on
every `TaskDto` in `backlog.tasks`. A second server-side tree built from the
same rows can only either duplicate the first one or, eventually, disagree
with it. Deleting it removes that possibility outright: there is now
**exactly one canonical tree per board load**, and the client's
`lib/todayView.ts` derives the grouped Today view from it with a pure
function.

This is the largest bet in the whole change, and it is safe **only because**
the Backlog became comprehensive. `lib/todayView.ts`'s header comment
records the tripwire explicitly: if the Backlog is ever virtualized or
lazily paged for performance, Today goes blind to anything outside the
loaded window, silently — no error, just tasks that are, in fact, due or
scheduled simply not showing up in the Today column. This is also called out
in `docs/SPEC.md`'s `getBoard` section and README's Known gaps, so a future
reader hits the tripwire before the mistake, not after it. `getArchive` is
deliberately left alone — an archived subtask's parent may not be in the
same page of results, so flattening the assumption "the full tree is always
present" would be wrong there in a way it isn't for the Backlog.

## Why the Today ring needed generalizing

Rule 5's ring survives a completed task's vanish by reading `day` off rows
stamped `day = today`, rather than trying to count rows that are no longer
visible. That worked as long as `day` was only ever written by manually
scheduling a task into `bucket='today'`. Once Today also includes
auto-included rows — members purely by `due_at` arithmetic, never
`bucket='today'`, never `day`-stamped — completing one of them would leave
no record it was ever a Today member. It would vanish from the board exactly
like a manually-scheduled completion, but silently undercount the ring
forever, because nothing had ever written `day` for it.

The fix reuses `day` rather than inventing new bookkeeping: `completeTask`
now stamps `day = today` at the moment of completion for any row that
satisfies `isTodayMember` but doesn't already have `day` set to today. Only
`day` is touched, never `bucket` — this is a historical marker for the ring
to read later, not a reschedule. Because it's evaluated against the shared
predicate on the row's pre-completion columns, a task that was
dismissed-then-completed is correctly *not* stamped — dismissal already
took it out of Today, and completing it shouldn't put it back in, even
retroactively, in the ring's accounting.

## Why `taskDragId`'s dual-id mechanism survived ghost removal

It would be easy to read "no more ghosts" as "no more duplicate ids" and
delete the `taskDragId` prefix on `TaskRow`'s dnd-kit sortable id as dead
code from the ghost era. That would be wrong, and it's worth stating clearly
why it survives: **it was never ghost machinery.** It exists because the
same task can be on screen twice — its Backlog row and its Today row — and
dnd-kit requires sortable ids to be unique within one `DndContext`. That
condition didn't go away with ghosts; if anything it got *more common*:
previously only a scheduled (bucket='today') task rendered twice, but now
**every** `inToday` task does, including every auto-included one that was
never dragged anywhere. Deleting the prefix would work fine in every test
that only exercises one column, then break drag the moment both columns are
visible with a shared task between them — exactly the shape of bug that's
easy to miss in review and painful to find later. The doc comment above it
is renamed to say this plainly, and a `TodoPage.test.tsx` gesture test
exercises a task visible in both columns at once.

## Deliberately out of scope

In the style of the predecessor doc's own out-of-scope list:

- **Project reordering from the Today column.** Today's project headers are
  read-only labels; reordering happens in the Backlog only, to avoid two
  draggable orderings of the same `projects.sort_order` fighting each other.
- **Per-column independent task ordering.** Today inherits `sort_order`
  rather than getting its own — see "Why `today_order` was abandoned" above.
- **Tag filtering.** Unrelated to this change; tags remain display-only, as
  before.
- **Nested projects.** Still not earned; the list tab is still the outer
  container.

## Risks and rollback

Migration 16 (`today_dismissed_day`) is purely additive, nullable, with no
backfill required — `NULL` is already the correct value for every existing
row. `today_order` survives in the schema even though nothing writes it
anymore. Taken together, a **code rollback is fully recoverable**: reverting
the application code leaves two harmless, unused-by-old-code columns behind,
and the board renders exactly as it did before this change, the same
guarantee the predecessor doc made for its own migrations.

The two-column drag "collision feel" — a Today row may sit geometrically
closer to an unrelated Backlog row across the gap than to its actual
target — is a genuine, honestly-flagged risk, but it is a **manual-QA item,
not a unit-testable one**: jsdom has no layout, so nothing in the automated
suite can observe rect distances the way `closestCenter` does at runtime.
If the feel is wrong in practice, the mitigation is swapping collision
strategies (e.g. a directional one), not a test — that's a real follow-up,
not a scope failure of this change.
