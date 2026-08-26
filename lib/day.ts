// Server-LOCAL day math. Never derive a day string from `toISOString()` —
// that is UTC and drifts a day in the evening/morning depending on timezone.

/** Formats `date` as a server-local `YYYY-MM-DD` string. */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
