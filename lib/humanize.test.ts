import { describe, expect, it } from "vitest";
import { formatAge, formatDue } from "./humanize";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Wednesday 10 Jan 2024, 12:00:00 local time. Constructed via the local-time
// Date constructor (not `Date.UTC` / ISO strings) so these tests do not
// depend on the machine's timezone matching UTC.
const NOON = new Date(2024, 0, 10, 12, 0, 0, 0).getTime();

// Midnight start-of-day anchor, used for the same-day / next-day boundary
// tests where we need full control over how much of "today" remains.
const MIDNIGHT = new Date(2024, 0, 10, 0, 0, 0, 0).getTime();

describe("formatDue — future, seconds", () => {
  it("singular: in 1 second", () => {
    const r = formatDue(NOON + 1 * SECOND, NOON, false);
    expect(r.text).toBe("in 1 second");
    expect(r.tone).toBe("soon");
    expect(r.tickMs).toBe(SECOND);
  });

  it("plural: in 10 seconds", () => {
    const r = formatDue(NOON + 10 * SECOND, NOON, false);
    expect(r.text).toBe("in 10 seconds");
    expect(r.tone).toBe("soon");
    expect(r.tickMs).toBe(SECOND);
  });

  it("boundary: 59s stays in the seconds bucket", () => {
    const r = formatDue(NOON + 59 * SECOND, NOON, false);
    expect(r.text).toBe("in 59 seconds");
    expect(r.tone).toBe("soon");
    expect(r.tickMs).toBe(SECOND);
  });

  it("boundary: 60s rolls into the minutes bucket", () => {
    const r = formatDue(NOON + 60 * SECOND, NOON, false);
    expect(r.text).toBe("in 1 min");
    expect(r.tone).toBe("soon");
    expect(r.tickMs).toBe(30 * SECOND);
  });
});

describe("formatDue — future, minutes", () => {
  it("plural: in 22 min", () => {
    const r = formatDue(NOON + 22 * MINUTE, NOON, false);
    expect(r.text).toBe("in 22 min");
    expect(r.tone).toBe("soon");
    expect(r.tickMs).toBe(30 * SECOND);
  });

  it("boundary: 59m stays in the minutes bucket", () => {
    const r = formatDue(NOON + 59 * MINUTE, NOON, false);
    expect(r.text).toBe("in 59 min");
    expect(r.tone).toBe("soon");
    expect(r.tickMs).toBe(30 * SECOND);
  });

  it("boundary: 60m rolls into the hours bucket (no longer soon)", () => {
    const r = formatDue(NOON + 60 * MINUTE, NOON, false);
    expect(r.text).toBe("in 1 hour");
    expect(r.tone).toBe("neutral");
    expect(r.tickMs).toBe(MINUTE);
  });
});

describe("formatDue — future, same local day (hours)", () => {
  it("singular: in 1 hour", () => {
    const r = formatDue(NOON + 1 * HOUR, NOON, false);
    expect(r.text).toBe("in 1 hour");
    expect(r.tone).toBe("neutral");
    expect(r.tickMs).toBe(MINUTE);
  });

  it("plural: in 3 hours", () => {
    const r = formatDue(NOON + 3 * HOUR, NOON, false);
    expect(r.text).toBe("in 3 hours");
    expect(r.tone).toBe("neutral");
    expect(r.tickMs).toBe(MINUTE);
  });

  it("boundary: 23h59m from midnight is still 'today'", () => {
    const r = formatDue(MIDNIGHT + 23 * HOUR + 59 * MINUTE, MIDNIGHT, false);
    expect(r.text).toBe("in 23 hours");
    expect(r.tone).toBe("neutral");
    expect(r.tickMs).toBe(MINUTE);
  });
});

