// Carry-forward: every open, bucket='today' row whose day is before today
// gets bumped to today and its carried_count incremented. Pure of `bb` —
// takes the db handle and a clock directly so it can run from a cron
// schedule and lazily from getBoard/getArchive alike, and so tests can drive
// it deterministically.
//
// Idempotent by construction: once a row's day is bumped to today it no
// longer matches `day < today`, so re-running the same day is a no-op
// regardless of any external "did we already run today" bookkeeping.
import type Database from "better-sqlite3";
import { localDay } from "./day.js";

/** Runs carry-forward against `now`. Returns the number of rows updated. */
export function runRollover(db: Database.Database, now: Date): number {
  const today = localDay(now);
  const info = db
    .prepare(
      `UPDATE tasks
       SET day = ?, carried_count = carried_count + 1, updated_at = ?
       WHERE status = 'open' AND bucket = 'today' AND day IS NOT NULL AND day < ?`,
    )
    .run(today, now.getTime(), today);
  return info.changes;
}
