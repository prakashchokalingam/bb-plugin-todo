// Fractional ordering, pure. `prev`/`next` are the sort_order values of the
// existing siblings the new/moved row lands between.

/** Gap below which the caller must rebalance the sibling group. */
export const REBALANCE_GAP_THRESHOLD = 0.0001;

/**
 * Midpoint between `prev` and `next`. `prev + 1000` when `next` is null;
 * `next - 1000` when `prev` is null; `1000` when both are null.
 */
export function nextOrder(prev: number | null, next: number | null): number {
  if (prev === null && next === null) return 1000;
  if (prev === null) return (next as number) - 1000;
  if (next === null) return prev + 1000;
  return (prev + next) / 2;
}

/** True when inserting between `prev` and `next` would collapse the gap. */
export function needsRebalance(prev: number | null, next: number | null): boolean {
  if (prev === null || next === null) return false;
  return Math.abs(next - prev) < REBALANCE_GAP_THRESHOLD;
}

/** New sort_order values for a rebalanced sibling group, in order: 1000, 2000, … */
export function rebalancedOrders(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * 1000);
}
