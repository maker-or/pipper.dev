import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpBridgeEvent, AcpEntry, AcpSessionState } from "../../contracts/acp.ts";
import { resetToolPayloadStore } from "./tool-payload-store";

vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));

function sessionState(threadId: string, patch: Partial<AcpSessionState> = {}): AcpSessionState {
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
    isStreaming: true,
    isCompacting: false,
    editorText: "",
    authRequiredMessage: null,
    switchingAgent: false,
    ...patch,
  };
}

const text = (value: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
});
const thought = (value: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text: value },
});

/** Entry types and text, without generated ids. */
function timeline(entries: readonly AcpEntry[] | undefined) {
  return (entries ?? []).map((entry) =>
    entry.type === "tool_call" ? `tool:${entry.toolCallId}` : `${entry.type}:${entry.text}`,
  );
}

function blockText(content: string | Array<Record<string, unknown>> | undefined) {
  return Array.isArray(content) ? content.map((block) => block.text).join("") : content;
}

async function connectedStore(initial = sessionState("thread-a")) {
  let handler: (payload: AcpBridgeEvent) => void = () => {};
  let mainState = initial;
  const agentApi = {
    onEvent: vi.fn((next: (payload: AcpBridgeEvent) => void) => {
      handler = next;
      return vi.fn();
    }),
    getState: vi.fn(async () => mainState),
    sendPrompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    respondToPermission: vi.fn(async () => {}),
  };
  (globalThis as any).window = { omni: { agent: agentApi } };
  vi.resetModules();
  const { useAgentStore } = await import("./agent-store.ts");
  await useAgentStore.getState().connect();
  let notifications = 0;
  useAgentStore.subscribe(() => {
    notifications += 1;
  });
  const emit = (payload: AcpBridgeEvent) => handler(payload);
  return {
    store: useAgentStore,
    agentApi,
    notifications: () => notifications,
    setMainState: (next: AcpSessionState) => {
      mainState = next;
    },
    emit,
    update: (update: SessionUpdate, threadId = "thread-a") =>
      emit({ type: "session-update", sessionId: `session-${threadId}`, threadId, update }),
    entries: () => timeline(useAgentStore.getState().state?.entries),
    streamingText: () => blockText(useAgentStore.getState().snapshot?.streamingMessage?.content),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  resetToolPayloadStore();
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});