describe("formatDue — future, next local day", () => {
  it("boundary: exactly 24h from midnight rolls into 'tomorrow'", () => {
    const r = formatDue(MIDNIGHT + 24 * HOUR, MIDNIGHT, false);
    expect(r.text).toBe("tomorrow");
    expect(r.tone).toBe("neutral");
    expect(r.tickMs).toBe(MINUTE);
  });

  it("without a due time: 'tomorrow'", () => {
    const tomorrowNoon = new Date(2024, 0, 11, 12, 0, 0, 0).getTime();
    const r = formatDue(tomorrowNoon, NOON, false);
    expect(r.text).toBe("tomorrow");
    expect(r.tone).toBe("neutral");
  });

  it("with a due time: 'tomorrow 9:00 am'", () => {
    const tomorrowNine = new Date(2024, 0, 11, 9, 0, 0, 0).getTime();
    const r = formatDue(tomorrowNine, NOON, true);
    expect(r.text).toBe("tomorrow 9:00 am");
    expect(r.tone).toBe("neutral");
  });
});

describe("formatDue — future, within a week", () => {
  it("without a due time: weekday name only ('Fri')", () => {
    // NOON is Wed 10 Jan 2024; Fri 12 Jan is 2 days out.
    const friNoon = new Date(2024, 0, 12, 12, 0, 0, 0).getTime();
    const r = formatDue(friNoon, NOON, false);
    expect(r.text).toBe("Fri");
    expect(r.tone).toBe("neutral");
    expect(r.tickMs).toBe(MINUTE);
  });

  it("with a due time: 'Fri 9:00 am'", () => {
    const friNine = new Date(2024, 0, 12, 9, 0, 0, 0).getTime();
    const r = formatDue(friNine, NOON, true);
    expect(r.text).toBe("Fri 9:00 am");
    expect(r.tone).toBe("neutral");
  });

  it("6 days out is still within the weekday-name window", () => {
    const sixDaysOut = new Date(2024, 0, 16, 12, 0, 0, 0).getTime();
    const r = formatDue(sixDaysOut, NOON, false);
    expect(r.text).toBe("Tue");
    expect(r.tone).toBe("neutral");
  });
});

describe("formatDue — future, beyond a week", () => {
  it("without a due time: 'Fri 22 Aug' (same year, no year shown)", () => {
    const augNow = new Date(2024, 7, 1, 12, 0, 0, 0).getTime();
    const dueAt = new Date(2024, 7, 22, 12, 0, 0, 0).getTime(); // Thu 22 Aug 2024
    const r = formatDue(dueAt, augNow, false);
    expect(r.text).toBe("Thu 22 Aug");
    expect(r.tone).toBe("neutral");
    expect(r.tickMs).toBe(MINUTE);
  });

  it("with a due time: date + time appended", () => {
    const augNow = new Date(2024, 7, 1, 12, 0, 0, 0).getTime();
    const dueAt = new Date(2024, 7, 22, 9, 0, 0, 0).getTime();
    const r = formatDue(dueAt, augNow, true);
    expect(r.text).toBe("Thu 22 Aug 9:00 am");
  });

  it("a different year is appended", () => {
    const decNow = new Date(2024, 11, 28, 12, 0, 0, 0).getTime();
    const dueAt = new Date(2025, 0, 15, 12, 0, 0, 0).getTime(); // Wed 15 Jan 2025
    const r = formatDue(dueAt, decNow, false);
    expect(r.text).toBe("Wed 15 Jan 2025");
    expect(r.tone).toBe("neutral");
  });
});

