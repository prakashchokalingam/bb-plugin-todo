# Two blocks, one axis of membership — design

Status: approved 2026-09-01
Date: 2026-09-01

Supersedes `docs/design/2026-08-31-today-as-view.md` in full. That doc is
left in place as history (its Status line now says so); this doc is the
current source of truth for how In Progress membership works.

## Problem

`docs/design/2026-08-31-today-as-view.md` fixed the ghost-row problem by
making Today a filtered lens over the Backlog instead of a second place a
task's identity lived. That was the right move, but it left Today's
*membership rule* untouched: a task belonged to Today if it was manually
scheduled **or** if its due date fell today or earlier. Two independent
things could put a task in front of you, and only one of them was a choice
you made.

That combination fights itself in practice:

- **"Why is this here?" stopped having one answer.** A row in Today might
  be there because you dragged it in, or because you wrote a due date on it
  three weeks ago and forgot, or because it was overdue and the calendar
  ticked over while you weren't looking. The row looks identical in all
  three cases. A view whose membership rule can't be read off the row
  itself has stopped being legible — which was the entire point of
  splitting Backlog from Today in the first place (see
  `docs/design/2026-08-27-projects.md`'s original problem statement about a
  flat list lying to you).
- **Removing a task from Today needed a whole subsystem.** Because a due
  date could re-admit a task with no drag involved, "take this out of
  Today" needed something to remember that refusal — `today_dismissed_day`,
  a self-expiring stamp, two separate write paths (`moveTask` and the
  dedicated `dismissFromToday` RPC) depending on whether the task had ever
  been manually scheduled, and a predicate that checked three columns
  instead of one. Every one of those pieces existed only to manage the
  friction between two membership rules that didn't agree with each other.
- **The stage axis and the calendar axis were fighting for the same real
  estate.** A task could be `stage='pending'` (never dragged anywhere) and
  still render in Today, dimmed nothing, fully interactive, because
  `due_at` said so. That's not a bug in the old design — it was the design
  — but it meant "in Today" and "in progress" were never quite the same
  question, even though the UI presented them as one column.

The fix is not another patch on the membership predicate. It's removing the
second axis entirely.

## Core decision

**In Progress membership is stage, and only stage. The user — never the
calendar — decides what's in progress.**

`IN_PROGRESS_MEMBERSHIP_SQL` collapses from a three-column OR/AND
expression involving `day`, `due_at`, and `dismissed_day` down to one
clause:

```sql
stage = 'in_progress'
```

That's the whole predicate. A due date is now purely informational: it
renders its humanised, tone-coded chip wherever the task happens to be, and
an overdue task's red "late" text and the Backlog's overdue ring are the
only signals it gets. It never writes to `stage`, never auto-includes
itself in In Progress, and never needs a dismissal to be kept out. "Today"
as a concept — a day-scoped view superimposed on top of the stage axis —
is deleted, not renamed: there is no `day` column, no rollover, no midnight
cron, nothing that moves a task in or out of In Progress on its own.

This is a stronger claim than the predecessor doc made. That doc's core
decision was "Today stops being a place and becomes a flag" — but the flag
still had two ways to turn on. This doc's decision is that there is
**exactly one way to turn it on**: a person, by dragging a task across or
clicking its stage toggle. Everything downstream falls out of that one
sentence:

- The membership predicate needs no bound parameters (no `today`, no
  `startOfTomorrow`) and can't disagree with itself across a day boundary,
  because it doesn't read the calendar at all.
- There is nothing to dismiss, so `dismissed_day` and the entire
  dismissal-stamp machinery (`nextDismissedDay`, the dedicated
  `dismissFromToday` RPC) have no job left and are deleted along with it.
  A `pending` row can never boomerang back into In Progress on its own —
  there's no due-date arithmetic left that could do that.
- "Why is this row in In Progress?" now has exactly one answer, always:
  someone put it there. The row's own history (`in_progress_since`, see
  below) can tell you *when*, but never *whether the calendar did it for
  them* — because the calendar never can.

