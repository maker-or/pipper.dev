import { afterEach, describe, expect, test, vi } from "vitest";
import type { AcpBridgeEvent, AcpSessionState } from "../../contracts/acp.ts";
import { resetToolPayloadStore } from "./tool-payload-store";

function sessionState(
  threadId: string | null,
  patch: Partial<AcpSessionState> = {},
): AcpSessionState {
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
    ...patch,
  };
}

async function loadStore() {
  vi.resetModules();
  const mod = await import("./agent-store.ts");
  mod.useAgentStore.setState({
    state: null,
    snapshot: null,
    uiRequest: null,
    permissionRequest: null,
    isConnecting: false,
    error: null,
  });
  return mod.useAgentStore;
}

async function controlledThreadSwitches() {
  let bridgeHandler: (payload: AcpBridgeEvent) => void = () => {};
  let currentState = sessionState("thread-a");
  const gates = new Map<string, () => void>();
  const failures = new Map<string, (error: Error) => void>();
  const agentApi = {
    onEvent: vi.fn((handler: (payload: AcpBridgeEvent) => void) => {
      bridgeHandler = handler;
      return vi.fn();
    }),
    getState: vi.fn(async () => currentState),
    getCapabilities: vi.fn(async () => null),
    switchThread: vi.fn(
      (id: string) =>
        new Promise<void>((resolve, reject) => {
          gates.set(id, resolve);
          failures.set(id, reject);
        }),
    ),
  };
  (globalThis as any).window = { omni: { agent: agentApi } };
  const store = await loadStore();
  await store.getState().connect();
  return {
    store,
    agentApi,
    publish: (id: string) => {
      currentState = sessionState(id);
      bridgeHandler({ type: "session-state", state: currentState });
    },
    resolve: (id: string) => gates.get(id)?.(),
    reject: (id: string, error: Error) => failures.get(id)?.(error),
  };
}

afterEach(() => {
  resetToolPayloadStore();
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});

