import { afterEach, describe, expect, test, vi } from "vitest";
import type { AcpBridgeEvent, AcpSessionState } from "../../contracts/acp.ts";
import type { Thread } from "../../contracts/threads.ts";

function sessionState(threadId: string): AcpSessionState {
  return {
    projectId: "project-1",
    threadId,
    agentId: "pipper-mock",
    agentSessionId: `session-${threadId}`,
    cwd: "/tmp/project",
    title: null,
    configOptions: [],
    commands: [],
    entries: [],
    toolCalls: {},
    plan: null,
    usage: null,
    currentModeId: null,
    isStreaming: false,
    isCompacting: false,
    editorText: "",
    authRequiredMessage: null,
    switchingAgent: false,
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});

describe("threads deleted in main", () => {
  test("switching to a thread that no longer exists forgets it", async () => {
    (globalThis as any).window = {
      omni: {
        agent: {
          onEvent: vi.fn(() => vi.fn()),
          getState: vi.fn(async () => sessionState("thread-a")),
          getCapabilities: vi.fn(async () => ({ promptCapabilities: {} })),
          getRunningThreads: vi.fn(async () => []),
          switchThread: vi.fn(async () => {
            throw new Error(
              "Error invoking remote method 'agent:switchThread': Error: Thread not found: thread-gone",
            );
          }),
        },
      },
    };
    vi.resetModules();
    const { useAgentStore } = await import("./agent-store.ts");
    const { useThreadStore } = await import("./thread-store.ts");
    useThreadStore.setState({
      threads: [
        { id: "thread-a", project_id: "project-1" } as Thread,
        { id: "thread-gone", project_id: "project-1" } as Thread,
      ],
    });
    await useAgentStore.getState().connect();

    await expect(useAgentStore.getState().switchThread("thread-gone")).rejects.toThrow();

    expect(useThreadStore.getState().threads.map((thread) => thread.id)).toEqual(["thread-a"]);
    expect(useAgentStore.getState().error).toBe("That thread was deleted.");
  });

  test("leave the thread list without a reload; a closed session alone keeps them", async () => {
    let bridge: ((payload: AcpBridgeEvent) => void) | null = null;
    (globalThis as any).window = {
      omni: {
        agent: {
          onEvent: vi.fn((handler: (payload: AcpBridgeEvent) => void) => {
            bridge = handler;
            return vi.fn();
          }),
          getState: vi.fn(async () => sessionState("thread-a")),
          getCapabilities: vi.fn(async () => ({ promptCapabilities: {} })),
          getRunningThreads: vi.fn(async () => []),
        },
      },
    };
    vi.resetModules();
    const { useAgentStore } = await import("./agent-store.ts");
    const { useThreadStore } = await import("./thread-store.ts");
    useThreadStore.setState({
      threads: [
        { id: "thread-a", project_id: "project-1" } as Thread,
        { id: "thread-b", project_id: "project-1" } as Thread,
        { id: "thread-c", project_id: "project-1" } as Thread,
      ],
    });
    await useAgentStore.getState().connect();

    bridge!({ type: "thread-closed", threadId: "thread-b" });
    bridge!({ type: "thread-closed", threadId: "thread-c" });
    bridge!({ type: "thread-deleted", threadId: "thread-c" });

    expect(useThreadStore.getState().threads.map((thread) => thread.id)).toEqual([
      "thread-a",
      "thread-b",
    ]);

    // A thread moved to another workspace: its row is replaced in place.
    bridge!({
      type: "thread-updated",
      thread: { id: "thread-b", project_id: "project-1", worktree_path: "/wt/b" } as Thread,
    });
    expect(useThreadStore.getState().threads.map((thread) => thread.worktree_path ?? null)).toEqual(
      [null, "/wt/b"],
    );
  });
});
