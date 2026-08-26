import { describe, expect, it } from "vitest";
import { needsRebalance, nextOrder, rebalancedOrders, REBALANCE_GAP_THRESHOLD } from "./order.js";

describe("nextOrder", () => {
  it("returns 1000 when both are null", () => {
    expect(nextOrder(null, null)).toBe(1000);
  });

  it("returns prev + 1000 when next is null", () => {
    expect(nextOrder(500, null)).toBe(1500);
  });

  it("returns next - 1000 when prev is null", () => {
    expect(nextOrder(null, 500)).toBe(-500);
  });

  it("returns the midpoint of prev and next", () => {
    expect(nextOrder(1000, 2000)).toBe(1500);
    expect(nextOrder(1000, 1000.0002)).toBeCloseTo(1000.0001, 10);
  });
});

describe("needsRebalance", () => {
  it("is false when either side is null (unbounded insert)", () => {
    expect(needsRebalance(null, 1000)).toBe(false);
    expect(needsRebalance(1000, null)).toBe(false);
    expect(needsRebalance(null, null)).toBe(false);
  });

  it("is false for a normal gap", () => {
    expect(needsRebalance(1000, 2000)).toBe(false);
  });

  it("is true once the gap collapses below the threshold", () => {
    expect(needsRebalance(1000, 1000 + REBALANCE_GAP_THRESHOLD / 2)).toBe(true);
    expect(needsRebalance(1000, 1000 + REBALANCE_GAP_THRESHOLD * 2)).toBe(false);
  });

  it("demonstrates the collapse after repeated midpoint inserts", () => {
    // Insert between the same two neighbors over and over; the gap halves
    // each time until it trips the threshold.
    let prev = 1000;
    let next = 1000 + 0.001;
    let iterations = 0;
    while (!needsRebalance(prev, next) && iterations < 100) {
      const mid = nextOrder(prev, next);
      next = mid;
      iterations++;
    }
    expect(needsRebalance(prev, next)).toBe(true);
    expect(iterations).toBeGreaterThan(0);
  });
});

describe("rebalancedOrders", () => {
  it("produces 1000, 2000, 3000, ...", () => {
    expect(rebalancedOrders(4)).toEqual([1000, 2000, 3000, 4000]);
  });

  it("is empty for zero items", () => {
    expect(rebalancedOrders(0)).toEqual([]);
  });
});
