import { afterEach, describe, expect, test, vi } from "vitest";
import { getAllTerminalSessions, makeWorkspaceKey, useTerminalStore } from "./terminal-store";

function resetStore() {
  useTerminalStore.setState({
    sessions: [],
    workspaceKey: null,
    stashByWorkspace: {},
    historyControlRemainders: {},
    nextSessionNumber: 1,
    tabsRevision: 0,
    listenerInitialized: false,
  });
}

afterEach(() => {
  resetStore();
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe("terminal store session behavior", () => {
  test("creates sessions with stable titles, cwd, thread anchor, and active selection", () => {
    const ids = ["term-1", "term-2"];
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => ids.shift() ?? "term-fallback");

    useTerminalStore.getState().createSession("/tmp/project-a");
    useTerminalStore.getState().createSession("/tmp/project-b", "thread-b");

    expect(useTerminalStore.getState().sessions).toEqual([
      {
        id: "terminal:term-2",
        title: "Terminal 2",
        cwd: "/tmp/project-b",
        anchorThreadId: "thread-b",
        status: "starting",
        history: "",
      },
      {
        id: "terminal:term-1",
        title: "Terminal 1",
        cwd: "/tmp/project-a",
        anchorThreadId: null,
        status: "starting",
        history: "",
      },
    ]);
  });

  test("closing a session kills its pty and returns the first remaining session", () => {
    const kill = vi.fn();
    (globalThis as any).window = { omni: { terminal: { kill } } };
    useTerminalStore.setState({
      sessions: [
        { id: "term-1", title: "Terminal 1", history: "" },
        { id: "term-2", title: "Terminal 2", history: "" },
        { id: "term-3", title: "Terminal 3", history: "" },
      ],
    });

    const nextSessionId = useTerminalStore.getState().closeSession("term-2");

    expect(kill).toHaveBeenCalledWith("term-2");
    expect(useTerminalStore.getState().sessions.map((session) => session.id)).toEqual([
      "term-1",
      "term-3",
    ]);
    expect(nextSessionId).toBe("term-1");
  });

  test("terminal titles remain unique after close and create cycles", () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("term-1")
      .mockReturnValueOnce("term-2")
      .mockReturnValueOnce("term-3");
    (globalThis as any).window = { omni: { terminal: { kill: vi.fn() } } };

    const firstId = useTerminalStore.getState().createSession();
    useTerminalStore.getState().createSession();
    useTerminalStore.getState().closeSession(firstId);
    useTerminalStore.getState().createSession();

    expect(useTerminalStore.getState().sessions.map((session) => session.title)).toEqual([
      "Terminal 3",
      "Terminal 2",
    ]);
  });

  test("clearing sessions kills every active pty", () => {
    const kill = vi.fn();
    (globalThis as any).window = { omni: { terminal: { kill } } };
    useTerminalStore.setState({
      sessions: [
        { id: "term-1", title: "Terminal 1", history: "" },
        { id: "term-2", title: "Terminal 2", history: "" },
      ],
    });

    useTerminalStore.getState().clearSessions();

    expect(kill).toHaveBeenCalledWith("term-1");
    expect(kill).toHaveBeenCalledWith("term-2");
    expect(useTerminalStore.getState().sessions).toEqual([]);
  });

  test("switching workspace keeps the previous workspace's ptys alive", () => {
    const kill = vi.fn();
    (globalThis as any).window = { omni: { terminal: { kill } } };
    const keyA = makeWorkspaceKey("project-1", "/repo");
    const keyB = makeWorkspaceKey("project-1", "/repo/worktrees/feature");
    useTerminalStore.setState({
      workspaceKey: keyA,
      sessions: [
        {
          id: "term-a-1",
          title: "Terminal 1",
          cwd: "/repo",
          status: "running",
          history: "old output",
        },
        { id: "term-a-2", title: "Terminal 2", cwd: "/repo", status: "starting", history: "" },
      ],
    });

    const newActiveId = useTerminalStore.getState().setWorkspace(keyB, "/repo/worktrees/feature");

    expect(kill).not.toHaveBeenCalled();
    // Workspace B has no stash: the bucket starts empty.
    expect(newActiveId).toBeNull();
    expect(useTerminalStore.getState().sessions).toEqual([]);
    expect(useTerminalStore.getState().workspaceKey).toBe(keyB);
    expect(useTerminalStore.getState().stashByWorkspace[keyA]).toEqual([
      {
        id: "term-a-1",
        title: "Terminal 1",
        cwd: "/repo",
        status: "running",
        history: "old output",
      },
      { id: "term-a-2", title: "Terminal 2", cwd: "/repo", status: "starting", history: "" },
    ]);
    // The shells keep rendering these same ids, even though B's tab list is
    // empty. Removing them here would unmount the terminal emulator.
    expect(
      getAllTerminalSessions(useTerminalStore.getState()).map((session) => session.id),
    ).toEqual(["term-a-1", "term-a-2"]);
  });

  test("returning to a workspace preserves the original sessions and running status", () => {
    const ids = ["term-b-1"];
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => ids.shift() ?? "term-fallback");
    const kill = vi.fn();
    (globalThis as any).window = { omni: { terminal: { kill } } };
    const keyA = makeWorkspaceKey("project-1", "/repo");
    const keyB = makeWorkspaceKey("project-1", "/repo/worktrees/feature");
    useTerminalStore.setState({
      workspaceKey: keyA,
      sessions: [
        {
          id: "term-a-1",
          title: "Terminal 1",
          cwd: "/repo",
          status: "running",
          history: "root scrollback",
        },
        {
          id: "term-a-2",
          title: "Terminal 2",
          cwd: "/repo",
          status: "exited",
          exitCode: 0,
          history: "",
        },
      ],
    });

    useTerminalStore.getState().setWorkspace(keyB, "/repo/worktrees/feature");
    useTerminalStore.getState().createSession("/repo/worktrees/feature");
    const restoredActiveId = useTerminalStore.getState().setWorkspace(keyA, "/repo");

    expect(useTerminalStore.getState().sessions).toEqual([
      {
        id: "term-a-1",
        title: "Terminal 1",
        cwd: "/repo",
        status: "running",
        history: "root scrollback",
      },
      {
        id: "term-a-2",
        title: "Terminal 2",
        cwd: "/repo",
        status: "exited",
        exitCode: 0,
        history: "",
      },
    ]);
    expect(restoredActiveId).toBe("term-a-1");
    expect(useTerminalStore.getState().workspaceKey).toBe(keyA);
    // A's stash was consumed; B's terminal is stashed for its own return.
    expect(useTerminalStore.getState().stashByWorkspace[keyA]).toBeUndefined();
    expect(useTerminalStore.getState().stashByWorkspace[keyB]).toEqual([
      {
        id: "terminal:term-b-1",
        title: "Terminal 1",
        cwd: "/repo/worktrees/feature",
        anchorThreadId: null,
        status: "starting",
        history: "",
      },
    ]);
    expect(kill).not.toHaveBeenCalled();
  });

  test("background output and exits are retained across workspace switches", () => {
    let dataHandler = (_payload: { sessionId: string; data: string }) => {};
    let exitHandler = (_payload: { sessionId: string; exitCode: number; signal?: number }) => {};
    const kill = vi.fn();
    (globalThis as any).window = {
      omni: {
        terminal: {
          kill,
          onData: (handler: typeof dataHandler) => {
            dataHandler = handler;
          },
          onExit: (handler: typeof exitHandler) => {
            exitHandler = handler;
          },
        },
      },
    };
    const state = useTerminalStore.getState;
    const keyA = makeWorkspaceKey("project", "/a");
    state().setWorkspace(keyA, "/a");
    const idA = state().createSession("/a");
    state().initializeGlobalListener();
    // A split escape sequence can straddle navigation; neither half should
    // leak into recovered history.
    dataHandler({ sessionId: idA, data: "before\u001b[" });
    state().setWorkspace(makeWorkspaceKey("project", "/b"), "/b");
    state().createSession("/b");
    state().markRunning(idA);
    expect(state().stashByWorkspace[keyA][0].status).toBe("running");
    const tabsRevision = state().tabsRevision;
    dataHandler({ sessionId: idA, data: "31mafter\u001b[0m\n" });
    expect(state().tabsRevision).toBe(tabsRevision);
    exitHandler({ sessionId: idA, exitCode: 2, signal: 15 });
    state().setWorkspace(keyA, "/a");
    expect(state().sessions[0]).toMatchObject({
      id: idA,
      cwd: "/a",
      status: "exited",
      exitCode: 2,
      exitSignal: 15,
    });
    expect(state().sessions[0].history).toBe("beforeafter\n\r\n[Process completed (exit 2)]\r\n");
    expect(kill).not.toHaveBeenCalled();
  });

  test("first workspace binding retains terminals created before project hydration", () => {
    const kill = vi.fn();
    (globalThis as any).window = { omni: { terminal: { kill } } };
    const state = useTerminalStore.getState;
    const id = state().createSession("/a");
    state().markRunning(id);
    expect(state().setWorkspace(makeWorkspaceKey("project", "/a"), "/a")).toBe(id);
    expect(state().sessions[0]).toMatchObject({ id, cwd: "/a", status: "running" });
    expect(kill).not.toHaveBeenCalled();
  });

  test("closing a background session kills only that session and prevents restoration", () => {
    const kill = vi.fn();
    (globalThis as any).window = { omni: { terminal: { kill } } };
    const state = useTerminalStore.getState;
    const keyA = makeWorkspaceKey("project", "/a");
    state().setWorkspace(keyA, "/a");
    const idA = state().createSession("/a");
    state().setWorkspace(makeWorkspaceKey("project", "/b"), "/b");
    const idB = state().createSession("/b");
    state().closeSession(idA);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(idA);
    expect(state().sessions[0].id).toBe(idB);
    expect(state().setWorkspace(keyA, "/a")).toBeNull();
  });

  test("clearing terminals includes background workspaces", () => {
    const kill = vi.fn();
    (globalThis as any).window = { omni: { terminal: { kill } } };
    const state = useTerminalStore.getState;
    state().setWorkspace(makeWorkspaceKey("project", "/a"), "/a");
    const idA = state().createSession("/a");
    state().setWorkspace(makeWorkspaceKey("project", "/b"), "/b");
    const idB = state().createSession("/b");
    state().clearSessions();
    expect(kill.mock.calls).toEqual([[idB], [idA]]);
    expect(state().sessions).toEqual([]);
    expect(state().stashByWorkspace).toEqual({});
  });

  test.each(["visible", "background"])(
    "deleting a %s workspace stops only its terminals and forgets its bucket",
    (location) => {
      const kill = vi.fn();
      (globalThis as any).window = { omni: { terminal: { kill } } };
      const state = useTerminalStore.getState;
      const keyA = makeWorkspaceKey("project-a", "/workspace-a");
      const keyB = makeWorkspaceKey("project-a", "/workspace-b");
      // The same path in a different project is a different owner.
      const keyC = makeWorkspaceKey("project-c", "/workspace-a");
      state().setWorkspace(keyA, "/workspace-a");
      const idA1 = state().createSession("/workspace-a");
      const idA2 = state().createSession("/workspace-a/subdirectory");
      state().markRunning(idA1);
      state().appendHistory(idA1, "old output\u001b[");
      state().setWorkspace(keyC, "/workspace-a");
      const idC = state().createSession("/workspace-a");
      state().appendHistory(idC, "keep\u001b[");
      state().setWorkspace(keyB, "/workspace-b");
      const idB = state().createSession("/workspace-b");
      if (location === "visible") state().setWorkspace(keyA, "/workspace-a");
      const tabsRevision = state().tabsRevision;

      expect(state().closeWorkspace(keyA)).toEqual([idA2, idA1]);

      expect(kill.mock.calls).toEqual([[idA2], [idA1]]);
      expect(state().stashByWorkspace[keyA]).toBeUndefined();
      expect(state().historyControlRemainders[idA1]).toBeUndefined();
      expect(state().historyControlRemainders[idC]).toBe("\u001b[");
      expect(state().tabsRevision).toBe(tabsRevision + 1);
      expect(
        getAllTerminalSessions(state())
          .map((session) => session.id)
          .sort(),
      ).toEqual([idB, idC].sort());
      // A late process event cannot recreate the deleted session or history.
      state().appendHistory(idA1, "late output");
      state().markRunning(idA1);
      expect(state().historyControlRemainders[idA1]).toBeUndefined();
      state().setWorkspace(keyB, "/workspace-b");
      expect(state().setWorkspace(keyA, "/workspace-a")).toBeNull();
      expect(state().sessions).toEqual([]);
      // Repeated cleanup is harmless and does not disturb surviving shells.
      expect(state().closeWorkspace(keyA)).toEqual([]);
      expect(kill).toHaveBeenCalledTimes(2);
    },
  );

  test("visiting more than ten workspaces does not discard live terminals", () => {
    const kill = vi.fn();
    (globalThis as any).window = { omni: { terminal: { kill } } };
    const state = useTerminalStore.getState;
    const keys = Array.from({ length: 12 }, (_, i) =>
      makeWorkspaceKey("project", `/workspace-${i}`),
    );
    state().setWorkspace(keys[0], "/workspace-0");
    const id = state().createSession("/workspace-0");
    state().markRunning(id);
    for (let i = 1; i < keys.length; i++) {
      state().setWorkspace(keys[i], `/workspace-${i}`);
      state().createSession(`/workspace-${i}`);
    }
    expect(state().setWorkspace(keys[0], "/workspace-0")).toBe(id);
    expect(state().sessions[0].status).toBe("running");
    expect(kill).not.toHaveBeenCalled();
  });

  test("re-entering the current workspace is a no-op", () => {
    const kill = vi.fn();
    (globalThis as any).window = { omni: { terminal: { kill } } };
    const keyA = makeWorkspaceKey("project-1", "/repo");
    useTerminalStore.setState({
      workspaceKey: keyA,
      sessions: [{ id: "term-a-1", title: "Terminal 1", cwd: "/repo", history: "keep" }],
    });

    const activeId = useTerminalStore.getState().setWorkspace(keyA, "/repo");

    expect(activeId).toBe("term-a-1");
    expect(kill).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().sessions.map((session) => session.id)).toEqual(["term-a-1"]);
  });

  test("global data listener is registered once and appends payloads to matching history", () => {
    let onDataHandler: ((payload: { sessionId: string; data: string }) => void) | null = null;
    const onData = vi.fn((handler: (payload: { sessionId: string; data: string }) => void) => {
      onDataHandler = handler;
    });
    (globalThis as any).window = { omni: { terminal: { onData } } };
    useTerminalStore.setState({
      sessions: [{ id: "term-1", title: "Terminal 1", history: "" }],
    });

    useTerminalStore.getState().initializeGlobalListener();
    useTerminalStore.getState().initializeGlobalListener();
    onDataHandler?.({ sessionId: "term-1", data: "hello" });

    expect(onData).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().listenerInitialized).toBe(true);
    expect(useTerminalStore.getState().sessions[0]?.history).toBe("hello");
  });

  test("history is bounded when terminal output grows too large", () => {
    useTerminalStore.setState({
      sessions: [{ id: "term-1", title: "Terminal 1", history: "a".repeat(150000) }],
    });

    useTerminalStore.getState().appendHistory("term-1", "b".repeat(60000));

    const history = useTerminalStore.getState().sessions[0]?.history ?? "";
    expect(history).toHaveLength(200000);
    expect(history).toBe(`${"a".repeat(140000)}${"b".repeat(60000)}`);
  });

  test("recovery history strips terminal control sequences", () => {
    useTerminalStore.setState({
      sessions: [{ id: "term-1", title: "Terminal 1", history: "" }],
    });

    useTerminalStore
      .getState()
      .appendHistory("term-1", "\u001b[31mred\u001b[0m\r\n\u001b]0;title\u0007plain");

    expect(useTerminalStore.getState().sessions[0]?.history).toBe("red\r\nplain");
  });

  test("recovery history strips control sequences split across output chunks", () => {
    useTerminalStore.setState({
      sessions: [{ id: "term-1", title: "Terminal 1", history: "" }],
    });

    useTerminalStore.getState().appendHistory("term-1", "before\u001b[");
    useTerminalStore.getState().appendHistory("term-1", "31mred\u001b[0mafter");

    expect(useTerminalStore.getState().sessions[0]?.history).toBe("beforeredafter");
  });

  test("orphan output is a referential no-op", () => {
    const sessions = [{ id: "term-1", title: "Terminal 1", history: "" }];
    useTerminalStore.setState({ sessions });

    useTerminalStore.getState().appendHistory("missing", "ignored");

    expect(useTerminalStore.getState().sessions).toBe(sessions);
  });

  test("global exit events persist completion state while the view is hidden", () => {
    let onExitHandler:
      | ((payload: { sessionId: string; exitCode: number; signal?: number }) => void)
      | null = null;
    const onData = vi.fn();
    const onExit = vi.fn(
      (handler: (payload: { sessionId: string; exitCode: number; signal?: number }) => void) => {
        onExitHandler = handler;
      },
    );
    (globalThis as any).window = { omni: { terminal: { onData, onExit } } };
    useTerminalStore.setState({
      sessions: [{ id: "term-1", title: "Terminal 1", status: "running", history: "output\n" }],
    });

    useTerminalStore.getState().initializeGlobalListener();
    onExitHandler?.({ sessionId: "term-1", exitCode: 2 });

    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      status: "exited",
      exitCode: 2,
    });
    expect(useTerminalStore.getState().sessions[0]?.history).toContain(
      "[Process completed (exit 2)]",
    );
  });
});
