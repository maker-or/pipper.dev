// Opt-in diagnostic reproductions of current scheduling behavior, not production latency benchmarks.
import { expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
vi.mock("electron", () => ({ app: { getPath: () => "/nonexistent-userdata" } }));
/** Reports are regenerated on demand; the output directory is not tracked. */
async function writeReport(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
import { AgentConnectionManager } from "./agent-connection-manager.ts";
import { SnapshotFreshness } from "./snapshot-freshness.ts";
import { createEmptySessionSlice } from "../src/lib/acp-session-reducer.ts";
function snapshotManager(write: (input: any) => Promise<any>) {
  return Object.assign(Object.create(AgentConnectionManager.prototype), {
    snapshotStore: { enabled: true, write },
    snapshotWriteChains: new Map(),
    snapshotTimers: new Map(),
    loadingSessionThreads: new Set(),
    sessions: new Map(),
    pendingSnapshotWrites: new Map(),
    snapshotWriteFailures: 0,
    snapshotWritesBlockedUntil: 0,
    snapshotFreshness: new SnapshotFreshness(),
    disposing: false,
  });
}
function runtime(id: string) {
  return {
    threadId: id,
    agentSessionId: id,
    agentId: "scripted",
    slice: createEmptySessionSlice(),
    promptInFlight: false,
    agentReady: true,
    snapshotDirty: true,
    toolPayloads: new Map(),
    payloadRevision: 0,
  };
}
test.skipIf(process.env.PIPPER_ARCHITECTURE_SCHEDULING !== "1")(
  "verify snapshot failures recover and pending revisions coalesce",
  async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let attempts = 0;
      const failing = snapshotManager(async () => {
        attempts++;
        if (attempts === 1) throw new Error("Injected single storage write failure");
        return {};
      });
      failing.sessions.set("a", runtime("a"));
      failing.sessions.set("b", runtime("b"));
      const first = await failing.flushThreadSnapshot("a");
      const other = await failing.flushThreadSnapshot("b");
      expect(first).toBe(false);
      expect(other).toBe(true);
      expect(attempts).toBe(2);
      expect(failing.snapshotWriteFailures).toBe(0);
      for (const timer of failing.snapshotTimers.values()) clearTimeout(timer);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const revisions: string[] = [];
      const queued = snapshotManager(async (input: any) => {
        revisions.push(input.slice.title);
        if (revisions.length === 1) await gate;
        return null;
      });
      const r = runtime("queued");
      queued.sessions.set(r.threadId, r);
      const requests: Promise<boolean>[] = [];
      r.slice = { ...r.slice, title: "revision-0" };
      requests.push(queued.flushThreadSnapshot(r.threadId));
      await vi.waitFor(() => expect(revisions).toHaveLength(1));
      for (let i = 1; i < 6; i++) {
        r.slice = { ...r.slice, title: `revision-${i}` };
        requests.push(queued.flushThreadSnapshot(r.threadId));
      }
      const trackedChains = queued.snapshotWriteChains.size;
      const pendingInputs = queued.pendingSnapshotWrites.size;
      expect(pendingInputs).toBe(1);
      release();
      await Promise.all(requests);
      expect(revisions).toEqual(["revision-0", "revision-5"]);
      await writeReport(
        "docs/architecture/opencode/snapshot-queue-verification.json",
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            scope:
              "Actual public flushThreadSnapshot methods on AgentConnectionManager.prototype with minimum initialized queue state and controlled storage adapters. No real disk failure, retention-byte, production frequency, or app-latency measurement. Tests isolate queue/catch behavior from constructor/process startup.",
            failure: {
              injectedFailures: 1,
              actualWriteAttempts: attempts,
              firstFlushResult: first,
              otherThreadFlushResult: other,
              consecutiveFailuresAfterRecovery: failing.snapshotWriteFailures,
            },
            queuedRevisions: {
              concurrentRequests: 6,
              trackedTailMapEntries: trackedChains,
              pendingInputs,
              writtenRevisions: revisions,
              coalescedToLatest: true,
            },
          },
          null,
          2,
        ),
      );
    } finally {
      warn.mockRestore();
    }
  },
);

vi.mock("../src/components/ui/toast", () => ({ toast: vi.fn() }));
test.skipIf(process.env.PIPPER_ARCHITECTURE_SCHEDULING !== "1")(
  "delivered events that leave the active session unchanged notify no subscribers",
  async () => {
    let bridge: (payload: any) => void = () => {};
    const initial = {
      ...createEmptySessionSlice(),
      projectId: "fixture",
      threadId: "active",
      agentId: "scripted",
      agentSessionId: "active-session",
      cwd: "/tmp",
      isCompacting: false,
      editorText: "",
      authRequiredMessage: null,
      switchingAgent: false,
    };
    vi.stubGlobal("window", {
      omni: {
        agent: {
          onEvent: (handler: any) => {
            bridge = handler;
            return () => {};
          },
          getState: async () => initial,
        },
      },
    });
    try {
      const { useAgentStore } = await import("../src/store/agent-store.ts");
      await useAgentStore.getState().connect();
      const initialState = useAgentStore.getState().state;
      const initialSnapshot = useAgentStore.getState().snapshot;
      let notifications = 0;
      const unsubscribe = useAgentStore.subscribe(() => {
        notifications++;
      });
      for (let i = 0; i < 100; i++)
        bridge({
          type: "terminal-output",
          terminalId: "probe-terminal",
          output: "fixture\n",
          append: true,
        });
      const terminalOutputNotifications = notifications;
      for (let i = 0; i < 100; i++)
        bridge({
          type: "session-update",
          sessionId: "other-session",
          threadId: "background",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "fixture" },
          },
        });
      const injectedBackgroundNotifications = notifications - terminalOutputNotifications;
      const activeStateUnchanged = useAgentStore.getState().state === initialState;
      const projectionUnchanged = useAgentStore.getState().snapshot === initialSnapshot;
      unsubscribe();
      expect(terminalOutputNotifications).toBe(0);
      expect(injectedBackgroundNotifications).toBe(0);
      expect(activeStateUnchanged).toBe(true);
      expect(projectionUnchanged).toBe(true);
      await writeReport(
        "docs/architecture/opencode/ignored-event-verification.json",
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            scope:
              "Actual renderer agent store connected to a scripted preload bridge. Counts Zustand listener notifications, not React renders/commits/paint or production IPC frequency. Terminal outputs are a real bridge event type. Background deltas are deliberately injected to exercise the defensive path; main normally suppresses those text deltas.",
            terminalOutputEvents: 100,
            terminalOutputNotifications,
            injectedBackgroundEvents: 100,
            injectedBackgroundNotifications,
            activeStateUnchanged,
            projectionUnchanged,
          },
          null,
          2,
        ),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
