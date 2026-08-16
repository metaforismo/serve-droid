import { describe, expect, it } from "vitest";
import { wheelDeltasToSwipe, wheelDeltaToPixels } from "../src/wheel.js";

describe("wheel input normalization", () => {
  it("normalizes pixel, line, and page deltas", () => {
    expect(wheelDeltaToPixels(12, 0, 800)).toBe(12);
    expect(wheelDeltaToPixels(2, 1, 800)).toBe(32);
    expect(wheelDeltaToPixels(-0.5, 2, 800)).toBe(-400);
    expect(wheelDeltaToPixels(Number.NaN, 0, 800)).toBe(0);
  });

  it("turns downward wheel motion into an upward finger swipe", () => {
    const swipe = wheelDeltasToSwipe({
      deltaX: 0,
      deltaY: 160,
      width: 400,
      height: 800,
      anchorX: 0.5,
      anchorY: 0.6,
    });
    if (!swipe) throw new Error("Expected a vertical swipe.");

    expect(swipe.x1).toBe(swipe.x2);
    expect(swipe.y2).toBeLessThan(swipe.y1);
    expect(swipe.durationMs).toBeGreaterThanOrEqual(90);
    expect(swipe.durationMs).toBeLessThanOrEqual(250);
  });

  it("locks small cross-axis trackpad noise", () => {
    const swipe = wheelDeltasToSwipe({
      deltaX: 4,
      deltaY: 120,
      width: 400,
      height: 800,
      anchorX: 0.45,
      anchorY: 0.55,
    });
    if (!swipe) throw new Error("Expected a vertical swipe.");

    expect(swipe.x1).toBe(swipe.x2);
    expect(swipe.y2).toBeLessThan(swipe.y1);
  });

  it("preserves bounded travel near an edge", () => {
    const swipe = wheelDeltasToSwipe({
      deltaX: 0,
      deltaY: -320,
      width: 400,
      height: 800,
      anchorX: 0.5,
      anchorY: 0.94,
    });
    if (!swipe) throw new Error("Expected a bounded swipe.");

    expect(swipe.y1).toBeGreaterThanOrEqual(0.06);
    expect(swipe.y2).toBeLessThanOrEqual(0.94);
    expect(swipe.y2 - swipe.y1).toBeGreaterThan(0.3);
  });

  it("ignores tiny or invalid wheel motion", () => {
    expect(
      wheelDeltasToSwipe({
        deltaX: 1,
        deltaY: 2,
        width: 400,
        height: 800,
        anchorX: 0.5,
        anchorY: 0.5,
      }),
    ).toBeNull();
    expect(
      wheelDeltasToSwipe({
        deltaX: 20,
        deltaY: 20,
        width: 0,
        height: 800,
        anchorX: 0.5,
        anchorY: 0.5,
      }),
    ).toBeNull();
  });
});
