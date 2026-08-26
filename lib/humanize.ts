export type DueTone = "neutral" | "soon" | "late";

export interface DueInfo {
  text: string;
  tone: DueTone;
  tickMs: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAYS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// "min" is an invariant abbreviation (never "mins"), per the humanize table.
function minutesText(n: number): string {
  return `${n} min`;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatTimeOfDay(ms: number): string {
  const d = new Date(ms);
  let hours = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const minuteStr = minutes.toString().padStart(2, "0");
  return `${hours}:${minuteStr} ${ampm}`;
}

function formatWeekday(ms: number): string {
  return WEEKDAYS[new Date(ms).getDay()];
}

function formatFullDate(ms: number, now: number): string {
  const d = new Date(ms);
  const weekday = WEEKDAYS[d.getDay()];
  const day = d.getDate();
  const month = MONTHS[d.getMonth()];
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const base = `${weekday} ${day} ${month}`;
  return sameYear ? base : `${base} ${d.getFullYear()}`;
}

/**
 * Format an absolute due timestamp relative to `now` into a short humanised
 * string, a tone, and the recommended re-render interval (`tickMs`).
 *
 * Pure: takes `now` explicitly, never reads the clock itself.
 */
export function formatDue(
  dueAt: number,
  now: number,
  hasDueTime: boolean,
): DueInfo {
  const diff = dueAt - now; // positive = future, negative = past

  if (diff > 0) {
    // Future
    if (diff < MINUTE) {
      const seconds = Math.ceil(diff / SECOND);
      return { text: `in ${pluralize(seconds, "second")}`, tone: "soon", tickMs: SECOND };
    }
    if (diff < HOUR) {
      const minutes = Math.floor(diff / MINUTE);
      return { text: `in ${minutesText(minutes)}`, tone: "soon", tickMs: SECOND * 30 };
    }

    const todayStart = startOfLocalDay(now);
    const dueDayStart = startOfLocalDay(dueAt);
    const dayDiff = Math.round((dueDayStart - todayStart) / DAY);

    if (diff < DAY && dayDiff === 0) {
      const hours = Math.floor(diff / HOUR);
      return { text: `in ${pluralize(hours, "hour")}`, tone: "neutral", tickMs: MINUTE };
    }

    if (dayDiff === 1) {
      const text = hasDueTime ? `tomorrow ${formatTimeOfDay(dueAt)}` : "tomorrow";
      return { text, tone: "neutral", tickMs: MINUTE };
    }

    if (dayDiff >= 2 && dayDiff <= 6) {
      const weekday = formatWeekday(dueAt);
      const text = hasDueTime ? `${weekday} ${formatTimeOfDay(dueAt)}` : weekday;
      return { text, tone: "neutral", tickMs: MINUTE };
    }

    // Beyond a week (or same-day-but->=24h edge, or dayDiff computed oddly)
    const dateText = formatFullDate(dueAt, now);
    const text = hasDueTime ? `${dateText} ${formatTimeOfDay(dueAt)}` : dateText;
    return { text, tone: "neutral", tickMs: MINUTE };
  }

  // Past (diff <= 0)
  const pastDiff = -diff;
  if (pastDiff < MINUTE) {
    return { text: "just now", tone: "late", tickMs: SECOND };
  }
  if (pastDiff < HOUR) {
    const minutes = Math.floor(pastDiff / MINUTE);
    return { text: `${minutesText(minutes)} late`, tone: "late", tickMs: SECOND * 30 };
  }
  if (pastDiff < DAY) {
    const hours = Math.floor(pastDiff / HOUR);
    return { text: `${pluralize(hours, "hour")} late`, tone: "late", tickMs: MINUTE };
  }
  const days = Math.floor(pastDiff / DAY);
  return { text: `${pluralize(days, "day")} late`, tone: "late", tickMs: MINUTE };
}

export interface AgeInfo {
  text: string;
  title: string;
}

const WEEK = 7 * DAY;
const FIVE_WEEKS = 5 * WEEK;
// Average month length so "beyond 5 weeks" reads as a stable-ish "3mo ago"
// rather than drifting oddly around calendar month boundaries.
const MONTH = 30.44 * DAY;

function formatAbsoluteDateTime(ms: number): string {
  const d = new Date(ms);
  const datePart = d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const timePart = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${datePart} ${timePart}`;
}

/**
 * Format how long ago a task was created into a compact, always-"added"
 * prefixed string plus a full absolute date/time for a tooltip.
 *
 * Pure: takes `now` explicitly, never reads the clock itself. Purely
 * context, never urgency — unlike `formatDue`, there is no tone here.
 */
export function formatAge(createdAt: number, now: number): AgeInfo {
  const diff = Math.max(0, now - createdAt);
  const title = formatAbsoluteDateTime(createdAt);

  if (diff < MINUTE) {
    return { text: "added just now", title };
  }
  if (diff < HOUR) {
    const minutes = Math.floor(diff / MINUTE);
    return { text: `added ${minutes}m ago`, title };
  }
  if (diff < DAY) {
    const hours = Math.floor(diff / HOUR);
    return { text: `added ${hours}h ago`, title };
  }
  if (diff < WEEK) {
    const days = Math.floor(diff / DAY);
    return { text: `added ${days}d ago`, title };
  }
  if (diff < FIVE_WEEKS) {
    const weeks = Math.floor(diff / WEEK);
    return { text: `added ${weeks}w ago`, title };
  }
  const months = Math.floor(diff / MONTH);
  return { text: `added ${months}mo ago`, title };
}
