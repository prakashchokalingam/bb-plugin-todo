# Todo for BB

A daily to-do list with two zones instead of one flat list: a Backlog and a
Today, on one drag-and-drop board. Anything left unfinished in Today rolls
forward automatically at midnight, with a visible "carried 3×" badge — so
avoidance stops hiding in plain sight.

## Why this exists

A flat to-do list lies to you. A task you've been dodging for three weeks
looks exactly the same as one you added this morning — same row, same
checkbox, no signal that you've already failed it a dozen times.

I wanted a list where that couldn't happen quietly. So Todo splits the board
into two zones: a Backlog for everything that isn't urgent yet, and a Today
for what you're actually committing to today. Nothing crosses from Backlog
into Today on its own. But once something is in Today and you don't finish
it, it doesn't vanish and it doesn't quietly slide to tomorrow unnoticed —
it carries forward with a badge that counts how many times it's happened.
"carried 1×" is a nudge. "carried 6×" is a conversation with yourself.

That's the whole idea: make the two zones and the carry count do the work
that willpower usually has to.

## What it does

- **Two zones + rollover** — Backlog and Today live on one drag-and-drop
  surface; drag a task either direction or reorder within a zone. At
  midnight, anything left open in Today gets carried into the new day and
  its carry count increments, so unfinished work stays visible instead of
  quietly aging into invisibility.
- **Tabs** — multiple lists (e.g. Work, Personal), each with its own
  Backlog/Today, created, renamed, reordered, and deleted from the tab strip.
- **Tags** — global, colour-coded tags. A 🏷 icon on every row opens a
  picker to search, create, and apply tags in place; a `Manage tags…` dialog
  handles rename, recolour, delete, and drag-to-reorder.
- **Subtasks, one level deep** — break a task down without nesting getting
  out of hand; a progress ring on the parent row shows how many are done.
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
npm test         # vitest — 208 tests across 9 files
npm run typecheck # tsc --noEmit
npm run build     # bb plugin build
```

CI (`.github/workflows/ci.yml`) runs `tsc --noEmit` and `vitest run` on every
pull request.

- `docs/SPEC.md` — the implementation contract; source of truth for storage,
  RPC methods, and product rules.
- `docs/UX.md` — the board layout, row anatomy, and component breakdown.
- `docs/design/` — dated design records for individual features (e.g.
  `docs/design/2026-08-26-tags.md` for tags).

## Known gaps

- **No browser-level tests.** The suite is unit and React Testing Library
  only — nothing drives a real browser. That's a real gap: a colour-picker
  control once shipped fully non-functional while all 207 tests at the time
  stayed green, because nothing exercised it the way a mouse would. Treat
  anything interaction-heavy (drag-and-drop, popovers, inline rename) as
  under-tested until it's been clicked through by hand.
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
