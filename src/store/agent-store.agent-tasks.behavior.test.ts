import { afterEach, describe, expect, test, vi } from "vitest";
import type { AcpBridgeEvent, AcpSessionState } from "../../contracts/acp.ts";
import type { AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";

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

function task(taskId: string, status: AgentTaskSnapshot["status"]): AgentTaskSnapshot {
  return {
    taskId,
    parentThreadId: "thread-a",
    childThreadId: `child-${taskId}`,
    projectId: "project-1",
    agentId: "codex-acp",
    title: "audit the auth flow",
    status,
    outcome: status === "idle" ? "done" : null,
    waitingForPermission: false,
    workspaceMode: "shared",
    workspacePath: "/tmp/project",
    branch: null,
    depth: 1,
    turns: status === "idle" ? 1 : 0,
    createdAt: 1,
    updatedAt: 2,
    reportPreview: null,
    nextStep: null,
    error: null,
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
    agentTasks: [],
  });
  return mod.useAgentStore;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});

describe("agent tasks in the agent store", () => {
  test("agent-tasks bridge events update the store, including while a thread switch is pending", async () => {
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
      getCapabilities: vi.fn(async () => ({
        promptCapabilities: { image: true, embeddedContext: true },
      })),
      getRunningThreads: vi.fn(async () => []),
      switchThread: vi.fn(async () => switchGate),
      sendPrompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    (globalThis as any).window = { omni: { agent: agentApi } };

    const store = await loadStore();
    await store.getState().connect();

    bridgeHandler!({ type: "agent-tasks", tasks: [task("t1", "running")] });
    expect(store.getState().agentTasks.map((t) => t.taskId)).toEqual(["t1"]);

    // Tasks are global — they must keep flowing while the panel is switching
    // threads (when most per-thread events are deliberately dropped).
    const switching = store.getState().switchThread("thread-b");
    bridgeHandler!({
      type: "agent-tasks",
      tasks: [task("t1", "idle"), task("t2", "starting")],
    });
    expect(store.getState().agentTasks.map((t) => [t.taskId, t.status])).toEqual([
      ["t1", "idle"],
      ["t2", "starting"],
    ]);

    resolveSwitch!();
    await switching;
  });
});