describe("agent store ACP bridge behavior", () => {
  test("an older switch completion cannot clear the next requested target", async () => {
    const { store, agentApi, publish, resolve } = await controlledThreadSwitches();
    const switchingB = store.getState().switchThread("thread-b");
    await vi.waitFor(() => expect(agentApi.switchThread).toHaveBeenCalledWith("thread-b"));
    publish("thread-b");

    // The snapshot paints before IPC resolves. A click during that gap must
    // remain pending when B's persistence finishes.
    const switchingC = store.getState().switchThread("thread-c");
    resolve("thread-b");
    await switchingB;
    await vi.waitFor(() => expect(agentApi.switchThread).toHaveBeenCalledWith("thread-c"));
    try {
      expect(store.getState().pendingThreadTarget).toBe("thread-c");
      publish("thread-b");
      expect(store.getState().pendingThreadTarget).toBe("thread-c");
      publish("thread-c");
      expect(store.getState().snapshot?.threadId).toBe("thread-c");
      expect(store.getState().pendingThreadTarget).toBeNull();
    } finally {
      resolve("thread-c");
      await switchingC;
    }
  });

  test("a slow switch does not hold back a newer click", async () => {
    const { store, agentApi, publish, resolve, reject } = await controlledThreadSwitches();
    const switchingB = store.getState().switchThread("thread-b");
    await vi.waitFor(() => expect(agentApi.switchThread).toHaveBeenCalledWith("thread-b"));

    // B is still loading. The click on C must reach main right away so main
    // can supersede B, instead of waiting for B to finish.
    const switchingC = store.getState().switchThread("thread-c");
    await vi.waitFor(() => expect(agentApi.switchThread).toHaveBeenCalledWith("thread-c"));
    publish("thread-c");
    resolve("thread-c");
    await switchingC;
    expect(store.getState().snapshot?.threadId).toBe("thread-c");

    // Main rejects the superseded call; that is not an error for the user.
    reject("thread-b", new Error("superseded by a newer activation"));
    await expect(switchingB).resolves.toBeUndefined();
    expect(store.getState().error).toBeNull();
    expect(store.getState().pendingThreadTarget).toBeNull();
  });

  test("clicking the displayed thread cancels a pending switch to another thread", async () => {
    const { store, agentApi, publish, resolve } = await controlledThreadSwitches();
    const { selectThread } = await import("../lib/thread-actions");
    const { useWorkspaceViewStore } = await import("./workspace-view-store");
    const switchingB = selectThread("thread-b");
    await vi.waitFor(() => expect(agentApi.switchThread).toHaveBeenCalledWith("thread-b"));
    const switchingA = selectThread("thread-a");
    try {
      expect(useWorkspaceViewStore.getState().requestedThreadId).toBe("thread-a");
      expect(store.getState().pendingThreadTarget).toBe("thread-a");
      publish("thread-b");
      expect(store.getState().snapshot?.threadId).toBe("thread-a");
    } finally {
      resolve("thread-b");
      await switchingB;
      // Even though A is still displayed, the main process must be asked to
      // switch back to it so it supersedes the in-flight activation of B.
      await vi.waitFor(() => expect(agentApi.switchThread).toHaveBeenCalledWith("thread-a"));
      publish("thread-a");
      resolve("thread-a");
      await switchingA;
    }
    expect(store.getState().snapshot?.threadId).toBe("thread-a");
  });

  test("forwards a selected workspace when creating a thread", async () => {
    const createThread = vi.fn(async () => ({ id: "thread-worktree" }));
    const agentApi = {
      createThread,
      getState: vi.fn(async () => sessionState("thread-worktree")),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store
      .getState()
      .createThread("project-1", "Workspace thread", "after-thread", "agent-1", "/tmp/worktree");

    expect(createThread).toHaveBeenCalledWith(
      "project-1",
      "Workspace thread",
      "after-thread",
      "agent-1",
      "/tmp/worktree",
      null,
    );
  });

  test("keeps permission UI responsive while a thread switch is pending", async () => {
    let bridgeHandler: ((payload: AcpBridgeEvent) => void) | null = null;
    let currentState = sessionState("thread-a");
    let resolveSwitch: (() => void) | null = null;
    const switchGate = new Promise<void>((resolve) => {
      resolveSwitch = resolve;
    });
    const agentApi = {
      onEvent: vi.fn((handler: (payload: AcpBridgeEvent) => void) => {
        bridgeHandler = handler;
        return vi.fn();
      }),
      getState: vi.fn(async () => currentState),
      getCapabilities: vi.fn(async () => ({
        promptCapabilities: { image: true, embeddedContext: true },
      })),
      switchThread: vi.fn(async () => switchGate),
      respondToPermission: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {}),
      replacePrompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      createThread: vi.fn(),
      setConfigOption: vi.fn(),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
      reportEditorText: vi.fn(),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store.getState().connect();

    const switching = store.getState().switchThread("thread-b");
    await vi.waitFor(() => expect(agentApi.switchThread).toHaveBeenCalledWith("thread-b"));

    // Background session updates for the old thread remain isolated during a
    // pending switch.
    bridgeHandler?.({
      type: "session-update",
      sessionId: "session-thread-a",
      threadId: "thread-a",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "stale",
        content: { type: "text", text: "noise" },
      },
    });
    expect(
      store.getState().state?.entries.some((e) => e.type === "agent_text" && e.text === "noise"),
    ).toBeFalsy();

    bridgeHandler?.({
      type: "permission-request",
      request: {
        sessionId: "session-thread-a",
        toolCall: { toolCallId: "t1", title: "Edit file" },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    expect(store.getState().uiRequest?.sessionId).toBe("session-thread-a");
    expect(store.getState().permissionRequest?.sessionId).toBe("session-thread-a");

    bridgeHandler?.({ type: "permission-resolved", sessionId: "session-thread-a" });
    expect(store.getState().uiRequest).toBeNull();

    currentState = sessionState("thread-b", {
      entries: [{ type: "user_text", id: "m1", messageId: null, text: "hi" }],
    });
    resolveSwitch?.();
    await switching;

    expect(store.getState().state?.threadId).toBe("thread-b");
    expect(store.getState().snapshot?.threadId).toBe("thread-b");
    expect(store.getState().error).toBeNull();
  });

  test("ignores stale session-state while waiting for a requested thread", async () => {
    let bridgeHandler: ((payload: AcpBridgeEvent) => void) | null = null;
    let currentState = sessionState("thread-a");
    let resolveSwitch: (() => void) | null = null;
    const switchGate = new Promise<void>((resolve) => {
      resolveSwitch = resolve;
    });
    const agentApi = {
      onEvent: vi.fn((handler: (payload: AcpBridgeEvent) => void) => {
        bridgeHandler = handler;
        return vi.fn();
      }),
      getState: vi.fn(async () => currentState),
      getCapabilities: vi.fn(async () => null),
      switchThread: vi.fn(async () => switchGate),
      respondToPermission: vi.fn(),
      sendPrompt: vi.fn(),
      replacePrompt: vi.fn(),
      abort: vi.fn(),
      createThread: vi.fn(),
      setConfigOption: vi.fn(),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
      reportEditorText: vi.fn(),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store.getState().connect();

    const switching = store.getState().switchThread("thread-b");
    await vi.waitFor(() => expect(agentApi.switchThread).toHaveBeenCalledWith("thread-b"));

    bridgeHandler?.({
      type: "session-state",
      state: sessionState("thread-a", { title: "stale" }),
    });
    expect(store.getState().state?.threadId).toBe("thread-a");
    expect(store.getState().state?.title).toBeNull();

    // Replay chunks from the target must not be merged into thread A's state
    // before the target's complete session-state arrives.
    bridgeHandler?.({
      type: "session-update",
      sessionId: "session-thread-b",
      threadId: "thread-b",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "replay",
        content: { type: "text", text: "partial target replay" },
      },
    });
    expect(store.getState().state?.threadId).toBe("thread-a");
    expect(
      store.getState().state?.entries.some((entry) => entry.text === "partial target replay"),
    ).toBe(false);

    bridgeHandler?.({
      type: "session-state",
      state: sessionState("thread-b", { title: "fresh" }),
    });
    expect(store.getState().state?.threadId).toBe("thread-b");
    expect(store.getState().state?.title).toBe("fresh");

    currentState = sessionState("thread-b", { title: "fresh" });
    resolveSwitch?.();
    await switching;
  });

  test("follows a main-initiated activation into another thread", async () => {
    let bridgeHandler: ((payload: AcpBridgeEvent) => void) | null = null;
    const agentApi = {
      onEvent: vi.fn((handler: (payload: AcpBridgeEvent) => void) => {
        bridgeHandler = handler;
        return vi.fn();
      }),
      getState: vi.fn(async () => sessionState("thread-a")),
      getCapabilities: vi.fn(async () => null),
      switchThread: vi.fn(),
      respondToPermission: vi.fn(),
      sendPrompt: vi.fn(),
      replacePrompt: vi.fn(),
      abort: vi.fn(),
      createThread: vi.fn(),
      setConfigOption: vi.fn(),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
      reportEditorText: vi.fn(),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store.getState().connect();
    expect(store.getState().state?.threadId).toBe("thread-a");

    // No renderer switch is pending, so this arrives from the main process:
    // a workspace switch, a delete replacement, or a launch restore. The main
    // process only emits session-state for the thread it made active, so the
    // view must follow it rather than treat it as background noise.
    bridgeHandler?.({
      type: "session-state",
      state: sessionState("thread-b", {
        cwd: "/tmp/worktree",
        entries: [{ type: "user_text", id: "m1", messageId: null, text: "hi" }],
      }),
    });

    expect(store.getState().state?.threadId).toBe("thread-b");
    expect(store.getState().state?.cwd).toBe("/tmp/worktree");
    expect(store.getState().snapshot?.threadId).toBe("thread-b");
    expect(
      store.getState().state?.entries.some((e) => e.type === "user_text" && e.text === "hi"),
    ).toBe(true);
  });

  test("clears the displayed session when the main process closes the last tab", async () => {
    let bridgeHandler: ((payload: AcpBridgeEvent) => void) | null = null;
    const agentApi = {
      onEvent: vi.fn((handler: (payload: AcpBridgeEvent) => void) => {
        bridgeHandler = handler;
        return vi.fn();
      }),
      getState: vi.fn(async () => sessionState("thread-a")),
      getCapabilities: vi.fn(async () => null),
      switchThread: vi.fn(),
      respondToPermission: vi.fn(),
      sendPrompt: vi.fn(),
      replacePrompt: vi.fn(),
      abort: vi.fn(),
      createThread: vi.fn(),
      setConfigOption: vi.fn(),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
      reportEditorText: vi.fn(),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store.getState().connect();
    expect(store.getState().snapshot?.threadId).toBe("thread-a");

    bridgeHandler?.({
      type: "thread-tool-calls",
      threadId: "thread-a",
      toolCalls: { t1: { toolCallId: "t1", title: "Edit", status: "completed" } },
    });

    bridgeHandler?.({ type: "session-state", state: sessionState(null) });

    expect(store.getState().state?.threadId).toBeNull();
    expect(store.getState().snapshot?.threadId).toBeNull();
    expect(store.getState().threadToolCalls).toEqual({
      "thread-a": { t1: { toolCallId: "t1", title: "Edit", status: "completed" } },
    });
  });

  test("thread-tool-calls deltas merge without discarding earlier lean records", async () => {
    let bridgeHandler: ((payload: AcpBridgeEvent) => void) | null = null;
    const agentApi = {
      onEvent: vi.fn((handler: (payload: AcpBridgeEvent) => void) => {
        bridgeHandler = handler;
        return vi.fn();
      }),
      getState: vi.fn(async () => sessionState("thread-a")),
      getCapabilities: vi.fn(async () => null),
      switchThread: vi.fn(),
      respondToPermission: vi.fn(),
      sendPrompt: vi.fn(),
      replacePrompt: vi.fn(),
      abort: vi.fn(),
      createThread: vi.fn(),
      setConfigOption: vi.fn(),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
      reportEditorText: vi.fn(),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store.getState().connect();
    bridgeHandler?.({
      type: "thread-tool-calls",
      threadId: "thread-a",
      toolCalls: { t1: { toolCallId: "t1", title: "Edit", status: "completed" } },
    });
    bridgeHandler?.({
      type: "thread-tool-calls",
      threadId: "thread-a",
      toolCalls: { t2: { toolCallId: "t2", title: "Test", status: "completed" } },
      replace: false,
    });

    expect(Object.keys(store.getState().threadToolCalls["thread-a"] ?? {})).toEqual(["t1", "t2"]);
    expect(Object.keys(store.getState().state?.toolCalls ?? {})).toEqual(["t1", "t2"]);
  });

  test("session-state alone fills threadToolCalls for the active thread", async () => {
    let bridgeHandler: ((payload: AcpBridgeEvent) => void) | null = null;
    const agentApi = {
      onEvent: vi.fn((handler: (payload: AcpBridgeEvent) => void) => {
        bridgeHandler = handler;
        return vi.fn();
      }),
      getState: vi.fn(async () => sessionState(null)),
      getCapabilities: vi.fn(async () => null),
      switchThread: vi.fn(),
      respondToPermission: vi.fn(),
      sendPrompt: vi.fn(),
      replacePrompt: vi.fn(),
      abort: vi.fn(),
      createThread: vi.fn(),
      setConfigOption: vi.fn(),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
      reportEditorText: vi.fn(),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store.getState().connect();

    bridgeHandler?.({
      type: "session-state",
      state: sessionState("thread-b", {
        toolCalls: {
          t2: { toolCallId: "t2", title: "Read", status: "completed", hasPayload: true },
        },
      }),
    });

    expect(store.getState().state?.threadId).toBe("thread-b");
    expect(store.getState().threadToolCalls["thread-b"]?.t2?.title).toBe("Read");
    expect(store.getState().slice.toolCalls.t2?.content).toBeUndefined();
  });

  test("hydrates only explicitly requested tool calls into the active view", async () => {
    const getToolCalls = vi.fn(async (_threadId: string, _ids?: string[]) => ({
      t1: {
        toolCallId: "t1",
        title: "Read",
        status: "completed" as const,
        hasPayload: true,
        rawOutput: "full output",
      },
    }));
    const agentApi = {
      onEvent: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        sessionState("thread-a", {
          toolCalls: {
            t1: { toolCallId: "t1", title: "Read", status: "completed", hasPayload: true },
            t2: { toolCallId: "t2", title: "Search", status: "completed", hasPayload: true },
          },
        }),
      ),
      getCapabilities: vi.fn(async () => null),
      getToolCalls,
      switchThread: vi.fn(),
      respondToPermission: vi.fn(),
      sendPrompt: vi.fn(),
      replacePrompt: vi.fn(),
      abort: vi.fn(),
      createThread: vi.fn(),
      setConfigOption: vi.fn(),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
      reportEditorText: vi.fn(),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store.getState().connect();
    await store.getState().hydrateToolCalls("thread-a", ["t1"]);

    expect(getToolCalls).toHaveBeenCalledWith("thread-a", ["t1"]);
    expect(store.getState().slice.toolCalls.t1?.rawOutput).toBe("full output");
    expect(store.getState().slice.toolCalls.t2?.rawOutput).toBeUndefined();
  });

  test("tracks which threads are running across open tabs", async () => {
    let bridgeHandler: ((payload: AcpBridgeEvent) => void) | null = null;
    let resolveSwitch: (() => void) | null = null;
    const switchGate = new Promise<void>((resolve) => {
      resolveSwitch = resolve;
    });
    const agentApi = {
      onEvent: vi.fn((handler: (payload: AcpBridgeEvent) => void) => {
        bridgeHandler = handler;
        return vi.fn();
      }),
      getState: vi.fn(async () => sessionState("thread-a")),
      getCapabilities: vi.fn(async () => null),
      // A background run is already in flight when the renderer connects.
      getRunningThreads: vi.fn(async () => ["thread-b"]),
      switchThread: vi.fn(async () => switchGate),
      respondToPermission: vi.fn(),
      sendPrompt: vi.fn(),
      replacePrompt: vi.fn(),
      abort: vi.fn(),
      createThread: vi.fn(),
      setConfigOption: vi.fn(),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
      reportEditorText: vi.fn(),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store.getState().connect();

    // Initial sync reflects the in-flight background thread, not just the active one.
    expect(store.getState().runningThreadIds).toEqual(["thread-b"]);

    // A second thread starts working; both tabs should now report running.
    bridgeHandler?.({ type: "running-threads", threadIds: ["thread-a", "thread-b"] });
    expect(store.getState().runningThreadIds).toEqual(["thread-a", "thread-b"]);

    // Running state stays live even while a thread switch is pending (not dropped as stale).
    store.getState().switchThread("thread-b");
    await vi.waitFor(() => expect(agentApi.switchThread).toHaveBeenCalledWith("thread-b"));
    bridgeHandler?.({ type: "running-threads", threadIds: ["thread-b"] });
    expect(store.getState().runningThreadIds).toEqual(["thread-b"]);

    // When the last run ends, no tab reports running.
    bridgeHandler?.({ type: "running-threads", threadIds: [] });
    expect(store.getState().runningThreadIds).toEqual([]);

    resolveSwitch?.();
  });

  test("surfaces switch-thread failures", async () => {
    const agentApi = {
      onEvent: vi.fn((_handler: (payload: AcpBridgeEvent) => void) => vi.fn()),
      getState: vi.fn(async () => sessionState("thread-a")),
      getCapabilities: vi.fn(async () => null),
      switchThread: vi.fn(async () => {
        throw new Error("runtime refused switch");
      }),
      respondToPermission: vi.fn(),
      sendPrompt: vi.fn(),
      replacePrompt: vi.fn(),
      abort: vi.fn(),
      createThread: vi.fn(),
      setConfigOption: vi.fn(),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
      reportEditorText: vi.fn(),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store.getState().connect();
    await expect(store.getState().switchThread("thread-b")).rejects.toThrow(
      "runtime refused switch",
    );

    expect(store.getState().state?.threadId).toBe("thread-a");
    expect(store.getState().error).toBe("runtime refused switch");
  });

  test("queues concurrent questions and answers them one at a time", async () => {
    let bridgeHandler: ((payload: AcpBridgeEvent) => void) | null = null;
    const respondToPermission = vi.fn(async () => {});
    const agentApi = {
      onEvent: vi.fn((handler: (payload: AcpBridgeEvent) => void) => {
        bridgeHandler = handler;
        return vi.fn();
      }),
      getState: vi.fn(async () => sessionState("thread-a")),
      getCapabilities: vi.fn(async () => null),
      switchThread: vi.fn(),
      respondToPermission,
      sendPrompt: vi.fn(),
      replacePrompt: vi.fn(),
      abort: vi.fn(),
      createThread: vi.fn(),
      setConfigOption: vi.fn(),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
      reportEditorText: vi.fn(),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store.getState().connect();

    // Two threads each raise a question. The second must not clobber the first.
    bridgeHandler?.({
      type: "permission-request",
      request: {
        sessionId: "session-thread-a",
        threadId: "thread-a",
        toolCall: { toolCallId: "t1", title: "Edit file A" },
        options: [
          { optionId: "allow-a", name: "Allow", kind: "allow_once" },
          { optionId: "reject-a", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    bridgeHandler?.({
      type: "permission-request",
      request: {
        sessionId: "session-thread-b",
        threadId: "thread-b",
        toolCall: { toolCallId: "t2", title: "Edit file B" },
        options: [{ optionId: "allow-b", name: "Allow", kind: "allow_once" }],
      },
    });

    // Both are held; the head (first to arrive) carries its originating thread.
    expect(store.getState().uiRequestQueue.map((r) => r.sessionId)).toEqual([
      "session-thread-a",
      "session-thread-b",
    ]);
    expect(store.getState().uiRequest?.threadId).toBe("thread-a");

    // Answering the head maps the chosen option name back to its optionId and
    // dequeues it, promoting the next question.
    await store.getState().respondToUiRequest({ requestId: "session-thread-a", value: "Reject" });
    expect(respondToPermission).toHaveBeenCalledWith({
      sessionId: "session-thread-a",
      optionId: "reject-a",
      cancelled: false,
    });
    expect(store.getState().uiRequestQueue.map((r) => r.sessionId)).toEqual(["session-thread-b"]);
    expect(store.getState().uiRequest?.threadId).toBe("thread-b");

    // A re-ask for the same session replaces in place instead of duplicating.
    bridgeHandler?.({
      type: "permission-request",
      request: {
        sessionId: "session-thread-b",
        threadId: "thread-b",
        toolCall: { toolCallId: "t2", title: "Edit file B" },
        options: [{ optionId: "allow-b", name: "Allow", kind: "allow_once" }],
      },
    });
    expect(store.getState().uiRequestQueue).toHaveLength(1);

    // Resolving the last one from the bridge empties the queue.
    bridgeHandler?.({ type: "permission-resolved", sessionId: "session-thread-b" });
    expect(store.getState().uiRequestQueue).toEqual([]);
    expect(store.getState().uiRequest).toBeNull();
  });

  test("reconnecting drops terminal output from the previous connection", async () => {
    let bridgeHandler: ((payload: AcpBridgeEvent) => void) | null = null;
    const agentApi = {
      onEvent: vi.fn((handler: (payload: AcpBridgeEvent) => void) => {
        bridgeHandler = handler;
        return vi.fn();
      }),
      getState: vi.fn(async () => sessionState("thread-a")),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    const { useAgentTerminalStore } = await import("./agent-terminal-store.ts");
    await store.getState().connect();

    bridgeHandler?.({
      type: "terminal-output",
      terminalId: "term-old",
      output: "build passed",
      append: true,
    });
    expect(useAgentTerminalStore.getState().getOutput("term-old")).toBe("build passed");

    // Reconnect: the old connection's terminals can never emit again, so
    // their accumulated output must not survive into the new connection.
    await store.getState().connect();
    expect(useAgentTerminalStore.getState().getOutput("term-old")).toBe("");
    expect(useAgentTerminalStore.getState().outputs).toEqual({});

    // The new connection's terminals still record output normally.
    bridgeHandler?.({
      type: "terminal-output",
      terminalId: "term-new",
      output: "hello",
      append: true,
    });
    expect(useAgentTerminalStore.getState().getOutput("term-new")).toBe("hello");
  });
});