describe("formatDue — past", () => {
  it("just now: < 60s late", () => {
    const r = formatDue(NOON - 30 * SECOND, NOON, false);
    expect(r.text).toBe("just now");
    expect(r.tone).toBe("late");
    expect(r.tickMs).toBe(SECOND);
  });

  it("due exactly now is 'just now'", () => {
    const r = formatDue(NOON, NOON, false);
    expect(r.text).toBe("just now");
    expect(r.tone).toBe("late");
  });

  it("singular: 1 min late", () => {
    const r = formatDue(NOON - 1 * MINUTE, NOON, false);
    expect(r.text).toBe("1 min late");
    expect(r.tone).toBe("late");
    expect(r.tickMs).toBe(30 * SECOND);
  });

  it("plural: 12 min late", () => {
    const r = formatDue(NOON - 12 * MINUTE, NOON, false);
    expect(r.text).toBe("12 min late");
    expect(r.tone).toBe("late");
    expect(r.tickMs).toBe(30 * SECOND);
  });

  it("singular: 1 hour late", () => {
    const r = formatDue(NOON - 1 * HOUR, NOON, false);
    expect(r.text).toBe("1 hour late");
    expect(r.tone).toBe("late");
    expect(r.tickMs).toBe(MINUTE);
  });

  it("plural: 3 hours late", () => {
    const r = formatDue(NOON - 3 * HOUR, NOON, false);
    expect(r.text).toBe("3 hours late");
    expect(r.tone).toBe("late");
    expect(r.tickMs).toBe(MINUTE);
  });

  it("singular: 1 day late", () => {
    const r = formatDue(NOON - 24 * HOUR, NOON, false);
    expect(r.text).toBe("1 day late");
    expect(r.tone).toBe("late");
    expect(r.tickMs).toBe(MINUTE);
  });

  it("plural: 2 days late", () => {
    const r = formatDue(NOON - 2 * DAY, NOON, false);
    expect(r.text).toBe("2 days late");
    expect(r.tone).toBe("late");
    expect(r.tickMs).toBe(MINUTE);
  });

  it("boundary: 59s late stays 'just now'", () => {
    const r = formatDue(NOON - 59 * SECOND, NOON, false);
    expect(r.text).toBe("just now");
    expect(r.tone).toBe("late");
  });

  it("boundary: 60s late rolls into minutes", () => {
    const r = formatDue(NOON - 60 * SECOND, NOON, false);
    expect(r.text).toBe("1 min late");
    expect(r.tone).toBe("late");
  });

  it("boundary: 59m late stays in minutes", () => {
    const r = formatDue(NOON - 59 * MINUTE, NOON, false);
    expect(r.text).toBe("59 min late");
    expect(r.tone).toBe("late");
  });

  it("boundary: 60m late rolls into hours", () => {
    const r = formatDue(NOON - 60 * MINUTE, NOON, false);
    expect(r.text).toBe("1 hour late");
    expect(r.tone).toBe("late");
  });

  it("boundary: 23h59m late stays in hours", () => {
    const r = formatDue(NOON - (23 * HOUR + 59 * MINUTE), NOON, false);
    expect(r.text).toBe("23 hours late");
    expect(r.tone).toBe("late");
  });

  it("boundary: 24h late rolls into days", () => {
    const r = formatDue(NOON - 24 * HOUR, NOON, false);
    expect(r.text).toBe("1 day late");
    expect(r.tone).toBe("late");
  });
});

describe("formatDue — tone summary", () => {
  it("all three tones are reachable", () => {
    expect(formatDue(NOON + 5 * SECOND, NOON, false).tone).toBe("soon");
    expect(formatDue(NOON + 3 * HOUR, NOON, false).tone).toBe("neutral");
    expect(formatDue(NOON - 3 * HOUR, NOON, false).tone).toBe("late");
  });
});

describe("formatDue — tickMs summary", () => {
  it("all three tickMs values are reachable", () => {
    expect(formatDue(NOON + 5 * SECOND, NOON, false).tickMs).toBe(SECOND);
    expect(formatDue(NOON + 5 * MINUTE, NOON, false).tickMs).toBe(30 * SECOND);
    expect(formatDue(NOON + 3 * HOUR, NOON, false).tickMs).toBe(MINUTE);
  });
});

