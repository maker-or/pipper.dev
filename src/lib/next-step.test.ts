import { describe, expect, test } from "vitest";
import { parseNextStep } from "../../contracts/next-step.ts";
import { nextStepFromParts } from "./next-step";

const wrapUp = (args: unknown, overrides: Record<string, unknown> = {}) => ({
  type: "toolCall",
  name: "mcp__pipper-agents__wrap_up",
  status: "completed",
  args,
  ...overrides,
});

describe("parseNextStep", () => {
  test("trims fields and defaults a button's message to its label", () => {
    expect(
      parseNextStep({
        recap: "  Done.  ",
        ask: " Commit? ",
        actions: [{ label: "Commit" }, { label: "Not yet", message: "Leave it uncommitted." }],
      }),
    ).toEqual({
      ok: true,
      value: {
        recap: "Done.",
        ask: "Commit?",
        actions: [
          { label: "Commit", message: "Commit" },
          { label: "Not yet", message: "Leave it uncommitted." },
        ],
        blocked: false,
      },
    });
  });

  test.each([
    [{}, "recap is required"],
    [{ recap: "x", blocked: true }, "blocked needs an ask"],
    [{ recap: "x", actions: [{ label: "Go" }] }, "add the ask"],
    [
      { recap: "x", ask: "?", actions: [{ label: "a" }, { label: "b" }, { label: "c" }] },
      "at most 2",
    ],
    [{ recap: "x".repeat(601) }, "at most 600"],
  ])("rejects %j", (input, error) => {
    const parsed = parseNextStep(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(error);
  });
});

describe("nextStepFromParts", () => {
  test("uses the turn's last completed wrap_up, however the adapter names it", () => {
    const step = nextStepFromParts([
      wrapUp({ recap: "First." }),
      { type: "text", text: "Closing message." },
      wrapUp({ arguments: { recap: "Second." } }, { name: "Running wrap_up" }),
    ]);
    expect(step?.recap).toBe("Second.");
  });

  test("ignores calls that failed, are still running or have bad input", () => {
    expect(
      nextStepFromParts([
        wrapUp({ recap: "Rejected.", blocked: true }),
        wrapUp({ recap: "Running." }, { status: "in_progress" }),
        wrapUp({ recap: "Failed." }, { status: "failed" }),
        wrapUp({ recap: "Other tool." }, { name: "maybe_wrap_up_later" }),
      ]),
    ).toBeNull();
  });
});
