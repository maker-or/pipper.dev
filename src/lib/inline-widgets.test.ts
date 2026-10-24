import { describe, expect, test } from "vitest";
import { buildMessageBodyBlocks, widgetIdFromToolPart } from "./inline-widgets.ts";

const ID = `wdg_${"a".repeat(32)}`;
const OTHER = `wdg_${"b".repeat(32)}`;

function shown(id: string, title = "mcp__pipper-browser__show_widget") {
  return {
    type: "toolCall",
    id: `call-${id}`,
    name: title,
    outputPreview: `pipper-widget:${id} The widget is now visible in the thread.`,
  };
}

describe("inline widgets in the timeline", () => {
  test("a show_widget call is found by its result, whatever the agent titles it", () => {
    expect(widgetIdFromToolPart(shown(ID))).toBe(ID);
    expect(widgetIdFromToolPart(shown(ID, "Show widget"))).toBe(ID);
  });

  test("updates, unfinished calls and other tools are not widgets", () => {
    expect(
      widgetIdFromToolPart({ type: "toolCall", outputPreview: `pipper-widget-updated:${ID}` }),
    ).toBeNull();
    expect(widgetIdFromToolPart({ type: "toolCall", name: "show_widget" })).toBeNull();
    expect(widgetIdFromToolPart({ type: "toolCall", outputPreview: "Read 3 files" })).toBeNull();
    expect(
      widgetIdFromToolPart({ type: "toolCall", outputPreview: `see pipper-widget:${ID}` }),
    ).toBeNull();
  });

  test("widgets sit between the text they were shown between", () => {
    const blocks = buildMessageBodyBlocks([
      { type: "text", text: "Here's the breakdown." },
      { type: "toolCall", outputPreview: "Read package.json" },
      shown(ID),
      { type: "text", text: "Two things stand out." },
      { type: "text", text: "First, latency." },
      shown(OTHER),
      shown(ID),
    ]);
    expect(blocks).toEqual([
      { kind: "text", text: "Here's the breakdown." },
      { kind: "widget", widgetId: ID },
      { kind: "text", text: "Two things stand out.\n\nFirst, latency." },
      { kind: "widget", widgetId: OTHER },
    ]);
  });
});
