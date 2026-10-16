# Todo for BB

A daily to-do list with two blocks instead of one flat list: a Backlog and
an In Progress, side by side on one drag-and-drop board. The Backlog is the
complete, always-true list of everything — every open task, every project,
always undimmed. In Progress holds exactly what you've put there: dragging a
task in flips one flag (`stage`), nothing else about it changes. Nothing is
duplicated or dimmed to show it's "also" in In Progress — a task just
renders, fully interactive, in both places at once; which column it's in
is the only signal there is. A due date is just a due date: an overdue task
sits in the Backlog showing
its red "late" text, and never pulls itself into In Progress on its own.
Anything left in In Progress for more than a day shows a "carried Nd" badge
— so avoidance stops hiding in plain sight, right next to the project it's
stalling — but parking a task back to the Backlog resets that count, since
the point is to reward actually dealing with it, not to keep score forever.

## Why this exists

A flat to-do list lies to you. A task you've been dodging for three weeks
looks exactly the same as one you added this morning — same row, same
checkbox, no signal that you've already failed it a dozen times.

I wanted a list where that couldn't happen quietly. So Todo splits the board
into two blocks: a Backlog for everything that isn't urgent yet, and an In
Progress for what you're actually committing to right now. Nothing crosses
from Backlog into In Progress on its own — not a due date, not the
calendar, only you, by dragging or clicking a task in. But once something is
in In Progress and you haven't finished it, it doesn't vanish and it doesn't
quietly disappear unnoticed — it carries a badge that counts how many days
it's been sitting there. "carried 1d" is a nudge. "carried 6d" is a
conversation with yourself.

That's the whole idea: make the two blocks and the carry count do the work
that willpower usually has to.

## What it does