Concretely: migration 20 drops `day` and `dismissed_day`, `lib/rollover.ts`
is deleted, and `IN_PROGRESS_MEMBERSHIP_SQL` (and its pure-TS twin
`isInProgressMember`) become the one-line predicate above. `getBoard`'s
`inProgress` object loses its `day` field — there is no calendar date left
for an In Progress header to display. See `docs/SPEC.md`'s product rules 4
and 7 for the implementation-level statement of this decision.

## Why carried-days resets on park, not cumulative time-in-progress

The old `carried_count` was a rollover artifact: every night, every task
still in Today got `carried_count + 1`, so the badge counted "how many
midnights has this survived." With rollover gone, that mechanic has no
midnight to hook into, so it needed a real replacement, not just a rename.
The chosen replacement is `in_progress_since` (epoch ms, stamped the
instant `stage` flips `pending -> in_progress`) with `carriedDays` derived
at read time as whole local-calendar-days since that stamp — and, critically,
**cleared to `NULL` the instant the task is parked back to `pending`**, so
the next time it enters In Progress the clock restarts at 0.

Two alternatives were on the table, and both were rejected:

- **Cumulative time-in-progress.** Keep a durable running total —
  `total_days_in_progress` or similar — that only ever goes up, surviving
  any number of park/restart cycles. This was rejected because it optimizes
  for the wrong thing: it would punish a person for the *honest* act of
  parking a stalled task back to the Backlog to rethink it, by making the
  badge remember that shame forever. A cumulative counter turns "carried
  6d" into a permanent scar on a task's record rather than a live read on
  "how long has this actually been sitting in front of me, right now." It
  also makes the number harder to reason about — a task carried 3 separate
  times for 2 days each shows the same "6d" as a task that sat untouched
  for 6 days straight, which erases exactly the distinction a badge like
  this exists to surface.
- **No reset at all, but freeze instead of clear (retain the last value
  until re-entry, then resume).** This was considered as a middle ground —
  keep the number visible even while parked, so you don't lose the context
  of "this was carried 6 times" the moment you park it. Rejected because it
  reintroduces a durable counter by the back door (something has to hold
  "6" somewhere while `stage='pending'`), and because it still rewards
  staring at a stalled number rather than rewards the *action* of dealing
  with the task. If parking a task and un-parking it a week later resumes
  exactly where the badge left off, parking stops being meaningfully
  different from just leaving the task in In Progress and ignoring it.

The chosen design — reset to 0 on park, clean-slate on the next
`pending -> in_progress` flip — is a deliberate incentive: the badge
rewards *actually dealing with* a stalled task, even if "dealing with it"
means admitting it's not truly in progress right now and shelving it
properly. A fresh "carried 0d — no badge" the next time you pick it back
up is the reward for having been honest about its state, not a trick to
hide the avoidance. See `docs/SPEC.md` rule 9 and `nextInProgressSince` in
`lib/db.ts` for the exact write rule this decision compiles down to.

## Why panel collapse is `localStorage`, not server-persisted

This phase also shipped panel-level collapse (collapse the entire Backlog
or In Progress column, not just one project's rows inside it — see
`hooks/usePanelCollapse.ts` and `components/CollapsedRail.tsx`). The
existing per-project collapse (`ProjectDto.collapsed`/`inProgressCollapsed`)
is server-persisted, via `setProjectCollapsed`, specifically because it's
single-user-local-plugin-cheap and the payoff (your project layout survives
a reload, on whatever device you reload from) is real. Panel collapse
deliberately does **not** follow that precedent, and stores its choice in
`localStorage` under `todo.panel.<listId>` instead.

The reasoning is about what kind of fact this is, not about cost:

- **It's view state, not board data.** Which panel you'd rather have out of
  the way *right now, on this screen* says nothing about the tasks, the
  projects, or anyone else who might open this list. Project collapse
  changes what a *board* looks like; panel collapse changes what *this
  window* looks like. Only the former belongs in the database.
- **A round trip would make the UI feel worse, not better.** Reading
  collapse state synchronously out of `localStorage` on first render (a
  lazy `useState` initializer, not a post-mount effect) means the panel is
  in its correct state on the very first paint — no flash of
  expanded-then-collapsed while a `getBoard` round trip resolves. Server
  persistence would either reintroduce that flash or require holding the
  whole board render hostage to an extra round trip before painting
  anything, for a preference nobody but the person at this keyboard cares
  about.
