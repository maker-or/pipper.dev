import { describe, expect, test } from "vitest";
import { buildMessageBodyBlocks, widgetRefFromToolPart, widgetRefKey } from "./inline-widgets.ts";

const ID = `wdg_${"a".repeat(32)}`;
const OTHER = `wdg_${"b".repeat(32)}`;

function forwarded(id: string, name = "mcp__pipper-browser__show_widget") {
  return {
    type: "toolCall",
    name,
    status: "completed",
    args: { title: "x", widget_code: "<p>x</p>", summary: "x" },
    outputPreview: `pipper-widget:${id} The widget is now visible in the thread.`,
  };
}

/** Shape recorded from Gemini via the Antigravity adapter: no MCP result, nested input. */
function geminiCall(code: string, status = "completed") {
  return {
    type: "toolCall",
    name: "pipper-browser_show_widget",
    status,
    outputPreview: "Display inline visual report",
    hasPayload: true,
    args: {
      arguments: { summary: "Dashboard.", title: "landing_page_skill_analysis", widget_code: code },
    },
  };
}

describe("inline widgets in the timeline", () => {
  test("a forwarded show_widget result is found by its marker, whatever the agent titles it", () => {
    expect(widgetRefFromToolPart(forwarded(ID), "t1")).toEqual({ id: ID });
    expect(widgetRefFromToolPart(forwarded(ID, "Show widget"), "t1")).toEqual({ id: ID });
  });

  test("agents that drop MCP results are matched by the call's input", () => {
    expect(widgetRefFromToolPart(geminiCall("<div>report</div>"), "thread-1")).toEqual({
      threadId: "thread-1",
      title: "landing_page_skill_analysis",
      code: "<div>report</div>",
    });
    const flat = {
      type: "toolCall",
      name: "Running show_widget",
      status: "completed",
      args: { title: "chart", widget_code: "<svg></svg>", summary: "s" },
    };
    expect(widgetRefFromToolPart(flat, null)).toEqual({
      threadId: null,
      title: "chart",
      code: "<svg></svg>",
    });
  });

  test("unfinished, failed, preview and update calls are not shown", () => {
    expect(widgetRefFromToolPart(geminiCall("<p>x</p>", "in_progress"), "t")).toBeNull();
    expect(widgetRefFromToolPart(geminiCall("<p>x</p>", "failed"), "t")).toBeNull();
    const preview = { ...geminiCall("<p>x</p>"), name: "pipper-browser_preview_widget" };
    expect(widgetRefFromToolPart(preview, "t")).toBeNull();
    expect(
      widgetRefFromToolPart(
        { type: "toolCall", status: "completed", outputPreview: `pipper-widget-updated:${ID}` },
        "t",
      ),
    ).toBeNull();
    expect(
      widgetRefFromToolPart(
        { type: "toolCall", status: "completed", outputPreview: `see pipper-widget:${ID}` },
        "t",
      ),
    ).toBeNull();
  });

  test("widgets sit between the text they were shown between", () => {
    const blocks = buildMessageBodyBlocks(
      [
        { type: "text", text: "Here's the breakdown." },
        { type: "toolCall", status: "completed", outputPreview: "Read package.json" },
        forwarded(ID),
        { type: "text", text: "Two things stand out." },
        { type: "text", text: "First, latency." },
        geminiCall("<p>chart</p>"),
        forwarded(OTHER),
        forwarded(ID),
        geminiCall("<p>chart</p>"),
      ],
      "thread-1",
    );
    expect(blocks.map((block) => (block.kind === "text" ? block.text : block.key))).toEqual([
      "Here's the breakdown.",
      ID,
      "Two things stand out.\n\nFirst, latency.",
      widgetRefKey({
        threadId: "thread-1",
        title: "landing_page_skill_analysis",
        code: "<p>chart</p>",
      }),
      OTHER,
    ]);
  });
});

describe("widget prompts", () => {
  test("need a user interaction, and one interaction sends one prompt", async () => {
    const { createWidgetPromptGate } = await import("./inline-widgets");
    let now = 0;
    const allow = createWidgetPromptGate(() => now, 1000);
    // A widget posting on load, with nobody touching it.
    expect(allow(false)).toBe(false);
    expect(allow(true)).toBe(true);
    // The same click can't be reused for a burst.
    now += 200;
    expect(allow(true)).toBe(false);
    now += 1000;
    expect(allow(true)).toBe(true);
  });
});
