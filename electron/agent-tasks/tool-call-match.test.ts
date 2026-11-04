import { describe, expect, test } from "vitest";
import type { AcpToolCallState } from "../../contracts/acp.ts";
import { pickCallingSession, sharesMcpServersPerDirectory } from "./tool-call-match.ts";

function call(
  toolCallId: string,
  title: string,
  extra: Partial<AcpToolCallState> = {},
): AcpToolCallState {
  return { toolCallId, title, status: "in_progress", ...extra };
}

const ARGS = { agent_id: "claude", title: "T", task: "x" };

describe("pickCallingSession", () => {
  test("picks the session with an open call to that tool", () => {
    const match = pickCallingSession(
      [
        { sessionId: "child", toolCalls: [call("c1", "bash")] },
        {
          sessionId: "parent",
          toolCalls: [call("p1", "pipper-agents_create_thread")],
        },
      ],
      "create_thread",
      ARGS,
      new Set(),
    );
    expect(match).toEqual({ sessionId: "parent", toolCallId: "p1" });
  });

  test("same arguments beat a bare name match", () => {
    const match = pickCallingSession(
      [
        {
          sessionId: "a",
          toolCalls: [call("a1", "pipper-agents_create_thread")],
        },
        {
          sessionId: "b",
          toolCalls: [
            call("b1", "pipper-agents_create_thread", {
              rawInput: { ...ARGS },
            }),
          ],
        },
      ],
      "create_thread",
      ARGS,
      new Set(),
    );
    expect(match?.sessionId).toBe("b");
  });

  test("a tie, a finished call or an already matched call gives no answer", () => {
    const tied = [
      { sessionId: "a", toolCalls: [call("a1", "pipper-agents_list_threads")] },
      { sessionId: "b", toolCalls: [call("b1", "pipper-agents_list_threads")] },
    ];
    expect(pickCallingSession(tied, "list_threads", {}, new Set())).toBeNull();
    expect(pickCallingSession(tied, "list_threads", {}, new Set(["a:a1"]))?.sessionId).toBe("b");
    const done = [
      {
        sessionId: "a",
        toolCalls: [call("a1", "pipper-agents_list_threads", { status: "completed" })],
      },
    ];
    expect(pickCallingSession(done, "list_threads", {}, new Set())).toBeNull();
  });

  test("a tool name inside a longer one doesn't match", () => {
    const match = pickCallingSession(
      [
        {
          sessionId: "a",
          toolCalls: [call("a1", "pipper-agents_list_threadsx")],
        },
      ],
      "list_threads",
      {},
      new Set(),
    );
    expect(match).toBeNull();
  });
});

test("only OpenCode keeps MCP servers per directory", () => {
  expect(sharesMcpServersPerDirectory("opencode-acp")).toBe(true);
  expect(sharesMcpServersPerDirectory("claude-agent-acp")).toBe(false);
});
