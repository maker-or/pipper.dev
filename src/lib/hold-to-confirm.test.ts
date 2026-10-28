import { describe, expect, test } from "vitest";
import { HoldController, displayedFill } from "./hold-to-confirm";

function hold(durationMs = 800) {
  let now = 0;
  const progress: number[] = [];
  let completions = 0;
  const controller = new HoldController({
    durationMs,
    now: () => now,
    onProgress: (value) => progress.push(value),
    onComplete: () => {
      completions += 1;
    },
  });
  return {
    controller,
    progress,
    completions: () => completions,
    advance: (ms: number) => {
      now += ms;
      controller.tick();
    },
  };
}

describe("HoldController", () => {
  test("confirms once, after the full hold", () => {
    const h = hold();
    h.controller.start();
    h.advance(400);
    expect(h.progress.at(-1)).toBe(0.5);
    expect(h.completions()).toBe(0);
    h.advance(400);
    expect(h.completions()).toBe(1);
    h.advance(400);
    h.controller.start();
    expect(h.completions()).toBe(1);
    expect(h.controller.completed).toBe(true);
  });

  test("letting go early resets, and the next hold starts from zero", () => {
    const h = hold();
    h.controller.start();
    h.advance(700);
    h.controller.release();
    expect(h.progress.at(-1)).toBe(0);
    h.controller.start();
    h.advance(700);
    expect(h.completions()).toBe(0);
    h.advance(100);
    expect(h.completions()).toBe(1);
  });

  test("a repeated start while held (key repeat) doesn't restart the clock", () => {
    const h = hold();
    h.controller.start();
    h.advance(500);
    h.controller.start();
    h.advance(300);
    expect(h.completions()).toBe(1);
  });
});

test("reduced motion steps the fill instead of animating it", () => {
  expect(displayedFill(0.6, false)).toBe(0.6);
  expect(displayedFill(0.6, true)).toBe(0.5);
  expect(displayedFill(0.2, true)).toBe(0);
  expect(displayedFill(1, true)).toBe(1);
});
