import { describe, expect, test } from "vitest";
import {
  reconcileDragOrder,
  releaseVelocity,
  reorderHeldTab,
  rubberBand,
  type TabSwapMemory,
} from "./tab-reorder";

const GAP = 4;

/** Drags `heldId` through `path` (lefts) and returns the order after each step. */
function drag(widths: Record<string, number>, heldId: string, path: number[]) {
  let order = Object.keys(widths);
  let memory: TabSwapMemory = new Map();
  return path.map((heldLeft) => {
    ({ order, memory } = reorderHeldTab({
      order,
      widths: new Map(Object.entries(widths)),
      gap: GAP,
      origin: 0,
      heldId,
      heldLeft,
      memory,
    }));
    return order.join("");
  });
}

describe("dragging a tab along the strip", () => {
  test("swaps once the held tab is 45% into its neighbour, not when it first touches it", () => {
    // B starts at 104; A's right edge reaches 45px into B at left 49.
    expect(drag({ A: 100, B: 100, C: 100 }, "A", [10, 44, 48, 49])).toEqual([
      "ABC",
      "ABC",
      "ABC",
      "BAC",
    ]);
  });

  test("works the same dragging left", () => {
    // A rests at 104; its left edge is 45px into B at 55.
    expect(drag({ B: 100, A: 100 }, "A", [90, 56, 55])).toEqual(["BA", "BA", "AB"]);
  });

  test("does not bounce straight back after a swap", () => {
    // Right after the swap A still covers 51% of B's new slot.
    const steps = drag({ A: 100, B: 100 }, "A", [49, 48, 45, 40, 39]);
    expect(steps).toEqual(["BA", "BA", "BA", "BA", "AB"]);
  });

  test("a hand wobbling on the swap point never flickers the order", () => {
    const wobble = [49, 47, 50, 46, 49, 44, 48, 45, 50];
    const steps = drag({ A: 100, B: 100 }, "A", wobble);
    expect(new Set(steps.slice(1))).toEqual(new Set(["BA"]));
  });

  test("swaps back and forth cleanly with deliberate moves", () => {
    expect(drag({ A: 100, B: 100 }, "A", [49, 39, 49, 39])).toEqual(["BA", "AB", "BA", "AB"]);
  });

  test("measures against the narrower tab, so a short tab can still pass a long one", () => {
    // 45% of B (200) is 90px, more than A (80) could ever overlap.
    // 45% of the narrower tab is 36px: A's right edge at 84 + 36.
    expect(drag({ A: 80, B: 200 }, "A", [39, 40])).toEqual(["AB", "BA"]);
    // And a long tab doesn't have to be dragged all the way across a short one.
    expect(drag({ A: 200, B: 80 }, "A", [39, 40])).toEqual(["AB", "BA"]);
  });

  test("a fast drag passes several tabs in one move", () => {
    // In one jump A covers B and C fully and 48% of D.
    expect(drag({ A: 100, B: 100, C: 100, D: 100 }, "A", [260])).toEqual(["BCDA"]);
  });

  test("dragging back across several tabs returns them in order", () => {
    const steps = drag({ A: 100, B: 100, C: 100 }, "A", [260, 0]);
    expect(steps).toEqual(["BCA", "ABC"]);
  });

  test("stops at the ends of the strip", () => {
    expect(drag({ A: 100, B: 100 }, "B", [900])).toEqual(["AB"]);
    expect(drag({ A: 100, B: 100 }, "A", [-900])).toEqual(["AB"]);
  });

  test("ignores a held tab it can't find, without touching the order", () => {
    expect(drag({ A: 100, B: 100 }, "Z", [500])).toEqual(["AB"]);
  });
});

describe("when tabs change during a drag", () => {
  test("a closed tab drops out and the drag keeps its order", () => {
    expect(reconcileDragOrder(["B", "A", "C"], ["A", "C"])).toEqual(["A", "C"]);
    expect(reconcileDragOrder(["C", "A", "B"], ["A", "B", "C"])).toEqual(["C", "A", "B"]);
  });

  test("a newly opened tab joins at the end", () => {
    expect(reconcileDragOrder(["B", "A"], ["A", "B", "D"])).toEqual(["B", "A", "D"]);
  });
});

describe("the strip's ends", () => {
  test("move freely inside the strip", () => {
    expect(rubberBand(50, 0, 100)).toBe(50);
  });

  test("push back past either end instead of stopping the tab dead", () => {
    expect(rubberBand(-50, 0, 100)).toBe(-10);
    expect(rubberBand(150, 0, 100)).toBe(110);
  });
});

describe("release velocity", () => {
  test("a flick carries its speed into the release", () => {
    const samples = [
      { x: 0, t: 0 },
      { x: 20, t: 16 },
      { x: 40, t: 32 },
    ];
    expect(releaseVelocity(samples, 40)).toBeCloseTo(1250);
  });

  test("a pointer that paused before lifting lands at rest", () => {
    const samples = [
      { x: 0, t: 0 },
      { x: 40, t: 32 },
    ];
    expect(releaseVelocity(samples, 200)).toBe(0);
  });

  test("only the most recent movement counts", () => {
    const samples = [
      { x: 0, t: 0 },
      { x: 500, t: 100 },
      { x: 500, t: 300 },
      { x: 510, t: 316 },
    ];
    // The burst 200ms ago is outside the window; only 10px over 16ms is left.
    expect(releaseVelocity(samples, 320)).toBeCloseTo(625);
  });

  test("no movement, no velocity", () => {
    expect(releaseVelocity([], 0)).toBe(0);
    expect(releaseVelocity([{ x: 5, t: 10 }], 12)).toBe(0);
  });
});
