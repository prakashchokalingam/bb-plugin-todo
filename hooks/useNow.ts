import { useEffect, useState } from "react";

/**
 * Returns the current time (`Date.now()`), re-rendering the caller on a
 * single shared interval of `tickMs`. Restarts the interval whenever
 * `tickMs` changes, and cleans up on unmount.
 *
 * Callers that render many due chips should compute the minimum `tickMs`
 * across all visible chips and call this hook ONCE at the page level, then
 * pass the resulting `now` down as a prop — this hook does not dedupe
 * intervals across multiple call sites.
 */
export function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  return now;
}

export default useNow;
