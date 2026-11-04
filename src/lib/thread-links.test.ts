import { describe, expect, test } from "vitest";
import { buildMessageBodyBlocks } from "./inline-widgets.ts";
import { threadLinkFromToolPart, threadProposalFromToolPart } from "./thread-links.ts";

const ID = "2feaf268-d2eb-46e1-8516-3f3ba247f47c";

function toolPart(name: string, outputPreview: string, status = "completed") {
  return { type: "toolCall", id: "t1", name, status, outputPreview };
}

const CREATED = `{ "status": "started", "thread_id": "${ID}", "title": "Explore", "agent_id": "claude" }`;

describe("threadLinkFromToolPart", () => {
  test("reads the thread from a create_thread result, by any server prefix", () => {
    expect(threadLinkFromToolPart(toolPart("pipper-agents_create_thread", CREATED))).toEqual({
      threadId: ID,
    });
    expect(threadLinkFromToolPart(toolPart("mcp__pipper-agents__create_thread", CREATED))).toEqual({
      threadId: ID,
    });
  });

  test("a subthread gets no link in the conversation; the session panel lists it", () => {
    expect(
      threadLinkFromToolPart(
        toolPart(
          "mcp__pipper-agents__start_subthread",
          `{ "thread_id": "${ID}", "status": "starting" }`,
        ),
      ),
    ).toBeNull();
    const blocks = buildMessageBodyBlocks([
      { type: "text", text: "Handing this off." },
      toolPart("start_subthread", `{ "thread_id": "${ID}", "status": "starting" }`),
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(["text"]);
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

test("a proposed thread becomes one proposal card; only create_thread proposes", () => {
  const proposed = `{ "status": "proposed", "proposal_id": "${ID}", "title": "Fix billing" }`;
  expect(threadProposalFromToolPart(toolPart("pipper-agents_create_thread", proposed))).toBe(ID);
  expect(threadProposalFromToolPart(toolPart("start_subthread", proposed))).toBeNull();
  expect(threadProposalFromToolPart(toolPart("create_thread", CREATED))).toBeNull();

  const blocks = buildMessageBodyBlocks([
    toolPart("create_thread", proposed),
    toolPart("create_thread", `{ "status": "already_proposed", "proposal_id": "${ID}" }`),
  ]);
  expect(blocks).toEqual([{ kind: "proposal", proposalId: ID, key: `proposal:${ID}` }]);
});
