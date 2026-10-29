import { describe, expect, test } from "vitest";
import { buildMessageBodyBlocks } from "./inline-widgets.ts";
import { threadLinkFromToolPart } from "./thread-links.ts";

const ID = "2feaf268-d2eb-46e1-8516-3f3ba247f47c";

function toolPart(name: string, outputPreview: string, status = "completed") {
  return { type: "toolCall", id: "t1", name, status, outputPreview };
}

const CREATED = `{ "status": "started", "thread_id": "${ID}", "title": "Explore", "agent_id": "claude" }`;

describe("threadLinkFromToolPart", () => {
  test("reads the thread from a create_thread or start_subthread result, by any server prefix", () => {
    expect(threadLinkFromToolPart(toolPart("pipper-agents_create_thread", CREATED))).toEqual({
      threadId: ID,
      kind: "thread",
    });
    expect(
      threadLinkFromToolPart(
        toolPart(
          "mcp__pipper-agents__start_subthread",
          `{ "thread_id": "${ID}", "status": "starting" }`,
        ),
      ),
    ).toEqual({ threadId: ID, kind: "subthread" });
  });

  test("ignores failed or running calls, other tools and results without a thread", () => {
    expect(threadLinkFromToolPart(toolPart("create_thread", CREATED, "failed"))).toBeNull();
    expect(threadLinkFromToolPart(toolPart("create_thread", CREATED, "in_progress"))).toBeNull();
    expect(threadLinkFromToolPart(toolPart("get_thread", CREATED))).toBeNull();
    expect(threadLinkFromToolPart(toolPart("create_thread", "MCP error -32000"))).toBeNull();
  });
});

test("the turn's body links each started thread once, where the agent started it", () => {
  const blocks = buildMessageBodyBlocks([
    { type: "text", text: "Starting it." },
    toolPart("pipper-agents_create_thread", CREATED),
    // A retry returned the same thread.
    toolPart(
      "pipper-agents_create_thread",
      `{ "status": "already_started", "thread_id": "${ID}" }`,
    ),
    { type: "text", text: "It's running." },
  ]);
  expect(blocks.map((block) => block.kind)).toEqual(["text", "thread", "text"]);
});