- **Nobody needs it to travel.** Unlike a project's name or color, "which
  half of my screen I've hidden" has no reason to be the same on your
  phone as on your laptop, and no reason to be visible to a collaborator on
  a shared list. Tying it to the server would synchronize something that
  was never meant to be shared, at the cost of the latency above, for a
  benefit nobody asked for.

This is why the two collapse mechanisms are kept structurally separate
rather than merged into one bit: `usePanelCollapse` knows nothing about
projects, `toggleProjectCollapsed` knows nothing about panels, and neither
one's persistence choice leaks into the other's. See `docs/SPEC.md`'s
"Panel collapse" subsection and `hooks/usePanelCollapse.ts`'s file header
for the implementation-level version of this same argument.

## Deliberately out of scope

- **Reviving `today_order`/`in_progress_order`.** Both are dropped outright
  by migration 20 (not just abandoned, unlike the predecessor doc's
  treatment of `today_order`) — In Progress has now inherited `sort_order`
  through two full phases without the shared-ordering complaint the
  predecessor doc hedged against ever materializing. If it ever does, it's
  a new migration, not a revival of a stale column.
- **A "snooze" or "later today" affordance to replace due-date
  auto-inclusion.** Some auto-inclusion behavior is genuinely lost by this
  change (see Risks below); reintroducing a scoped, opt-in version of it is
  a real idea, but it's a new feature with its own design doc, not a
  patch on this one.
- **Migrating `carried_count`'s historical value into anything richer than
  the one-time `in_progress_since` backfill.** The backfill
  (`in_progress_since = now - carried_count days`) preserves an existing
  streak's *appearance* on first load; it does not attempt to reconstruct
  the actual historical dates a task entered/left In Progress, which the
  old schema never recorded either.

## Risks

**Nothing pulls an overdue task in front of you anymore.** This is the
honest cost of the core decision, not a bug to fix later. Under the old
membership rule, an overdue task auto-appeared in Today whether you asked
for it or not — the calendar did the reminding for you. Under this design,
that same task sits quietly in the Backlog: it renders its due chip in red
("2d late"), it counts toward the Backlog's overdue ring and the sidebar's
total-overdue accessory, but nothing moves it into your active view. If you
don't look at the Backlog, you will not see it. The overdue ring is now the
*only* remaining nudge — a number that increments in a corner, not a row
that shows up where you're already looking.

This is a real, foreseeable regression in "does the app remind you of the
thing you're avoiding," which was arguably the single strongest feature of
the due-date-driven design. It is accepted here because the alternative —
two membership rules fighting for the same UI — was worse in a different
way (illegibility, not just missed reminders), and because "the user
decides what's in progress" is a coherent, defensible product stance on its
own terms. But it should be named plainly rather than discovered by a user
three weeks from now wondering why an overdue task never showed up where
they expected it. If this turns out to be the wrong trade in practice, the
fix is a new, explicit surfacing mechanism (a "needs attention" filter on
the Backlog, a due-soon digest, or similar) — not reviving auto-inclusion
into In Progress, which is exactly the two-axis problem this document set
out to remove.

**Migration 20 is additive-then-subtractive, not purely additive.**
Unlike most of this codebase's migrations, this one both adds a column
(`in_progress_since`) and drops three (`day`, `in_progress_order`,
`dismissed_day`) in the same statement. A code rollback after this
migration ships is **not** the usual "two harmless unused columns sit
there" story — old code expecting `day`/`dismissed_day` to exist will
fail outright against a post-migration-20 database, since those columns are
gone, not merely unwritten. `carried_count` is kept specifically to soften
this: a rollback can still read a task's last-known streak off it, even
though nothing after this migration writes it. This is a deliberate,
narrower rollback guarantee than earlier migrations offered, accepted
because keeping `day`/`in_progress_order`/`dismissed_day` around forever
for a rollback that becomes less likely with every passing release was
judged not worth three permanently dead columns.