describe("formatAge", () => {
  it("< 60s: 'added just now'", () => {
    const r = formatAge(NOON - 10 * SECOND, NOON);
    expect(r.text).toBe("added just now");
  });

  it("boundary: 59s stays 'just now'", () => {
    const r = formatAge(NOON - 59 * SECOND, NOON);
    expect(r.text).toBe("added just now");
  });

  it("boundary: 60s rolls into minutes", () => {
    const r = formatAge(NOON - 60 * SECOND, NOON);
    expect(r.text).toBe("added 1m ago");
  });

  it("< 60m: 'added 12m ago'", () => {
    const r = formatAge(NOON - 12 * MINUTE, NOON);
    expect(r.text).toBe("added 12m ago");
  });

  it("singular minute: 'added 1m ago'", () => {
    const r = formatAge(NOON - 1 * MINUTE, NOON);
    expect(r.text).toBe("added 1m ago");
  });

  it("boundary: 59m stays in minutes", () => {
    const r = formatAge(NOON - 59 * MINUTE, NOON);
    expect(r.text).toBe("added 59m ago");
  });

  it("boundary: 60m rolls into hours", () => {
    const r = formatAge(NOON - 60 * MINUTE, NOON);
    expect(r.text).toBe("added 1h ago");
  });

  it("< 24h: 'added 5h ago'", () => {
    const r = formatAge(NOON - 5 * HOUR, NOON);
    expect(r.text).toBe("added 5h ago");
  });

  it("singular hour: 'added 1h ago'", () => {
    const r = formatAge(NOON - 1 * HOUR, NOON);
    expect(r.text).toBe("added 1h ago");
  });

  it("boundary: 23h stays in hours", () => {
    const r = formatAge(NOON - 23 * HOUR, NOON);
    expect(r.text).toBe("added 23h ago");
  });

  it("boundary: 24h rolls into days", () => {
    const r = formatAge(NOON - 24 * HOUR, NOON);
    expect(r.text).toBe("added 1d ago");
  });

  it("< 7d: 'added 3d ago'", () => {
    const r = formatAge(NOON - 3 * DAY, NOON);
    expect(r.text).toBe("added 3d ago");
  });

  it("singular day: 'added 1d ago'", () => {
    const r = formatAge(NOON - 1 * DAY, NOON);
    expect(r.text).toBe("added 1d ago");
  });

  it("boundary: 6d stays in days", () => {
    const r = formatAge(NOON - 6 * DAY, NOON);
    expect(r.text).toBe("added 6d ago");
  });

  it("boundary: 7d rolls into weeks", () => {
    const r = formatAge(NOON - 7 * DAY, NOON);
    expect(r.text).toBe("added 1w ago");
  });

  it("< 5 weeks: 'added 2w ago'", () => {
    const r = formatAge(NOON - 14 * DAY, NOON);
    expect(r.text).toBe("added 2w ago");
  });

  it("singular week: 'added 1w ago'", () => {
    const r = formatAge(NOON - 7 * DAY, NOON);
    expect(r.text).toBe("added 1w ago");
  });

  it("boundary: 4 weeks stays in weeks", () => {
    const r = formatAge(NOON - 28 * DAY, NOON);
    expect(r.text).toBe("added 4w ago");
  });

  it("boundary: 5 weeks rolls into months", () => {
    const r = formatAge(NOON - 35 * DAY, NOON);
    expect(r.text).toBe("added 1mo ago");
  });

  it("beyond 5 weeks: 'added 3mo ago'", () => {
    const r = formatAge(NOON - 100 * DAY, NOON);
    expect(r.text).toBe("added 3mo ago");
  });

  it("title contains a full absolute date and time", () => {
    const createdAt = new Date(2024, 0, 5, 9, 30, 0, 0).getTime();
    const r = formatAge(createdAt, NOON);
    expect(r.title).toContain("2024");
    expect(r.title).toMatch(/\d{1,2}:\d{2}/);
  });
});
