import { describe, expect, test } from "vitest";
import { buildMessageBodyBlocks } from "./inline-widgets.ts";
import { connectorRequestFromToolPart } from "./connector-request-links.ts";

const ID = "165da53d-9cde-4ece-84ae-389fc0a42a47";

describe("connector request cards in the transcript", () => {
  test("a harness that forwards the result is found by the request id", () => {
    expect(
      connectorRequestFromToolPart({
        type: "toolCall",
        status: "completed",
        name: "mcp__pipper-agents__add_connector",
        outputPreview: `{\n  "request_id": "${ID}",\n  "status": "awaiting_user"`,
        args: { catalog: "posthog", reason: "x" },
      }),
    ).toEqual({ id: ID });
  });

  test("Antigravity, which keeps only the model's label, is found by thread and input", () => {
    // As recorded from a real Antigravity thread.
    const part = {
      type: "toolCall",
      status: "completed",
      name: "Running add_connector",
      outputPreview: "Connect PostHog",
      args: { catalog: "posthog", reason: "To access PostHog product analytics" },
    };
    expect(connectorRequestFromToolPart(part, "thread-1")).toEqual({
      threadId: "thread-1",
      input: { catalog: "posthog", url: undefined, command: undefined, args: undefined },
    });
    // Without the thread there's nothing to look it up in.
    expect(connectorRequestFromToolPart(part)).toBeNull();
    // Two calls for the same connector show one card.
    expect(buildMessageBodyBlocks([part, part], "thread-1")).toHaveLength(1);
  });

  test("other tools and unfinished calls show no card", () => {
    const base = { type: "toolCall", status: "completed", args: { catalog: "posthog" } };
    expect(connectorRequestFromToolPart({ ...base, name: "add_connectors" }, "t")).toBeNull();
    expect(
      connectorRequestFromToolPart({ ...base, name: "add_connector", status: "in_progress" }, "t"),
    ).toBeNull();
    expect(
      connectorRequestFromToolPart({ ...base, name: "add_connector", args: { reason: "x" } }, "t"),
    ).toBeNull();
  });
});
