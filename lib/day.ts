// Server-LOCAL day math. Never derive a day string from `toISOString()` —
// that is UTC and drifts a day in the evening/morning depending on timezone.

/** Formats `date` as a server-local `YYYY-MM-DD` string. */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Epoch ms of the local midnight that starts the day AFTER `date`'s local
 * day — the exclusive upper bound for "due today or earlier" (a due_at less
 * than this value is today or overdue). Built from local calendar
 * components via the `Date` constructor, never UTC arithmetic: `date.getTime()
 * + 24 * 60 * 60 * 1000` is wrong by an hour on a DST transition day, and
 * this function must be exact at the boundary (a task due at 11:59pm must
 * count as "today" up to, and only up to, the instant local midnight ticks
 * over).
 */
export function startOfNextLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0).getTime();
}

/**
 * Whole local-calendar-day difference between the local day of `fromMs` and
 * the local day of `now` — same day is 0, the next calendar day is 1, and so
 * on. Built on top of `localDay` (never raw ms arithmetic, which is wrong by
 * an hour across a DST transition) so it agrees with every other "which day
 * is this" reading in the app. Used to derive `TaskDto.carriedDays` from
 * `in_progress_since` without a durable "carried_count" counter.
 */
export function localDayDiff(fromMs: number, now: Date): number {
  const [fy, fm, fd] = localDay(new Date(fromMs)).split("-").map(Number);
  const [ty, tm, td] = localDay(now).split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}