describe("agent store streamed text coalescing", () => {
  test("applies adjacent text and thought deltas in order with one notification within 16 ms", async () => {
    const s = await connectedStore();
    s.update(thought("think "));
    s.update(text("Hello"));
    s.update(text(", "));
    s.update(text("world"));
    expect(s.notifications()).toBe(0);
    expect(s.entries()).toEqual([]);

    vi.advanceTimersByTime(15);
    expect(s.notifications()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(s.notifications()).toBe(1);
    expect(s.entries()).toEqual(["agent_thought:think ", "agent_text:Hello, world"]);
    expect(s.streamingText()).toBe("Hello, world");

    vi.advanceTimersByTime(100);
    expect(s.notifications()).toBe(1);
  });

  test("flushes buffered text before a tool call and its updates", async () => {
    const s = await connectedStore();
    s.update(text("Reading "));
    s.update(text("the file"));
    s.update({
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      title: "Read",
      status: "pending",
    });
    expect(s.entries()).toEqual(["agent_text:Reading the file", "tool:read-1"]);
    expect(s.notifications()).toBe(2);

    s.update(text("Done"));
    s.update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" });
    expect(s.entries()).toEqual(["agent_text:Reading the file", "tool:read-1", "agent_text:Done"]);
    expect(s.store.getState().state?.toolCalls["read-1"]?.status).toBe("completed");
    expect(s.notifications()).toBe(4);
    vi.runAllTimers();
    expect(s.notifications()).toBe(4);
  });

  test("text is visible in the same notification that raises a permission request", async () => {
    const s = await connectedStore();
    s.update(text("May I edit?"));
    const seen: Array<{ text: unknown; asked: boolean }> = [];
    s.store.subscribe((state) =>
      seen.push({
        text: blockText(state.snapshot?.streamingMessage?.content),
        asked: state.uiRequest != null,
      }),
    );
    s.emit({
      type: "permission-request",
      request: {
        sessionId: "session-thread-a",
        threadId: "thread-a",
        requestId: 1,
        toolCall: { toolCallId: "edit-1", title: "Edit file" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      } as never,
    });
    expect(seen).toEqual([
      { text: "May I edit?", asked: false },
      { text: "May I edit?", asked: true },
    ]);

    s.update(text(" Thanks."));
    s.emit({ type: "permission-resolved", sessionId: "session-thread-a", requestId: 1 });
    expect(s.store.getState().uiRequest).toBeNull();
    expect(s.entries()).toEqual(["agent_text:May I edit? Thanks."]);
  });

  test("applies the turn's last text before stop and leaves nothing to flush", async () => {
    const s = await connectedStore();
    s.update(text("final words"));
    s.emit({
      type: "stop",
      sessionId: "session-thread-a",
      threadId: "thread-a",
      stopReason: "end_turn",
    } as never);
    expect(s.entries()).toEqual(["agent_text:final words"]);
    expect(s.store.getState().state?.isStreaming).toBe(false);
    expect(s.notifications()).toBe(2);
    vi.runAllTimers();
    expect(s.notifications()).toBe(2);
    expect(s.store.getState().state?.isStreaming).toBe(false);
  });

  test("an authoritative session-state lands after earlier deltas, and they are not reapplied", async () => {
    const s = await connectedStore();
    s.update(text("partial"));
    s.emit({
      type: "session-state",
      state: sessionState("thread-a", {
        entries: [{ type: "agent_text", id: "main-1", messageId: null, text: "partial" }],
      }),
    });
    expect(s.entries()).toEqual(["agent_text:partial"]);
    vi.runAllTimers();
    expect(s.entries()).toEqual(["agent_text:partial"]);

    // A switch to another thread settles without the previous thread's buffered text.
    s.update(text(" more"));
    s.emit({ type: "session-state", state: sessionState("thread-b") });
    vi.runAllTimers();
    expect(s.store.getState().state?.threadId).toBe("thread-b");
    expect(s.entries()).toEqual([]);
  });

  test("sendPrompt lands the previous turn's tail before the optimistic echo", async () => {
    const s = await connectedStore();
    s.update(text("previous answer"));
    await s.store.getState().sendPrompt({ threadId: "thread-a", message: "next question" });
    expect(s.entries()).toEqual(["agent_text:previous answer", "user_text:next question"]);
    expect(s.agentApi.sendPrompt).toHaveBeenCalledOnce();

    s.update(text("new answer"));
    vi.advanceTimersByTime(16);
    expect(s.entries()).toEqual([
      "agent_text:previous answer",
      "user_text:next question",
      "agent_text:new answer",
    ]);
  });

  test("abort and switchThread apply buffered text before acting", async () => {
    const s = await connectedStore();
    s.update(text("before abort"));
    await s.store.getState().abort();
    expect(s.entries()).toEqual(["agent_text:before abort"]);

    s.update(text(", before switch"));
    const agent = (globalThis as any).window.omni.agent;
    agent.switchThread = vi.fn(async () => {});
    const switching = s.store.getState().switchThread("thread-b");
    expect(s.entries()).toEqual(["agent_text:before abort, before switch"]);
    expect(s.store.getState().pendingThreadTarget).toBe("thread-b");
    // While the switch is pending, the old thread's deltas are not buffered.
    s.update(text(" ignored"));
    // Past the stream flush window only: running every timer would also fire
    // the pending switch's 240 s timeout.
    vi.advanceTimersByTime(100);
    expect(s.entries()).toEqual(["agent_text:before abort, before switch"]);
    s.emit({ type: "session-state", state: sessionState("thread-b") });
    await switching;
    expect(s.store.getState().state?.threadId).toBe("thread-b");
  });

  test("refresh drops deltas already contained in main's snapshot", async () => {
    const s = await connectedStore();
    s.setMainState(
      sessionState("thread-a", {
        entries: [{ type: "agent_text", id: "main-1", messageId: null, text: "in flight" }],
      }),
    );
    const refreshed = s.store.getState().refresh();
    // Received while getState is in flight: main's reply already includes it.
    s.update(text("in flight"));
    await refreshed;
    vi.runAllTimers();
    expect(s.entries()).toEqual(["agent_text:in flight"]);
  });

  test("events that change nothing still notify nobody and do not flush the buffer", async () => {
    const s = await connectedStore();
    s.update(text("a"));
    s.update(text("background"), "thread-b");
    s.emit({
      type: "terminal-output",
      terminalId: "term-1",
      output: "ls\n",
      append: true,
    } as never);
    s.update(text("b"));
    expect(s.notifications()).toBe(0);
    vi.advanceTimersByTime(16);
    expect(s.notifications()).toBe(1);
    expect(s.entries()).toEqual(["agent_text:ab"]);

    s.update(text("x"), "thread-b");
    s.emit({ type: "notification", level: "info", message: "hi" } as never);
    vi.runAllTimers();
    expect(s.notifications()).toBe(1);
  });

  test("flushes on the next animation frame when frames are running", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const s = await connectedStore();
    frames.length = 0;
    s.update(text("one "));
    s.update(text("two"));
    expect(s.notifications()).toBe(0);
    // One store frame for the batch (the monitor observer may request its own).
    for (const frame of frames.splice(0)) frame(0);
    expect(s.notifications()).toBe(1);
    expect(s.entries()).toEqual(["agent_text:one two"]);
    // The timer fallback was cancelled with the frame flush.
    vi.runAllTimers();
    expect(s.notifications()).toBe(1);
  });
});