- **Two blocks, one axis of membership** — Backlog and In Progress sit side
  by side on one drag-and-drop board, each scrolling independently. In
  Progress membership is *solely* `stage = 'in_progress'` — no day, no due
  date, no auto-inclusion, no dismissal state to manage. Drag a task either
  direction, click its always-visible **Move to In Progress** / **Move to
  Backlog** button, or reorder within a block (reordering in In Progress
  reorders the Backlog too — they share one order, since In Progress is a
  view over the Backlog's own rows, not a separate list).
- **Projects** — file Backlog work into named, colour-coded projects (a
  third level of context — List -> Project -> Task -> Subtask — without a
  third level of nesting, since a project is a container, not a task).
  Collapse a project, rename it inline, recolour it, or delete it (its tasks
  release to loose, unfiled — nothing is deleted). Type `#Name` into the
  Backlog's own add-row to create a project inline, no dialog. In Progress
  mirrors the same project grouping, read-only, and further groups each
  project's tasks by their primary tag.
- **The Backlog is the source of truth; In Progress is a filtered view** —
  moving a task into In Progress never changes where it lives: its parent
  and project stay exactly what they were, and it never disappears from the
  Backlog or gets dimmed. It renders, fully interactive, in both places at
  once, and shows its trail (`Project > Parent`) back home when its parent
  isn't also in In Progress — so a stalled effort is
  legible as a stalled *project*, not just a stalled row you scroll past.
  Click **Move to Backlog** to send it back; it snaps to exactly the Backlog
  slot it never left. Due dates are purely informational: an overdue task
  turns red in the Backlog and counts toward the overdue ring, but it never
  pulls itself into In Progress — only a person decides that.
- **Carried days, reset on park** — flipping a task into In Progress stamps
  the moment; a "carried Nd" badge appears once it's been there a full day
  or more. Parking it back to the Backlog clears that clock — a deliberate
  choice to reward actually dealing with a task (even by shelving it) rather
  than letting a cumulative streak guilt-trip you forever.
- **Collapsible panels, per device** — each block's header has a chevron and
  a collapse button; collapsing one gives the other the full width (both
  collapsed at once is impossible). A collapsed block shrinks to a ~40px
  vertical rail (or a full-width one-line bar on narrow panels), click
  anywhere on it to bring it back. This is separate from, and independent
  of, the server-persisted per-project collapse below — it's per-device
  (`localStorage`), not synced, because which panel you like out of the way
  right now isn't board data.
- **Image attachments** — paste an image (PNG, JPEG, GIF, or WebP, up to 5 MB,
  10 per task) into the add row or a task's editor. Thumbnails show under the
  task; click one for the full-size preview. Images are stored as files in the
  plugin's data directory (next to `data.db`), not in the task record, and they
  are deleted from disk when you permanently delete the image, task, subtask,
  or list, or clear the archive. Completing a task keeps them.
- **Tabs** — multiple lists (e.g. Work, Personal), each with its own
  Backlog/In Progress, created, renamed, reordered, and deleted from the tab
  strip.
- **Tags** — global, colour-coded tags. A 🏷 icon on every row opens a
  picker to search, create, and apply tags in place; a `Manage tags…` dialog
  handles rename, recolour, delete, and drag-to-reorder.
- **Subtasks, one level deep** — break a task down without nesting getting
  out of hand; a progress ring on the parent row shows how many are done. A
  subtask can be moved into In Progress on its own, independently of its
  parent, and renders there exactly like a top-level task does.
- **Humanised due dates** — "in 22 min", "2d late", "Fri 9:00am", tone-coded
  by urgency (neutral, soon, late), plus an "added N ago" age chip for
  context.
- **Archive with undo** — completing a task clears it from the board
  instantly with an 8-second undo toast; the Archive groups completed tasks
  by day and lets you restore any of them later.

## Install

This isn't published to npm — it's a BB plugin, installed straight from this
git repository or from a local checkout, the way any BB plugin is.

From a clone of this repo:

```sh
npm install
bb plugin install .
```

From the repository URL directly, if your BB version supports installing
plugins from git:

```sh
bb plugin install git:https://github.com/prakashchokalingam/bb-plugin-todo.git
```

Requires BB `>=0.39` and plugin SDK `>=0.4.8` (see `package.json`'s
`engines`). After editing sources on a local install, reload with
`bb plugin reload todo`.

## Development

```sh
npm test         # vitest — 362 tests across 10 files
npm run typecheck # tsc --noEmit
npm run build     # bb plugin build
```

CI (`.github/workflows/ci.yml`) runs `tsc --noEmit` and `vitest run` on every
pull request.

- `docs/SPEC.md` — the implementation contract; source of truth for storage,
  RPC methods, and product rules.
- `docs/UX.md` — the board layout, row anatomy, and component breakdown.
- `docs/design/` — dated design records for individual features (e.g.
  `docs/design/2026-08-26-tags.md` for tags; `docs/design/2026-09-01-two-blocks.md`
  for the current Backlog/In Progress model, which supersedes the earlier
  `docs/design/2026-08-31-today-as-view.md`).

## Known gaps

- **No browser-level tests.** The suite is unit and React Testing Library
  only — nothing drives a real browser. That's a real gap: a colour-picker
  control once shipped fully non-functional while all 207 tests at the time
  stayed green, because nothing exercised it the way a mouse would. Treat
  anything interaction-heavy (drag-and-drop, popovers, inline rename) as
  under-tested until it's been clicked through by hand.
- **The two-column drag "collision feel" is unverified by tests.** jsdom has
  no layout, so nothing in the suite can prove that dragging a row across the
  gap between the Backlog and In Progress blocks feels right — a row may sit
  geometrically closer to an unrelated row in the other block than to its
  actual target. This is a manual-QA item, not something a unit test can
  catch; see `docs/design/2026-08-31-today-as-view.md`.
- **`lib/inProgressView.ts`'s correctness depends on the Backlog staying
  comprehensive.** The In Progress view is derived client-side from
  `backlog.tasks`, which today always holds every open task in the list. If
  the Backlog is ever virtualized or lazily paged for performance, In
  Progress would silently go blind to anything outside the loaded window —
  nothing would error, it would just stop showing tasks that are, in fact,
  in progress.
- **Nothing pulls an overdue task in front of you.** Since membership is
  purely `stage`, an overdue task never auto-enters In Progress — you have
  to look at the Backlog to see it (its red "late" text and the overdue
  ring are the only nudges). This is the deliberate trade of the two-blocks
  model; see `docs/design/2026-09-01-two-blocks.md`'s Risks section.
- **Tags are display-only.** You can apply, colour, and manage them, but you
  can't yet filter the board by tag.
- **Tag name matching is ASCII-only.** Uniqueness is enforced with SQLite's
  `COLLATE NOCASE`, which only case-folds ASCII — `İstanbul` and `istanbul`
  are treated as different tags.
- **A possible Escape-vs-blur race in inline rename** (tag manager, tab
  rename) is suspected but not confirmed: pressing Escape and losing focus
  in the same instant may commit instead of reverting. Unverified either
  way — flagging it as a known risk area rather than a confirmed bug.

## License

MIT — see [LICENSE](LICENSE).
