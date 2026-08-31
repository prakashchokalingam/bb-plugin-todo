import { describe, expect, it } from "vitest";
import { localDay, startOfNextLocalDay } from "./day.js";

// Runs `fn` with `process.env.TZ` temporarily set, restoring the prior value
// (or its absence) synchronously afterward. Node re-reads TZ on every new
// `Date`, so this is enough to exercise a specific timezone's DST calendar
// without depending on the machine running these tests. Used only for the
// DST cases below — every other test here deliberately runs in whatever
// timezone the machine/CI already has, per this file's existing convention
// of never hardcoding a zone via `toISOString()`/UTC math.
function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

describe("localDay", () => {
  it("formats an ordinary day, zero-padded", () => {
    expect(localDay(new Date(2026, 7, 5, 9, 30, 0, 0))).toBe("2026-08-05");
  });

  it("month boundary: the last day of a month formats as that month, not the next", () => {
    expect(localDay(new Date(2026, 0, 31, 23, 59, 59, 999))).toBe("2026-01-31");
  });

  it("year boundary: the last day of the year formats with the correct year", () => {
    expect(localDay(new Date(2026, 11, 31, 23, 59, 59, 999))).toBe("2026-12-31");
  });

  it("year boundary: the first day of the year formats with the new year, not the old", () => {
    expect(localDay(new Date(2027, 0, 1, 0, 0, 0, 0))).toBe("2027-01-01");
  });
});

describe("startOfNextLocalDay", () => {
  it("returns the epoch ms of local midnight starting the day after an ordinary day", () => {
    const d = new Date(2026, 7, 5, 15, 0, 0, 0);
    const expected = new Date(2026, 7, 6, 0, 0, 0, 0).getTime();
    expect(startOfNextLocalDay(d)).toBe(expected);
  });

  it("month boundary: the day after the last day of a month rolls into the next month", () => {
    const d = new Date(2026, 0, 31, 12, 0, 0, 0); // 31 Jan
    const expected = new Date(2026, 1, 1, 0, 0, 0, 0).getTime(); // 1 Feb
    expect(startOfNextLocalDay(d)).toBe(expected);
  });

  it("year boundary: the day after 31 Dec rolls into 1 Jan of the following year", () => {
    const d = new Date(2026, 11, 31, 12, 0, 0, 0);
    const expected = new Date(2027, 0, 1, 0, 0, 0, 0).getTime();
    expect(startOfNextLocalDay(d)).toBe(expected);
  });

  it("DST spring-forward: the returned boundary is real local midnight, not date.getTime() + 24h", () => {
    // 2024-03-10 is the US spring-forward day in America/New_York — clocks
    // skip 2:00am to 3:00am, so the wall-clock span from this day's local
    // midnight to the next is only 23 hours of real elapsed time. `d` is
    // anchored at local midnight itself so that span is exactly what this
    // test measures (any other time of day would understate the skip).
    withTz("America/New_York", () => {
      const d = new Date(2024, 2, 10, 0, 0, 0, 0);
      const naiveUtcMath = d.getTime() + 24 * 60 * 60 * 1000;
      const boundary = startOfNextLocalDay(d);
      const expectedLocalMidnight = new Date(2024, 2, 11, 0, 0, 0, 0).getTime();

      expect(boundary).toBe(expectedLocalMidnight);
      expect(boundary).not.toBe(naiveUtcMath); // proves it isn't UTC/ms arithmetic
      expect(boundary - d.getTime()).toBe(23 * 60 * 60 * 1000);
    });
  });

  it("DST fall-back: the returned boundary is real local midnight, not date.getTime() + 24h", () => {
    // 2024-11-03 is the US fall-back day in America/New_York — clocks
    // repeat 1:00am to 2:00am, so the wall-clock span from this day's local
    // midnight to the next is 25 hours of real elapsed time. Same
    // midnight-anchoring rationale as the spring-forward case above.
    withTz("America/New_York", () => {
      const d = new Date(2024, 10, 3, 0, 0, 0, 0);
      const naiveUtcMath = d.getTime() + 24 * 60 * 60 * 1000;
      const boundary = startOfNextLocalDay(d);
      const expectedLocalMidnight = new Date(2024, 10, 4, 0, 0, 0, 0).getTime();

      expect(boundary).toBe(expectedLocalMidnight);
      expect(boundary).not.toBe(naiveUtcMath); // proves it isn't UTC/ms arithmetic
      expect(boundary - d.getTime()).toBe(25 * 60 * 60 * 1000);
    });
  });

  it("invariant: the boundary is always strictly after the input instant, including right at local midnight and one ms before it", () => {
    const cases = [
      new Date(2026, 7, 5, 0, 0, 0, 0), // exactly local midnight
      new Date(2026, 7, 4, 23, 59, 59, 999), // one ms before local midnight
      new Date(2026, 1, 28, 12, 0, 0, 0), // non-leap Feb
      new Date(2028, 1, 29, 12, 0, 0, 0), // leap day
      new Date(2026, 11, 31, 23, 59, 59, 999),
    ];
    for (const d of cases) {
      expect(startOfNextLocalDay(d)).toBeGreaterThan(d.getTime());
    }
    withTz("America/New_York", () => {
      const dstCases = [
        new Date(2024, 2, 10, 0, 30, 0, 0), // just after local midnight on spring-forward day
        new Date(2024, 10, 3, 1, 30, 0, 0), // inside the repeated hour on fall-back day
      ];
      for (const d of dstCases) {
        expect(startOfNextLocalDay(d)).toBeGreaterThan(d.getTime());
      }
    });
  });
});
