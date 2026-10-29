import { describe, expect, test } from "vitest";
import { clampToastText } from "@/components/ui/toast";

describe("clampToastText", () => {
  test("leaves short text alone and flattens whitespace", () => {
    expect(clampToastText("  Thread\n  finished  ", 80)).toBe("Thread finished");
  });

  test("cuts long text at the cap with an ellipsis", () => {
    const brief = "You were started as a task by another agent in Pipper ".repeat(4);
    const clamped = clampToastText(brief, 80);
    expect(clamped).toHaveLength(80);
    expect(clamped.endsWith("…")).toBe(true);
  });
});
