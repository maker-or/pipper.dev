import { afterEach, describe, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

vi.mock("electron", () => ({ app: { getPath: () => "/nonexistent-userdata" } }));

import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import type { AgentTaskConfig, AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";
import { AgentTaskStore, ensureAgentTaskSchema } from "./agent-task-store.ts";
import {
  AgentTaskService,
  type AgentTaskHost,
  type ApprovalAnswer,
  type TurnOrigin,
} from "./agent-task-service.ts";

const PROJECT = { id: "project-1", path: "/repo" };

const AGENTS: AcpAgentDescriptor[] = [
  {
    id: "codex",
    name: "codex",
    displayName: "Codex",
    command: "codex",
    args: [],
    available: true,
    installKind: "binary",
  },
  {
    id: "claude",
    name: "claude",
    displayName: "Claude",
    command: "claude",
    args: [],
    available: true,
    installKind: "binary",
  },
];

interface FakeThread {
  threadId: string;
  sessionId: string;
  title: string;
  cwd: string;
  inFlight: boolean;
  lastText: string;
  pendingPermission: boolean;
  finishTurn: (() => void) | null;
}

interface SentPrompt {
  threadId: string;
  message: string;
  mode: "follow_up" | "steer" | null;
  origin: TurnOrigin;
}

/**
 * Scripted connection manager: threads are records, a prompt to an idle
 * thread starts a turn at once (like the real drain), and tests end turns
 * with `finishTurn`, which reports the settle the way the manager does.
 */
function makeHost() {
  const threads = new Map<string, FakeThread>();
  const sent: SentPrompt[] = [];
  const cancelled: string[] = [];
  const approvals: Array<{ threadId: string; title: string }> = [];
  const workspaces: Array<{ path: string; rolledBack: boolean }> = [];
  const emitted: AgentTaskSnapshot[][] = [];
  let approvalAnswer: ApprovalAnswer = "once";
  let createThreadError: Error | null = null;
  let changed: string[] = [];
  let counter = 0;
  let service!: AgentTaskService;
  /** Threads whose in-flight check reads stale (a turn starts right after it). */
  const staleInFlight = new Set<string>();

  const addThread = (title: string, cwd: string): FakeThread => {
    counter += 1;
    const thread: FakeThread = {
      threadId: `thread-${counter}`,
      sessionId: `session-${counter}`,
      title,
      cwd,
      inFlight: false,
      lastText: "",
      pendingPermission: false,
      finishTurn: null,
    };
    threads.set(thread.threadId, thread);
    return thread;
  };

  const startTurn = (thread: FakeThread, origin: TurnOrigin) =>
    new Promise<void>((resolve) => {
      thread.inFlight = true;
      service.onTurnStarted(thread.threadId, origin);
      thread.finishTurn = () => {
        thread.inFlight = false;
        thread.finishTurn = null;
        resolve();
      };
    });

  const host: AgentTaskHost = {
    listAgents: () => AGENTS,
    threadIdForSession: (sessionId) =>
      [...threads.values()].find((t) => t.sessionId === sessionId)?.threadId ?? null,
    threadInfo: (threadId) => {
      const thread = threads.get(threadId);
      return thread
        ? {
            threadId,
            projectId: PROJECT.id,
            projectPath: PROJECT.path,
            title: thread.title,
            cwd: thread.cwd,
          }
        : null;
    },
    createWorkspace: async (_projectId, name) => {
      const workspace = { path: `/worktrees/${name}`, rolledBack: false };
      workspaces.push(workspace);
      return {
        path: workspace.path,
        branch: `pipper/${name}`,
        rollback: async () => {
          workspace.rolledBack = true;
        },
      };
    },
    listWorkspaces: async () => [
      { path: PROJECT.path, branch: "main", isProjectRoot: true },
      { path: "/worktrees/shared-feature", branch: "pipper/shared-feature", isProjectRoot: false },
    ],
    createThread: async ({ title, cwd }) => {
      if (createThreadError) throw createThreadError;
      return { threadId: addThread(title, cwd).threadId };
    },
    sendPrompt: async (threadId, message, { mode, origin }) => {
      sent.push({ threadId, message, mode, origin });
      const thread = threads.get(threadId);
      if (!thread) throw new Error("No session for thread");
      if (thread.inFlight) {
        // Like the manager: a plain prompt can't interrupt a running turn.
        if (mode === null)
          throw new Error("A prompt is already in flight; choose follow-up or steer to queue it.");
        return; // queued follow-ups are not modelled further
      }
      await startTurn(thread, origin);
    },
    cancelTurn: async (threadId) => {
      cancelled.push(threadId);
      const thread = threads.get(threadId);
      if (thread?.inFlight) {
        thread.finishTurn?.();
        service.onTurnSettled(threadId, { stopReason: "cancelled" });
      }
    },
    isTurnInFlight: (threadId) =>
      !staleInFlight.has(threadId) && Boolean(threads.get(threadId)?.inFlight),
    lastTurn: (threadId) => {
      const thread = threads.get(threadId);
      return thread ? { text: thread.lastText, toolCalls: { edit: 2, read: 1 } } : null;
    },
    hasPendingPermission: (threadId) => Boolean(threads.get(threadId)?.pendingPermission),
    requestApproval: async (threadId, { title }) => {
      approvals.push({ threadId, title });
      return approvalAnswer;
    },
    headSha: async () => "abc123",
    changedFiles: async () => changed,
    emitTasks: (tasks) => emitted.push(tasks),
  };

  return {
    host,
    threads,
    sent,
    cancelled,
    approvals,
    workspaces,
    emitted,
    addThread,
    bind: (value: AgentTaskService) => {
      service = value;
    },
    setApproval: (answer: ApprovalAnswer) => {
      approvalAnswer = answer;
    },
    failCreateThread: (error: Error | null) => {
      createThreadError = error;
    },
    setChangedFiles: (files: string[]) => {
      changed = files;
    },
    /** End a thread's current turn with this assistant text. */
    finish: (threadId: string, text: string) => {
      const thread = threads.get(threadId)!;
      thread.lastText = text;
      thread.finishTurn?.();
      service.onTurnSettled(threadId, { stopReason: "end_turn" });
    },
    staleInFlight,
    /** The user types into a thread (a turn that isn't the service's). */
    userTurn: (threadId: string) => void startTurn(threads.get(threadId)!, "user"),
  };
}

const services: AgentTaskService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
});

async function setup(config: Partial<AgentTaskConfig> = {}) {
  const db = new DatabaseSync(":memory:");
  ensureAgentTaskSchema(db);
  const store = new AgentTaskStore(() => db);
  const fake = makeHost();
  const baseDir = await mkdtemp(join(tmpdir(), "pipper-agent-tasks-"));
  const service = new AgentTaskService({ host: fake.host, store, baseDir, noteDelayMs: 5 });
  services.push(service);
  fake.bind(service);
  await service.init();
  await service.setConfig({ startApproval: "allow", ...config });
  const parent = fake.addThread("Build the feature", PROJECT.path);
  const attached = await service.attachMcpServers([], { mcpCapabilities: { http: true } });
  service.bindSession(attached.token!, parent.sessionId);
  const url = attached.servers[0].url as string;

  let rpcId = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const { result } = (await response.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    const text = result.content[0].text;
    if (result.isError) return { error: text } as Record<string, any>;
    return JSON.parse(text) as Record<string, any>;
  };

  /** A second endpoint bound to another thread, e.g. a task calling the tools itself. */
  const endpointFor = async (sessionId: string) => {
    const other = await service.attachMcpServers([], { mcpCapabilities: { http: true } });
    service.bindSession(other.token!, sessionId);
    const otherUrl = other.servers[0].url as string;
    return async (name: string, args: Record<string, unknown> = {}) => {
      const response = await fetch(otherUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      const { result } = (await response.json()) as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      };
      return result.isError
        ? ({ error: result.content[0].text } as Record<string, any>)
        : (JSON.parse(result.content[0].text) as Record<string, any>);
    };
  };

  return { service, store, fake, parent, call, endpointFor, db };
}

const settleNotes = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("starting tasks", () => {
  test("start_task opens a child thread, sends the brief and returns before the task finishes", async () => {
    const { fake, parent, call } = await setup();

    const started = await call("start_task", {
      agent_id: "codex",
      title: "Audit auth",
      task: "Find every place the session cookie is read.",
      done_when: ["each call site is listed with its path"],
    });

    expect(started.error).toBeUndefined();
    expect(started.status).toBe("running");
    expect(started.workspace).toBe("shared");
    expect(started.workspace_path).toBe(PROJECT.path);
    const child = fake.threads.get(started.thread_id)!;
    expect(child.title).toBe("Audit auth");
    expect(child.inFlight).toBe(true);

    const brief = fake.sent.find((p) => p.threadId === started.thread_id)!;
    expect(brief.origin).toBe("agent-task");
    expect(brief.message).toContain("Find every place the session cookie is read.");
    expect(brief.message).toContain("each call site is listed with its path");
    expect(brief.message).toContain('from the thread "Build the feature"');
    expect(brief.message).toContain("STATUS: needs_input");
    expect(parent.inFlight).toBe(false);
  });

  test("wait_for_tasks returns a receipt with the report, declared outcome and Pipper's facts", async () => {
    const { fake, call } = await setup();
    const started = await call("start_task", { agent_id: "codex", title: "Audit", task: "Audit." });

    const waiting = call("wait_for_tasks", { task_ids: [started.task_id], timeout_seconds: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.finish(started.thread_id, "Found 3 call sites in src/auth.\nSTATUS: blocked");
    const result = await waiting;

    expect(result.note).toBeUndefined();
    const [receipt] = result.tasks;
    expect(receipt).toMatchObject({
      task_id: started.task_id,
      thread_id: started.thread_id,
      status: "idle",
      outcome: "blocked",
      turns: 1,
      tool_calls: { edit: 2, read: 1 },
    });
    expect(receipt.report).toContain("Found 3 call sites");
  });

  test("a wait that times out says the tasks are still running", async () => {
    const { call } = await setup();
    const started = await call("start_task", { agent_id: "codex", title: "Slow", task: "Slow." });

    const result = await call("wait_for_tasks", {
      task_ids: [started.task_id],
      timeout_seconds: 1,
    });

    expect(result.tasks[0]).toMatchObject({ task_id: started.task_id, status: "running" });
    expect(result.note).toMatch(/still running/);
  });

  test("a retried start with the same request_key returns the first task", async () => {
    const { fake, call } = await setup();
    const args = { agent_id: "codex", title: "Once", task: "Once.", request_key: "k1" };

    const first = await call("start_task", args);
    const second = await call("start_task", args);

    expect(second.task_id).toBe(first.task_id);
    expect(fake.sent.filter((p) => p.origin === "agent-task")).toHaveLength(1);
  });

  test("unknown agents, empty briefs and bad workspaces are refused with what to do", async () => {
    const { fake, call } = await setup();

    expect((await call("start_task", { agent_id: "nope", title: "x", task: "x" })).error).toMatch(
      /Available: codex, claude/,
    );
    expect((await call("start_task", { agent_id: "codex", title: "x", task: " " })).error).toMatch(
      /task is required/,
    );
    expect(
      (await call("start_task", { agent_id: "codex", title: "x", task: "x", workspace: "/etc" }))
        .error,
    ).toMatch(/list_workspaces/);
    expect(fake.threads.size).toBe(1);
  });
});

describe("workspaces", () => {
  test('workspace "new" gives the task its own worktree and the receipt lists its changed files', async () => {
    const { fake, call } = await setup();
    fake.setChangedFiles(["src/auth.ts", "src/auth.test.ts"]);

    const started = await call("start_task", {
      agent_id: "codex",
      title: "Fix auth",
      task: "Fix it.",
      workspace: "new",
    });
    fake.finish(started.thread_id, "Fixed.\nSTATUS: done");
    const receipt = await call("get_task", { task_id: started.task_id });

    expect(started.workspace).toBe("new");
    expect(started.workspace_path).toMatch(/^\/worktrees\/fix-auth-/);
    expect(started.branch).toMatch(/^pipper\/fix-auth-/);
    expect(fake.threads.get(started.thread_id)!.cwd).toBe(started.workspace_path);
    expect(fake.sent[0].message).toContain("your own worktree and branch");
    expect(receipt.files_changed).toEqual(["src/auth.ts", "src/auth.test.ts"]);
  });

  test("a worktree path from list_workspaces is accepted and shared", async () => {
    const { fake, call } = await setup();

    const started = await call("start_task", {
      agent_id: "codex",
      title: "Share",
      task: "Share.",
      workspace: "/worktrees/shared-feature",
    });

    expect(started.workspace).toBe("path");
    expect(fake.threads.get(started.thread_id)!.cwd).toBe("/worktrees/shared-feature");
  });

  test("when the thread can't be created, the new worktree is rolled back and the task fails", async () => {
    const { fake, call, service } = await setup();
    fake.failCreateThread(new Error("agent not signed in"));

    const result = await call("start_task", {
      agent_id: "codex",
      title: "Broken",
      task: "x",
      workspace: "new",
    });

    expect(result.error).toMatch(/could not start: agent not signed in/);
    expect(fake.workspaces[0].rolledBack).toBe(true);
    expect(service.snapshots()[0]).toMatchObject({ status: "failed", childThreadId: null });
  });
});

describe("reporting back to the parent", () => {
  test("tasks that stop while nobody waits are batched into one note in the parent thread", async () => {
    const { fake, parent, call } = await setup();
    const a = await call("start_task", { agent_id: "codex", title: "A", task: "A." });
    const b = await call("start_task", { agent_id: "claude", title: "B", task: "B." });

    fake.finish(a.thread_id, "A is done.");
    fake.finish(b.thread_id, "B needs a decision.\nSTATUS: needs_input");
    await settleNotes();

    const notes = fake.sent.filter((p) => p.threadId === parent.threadId);
    expect(notes).toHaveLength(1);
    expect(notes[0].origin).toBe("agent-task");
    expect(notes[0].message).toContain("2 tasks you started have stopped");
    expect(notes[0].message).toContain(`A (task_id ${a.task_id}, codex): done`);
    expect(notes[0].message).toContain(`B (task_id ${b.task_id}, claude): needs_input`);
  });

  test("a note that races a user turn is queued as a follow-up, not dropped", async () => {
    const { fake, parent, call } = await setup();
    const started = await call("start_task", { agent_id: "codex", title: "A", task: "A." });
    fake.userTurn(parent.threadId);
    fake.staleInFlight.add(parent.threadId);

    fake.finish(started.thread_id, "Done.");
    await settleNotes();

    const notes = fake.sent.filter((p) => p.threadId === parent.threadId);
    expect(notes.map((n) => n.mode)).toEqual([null, "follow_up"]);
  });

  test("a task collected by wait_for_tasks gets no note", async () => {
    const { fake, parent, call } = await setup();
    const started = await call("start_task", { agent_id: "codex", title: "A", task: "A." });

    const waiting = call("wait_for_tasks", { timeout_seconds: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.finish(started.thread_id, "Done.");
    await waiting;
    await settleNotes();

    expect(fake.sent.filter((p) => p.threadId === parent.threadId)).toHaveLength(0);
  });

  test("notes pause after too many automated parent turns in a row, until the user speaks", async () => {
    const { fake, parent, call } = await setup({ maxAutomatedTurns: 1 });
    const first = await call("start_task", { agent_id: "codex", title: "One", task: "1" });
    const second = await call("start_task", { agent_id: "codex", title: "Two", task: "2" });

    fake.finish(first.thread_id, "one");
    await settleNotes();
    // The note started a parent turn; it ends, and the next task stops.
    fake.finish(parent.threadId, "ok");
    fake.finish(second.thread_id, "two");
    await settleNotes();
    expect(fake.sent.filter((p) => p.threadId === parent.threadId)).toHaveLength(1);

    // The user speaks; a later stop notifies again.
    fake.userTurn(parent.threadId);
    fake.finish(parent.threadId, "user turn done");
    await call("message_task", { task_id: second.task_id, message: "again" });
    fake.finish(second.thread_id, "two again");
    await settleNotes();
    expect(fake.sent.filter((p) => p.threadId === parent.threadId)).toHaveLength(2);
  });
});

describe("approvals", () => {
  test('with "ask", a declined start creates nothing and tells the agent not to retry', async () => {
    const { fake, parent, call, service } = await setup({ startApproval: "ask" });
    fake.setApproval("deny");

    const result = await call("start_task", { agent_id: "codex", title: "No", task: "x" });

    expect(result.error).toMatch(/declined/);
    expect(fake.approvals).toEqual([{ threadId: parent.threadId, title: "Start Codex task “No”" }]);
    expect(fake.threads.size).toBe(1);
    expect(service.snapshots()).toHaveLength(0);
  });

  test('"allow for this thread" stops asking for that thread', async () => {
    const { fake, call } = await setup({ startApproval: "ask" });
    fake.setApproval("always");

    await call("start_task", { agent_id: "codex", title: "1", task: "1" });
    await call("start_task", { agent_id: "codex", title: "2", task: "2" });

    expect(fake.approvals).toHaveLength(1);
  });

  test("a turn started by a note always asks before starting more work", async () => {
    const { fake, parent, call } = await setup({ startApproval: "allow" });
    const started = await call("start_task", { agent_id: "codex", title: "1", task: "1" });
    fake.finish(started.thread_id, "done");
    await settleNotes();
    expect(fake.threads.get(parent.threadId)!.inFlight).toBe(true); // the note's turn

    await call("start_task", { agent_id: "codex", title: "2", task: "2" });

    expect(fake.approvals).toHaveLength(1);
  });
});

describe("budgets", () => {
  test("the per-thread running limit is enforced with an actionable error", async () => {
    const { call } = await setup({ maxRunningPerThread: 1 });
    await call("start_task", { agent_id: "codex", title: "1", task: "1" });

    const result = await call("start_task", { agent_id: "codex", title: "2", task: "2" });

    expect(result.error).toMatch(/already has 1 running tasks \(limit 1\)\. Call wait_for_tasks/);
  });

  test("a task thread can't start tasks beyond the depth limit", async () => {
    const { fake, call, endpointFor } = await setup({ maxDepth: 1 });
    const started = await call("start_task", { agent_id: "codex", title: "Child", task: "x" });
    const childCall = await endpointFor(fake.threads.get(started.thread_id)!.sessionId);

    const result = await childCall("start_task", {
      agent_id: "codex",
      title: "Grandchild",
      task: "y",
    });

    expect(result.error).toMatch(/depth 1; tasks may go 1 deep/);
  });

  test("a turn past its time budget is cancelled and reported as timed out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fake, service, store } = await setup({ turnTimeoutMs: 60_000 });
    const parent = [...fake.threads.values()][0];
    const call = (service as any).callTool.bind(service);
    const token = [...(service as any).tokens.keys()][0];
    const started = JSON.parse(
      (await call(token, "start_task", { agent_id: "codex", title: "Slow", task: "x" })).content[0]
        .text,
    );
    expect(parent).toBeTruthy();

    vi.advanceTimersByTime(60_001);
    await Promise.resolve();

    expect(fake.cancelled).toContain(started.thread_id);
    expect(store.get(started.task_id)).toMatchObject({
      status: "timed_out",
      error: "The turn ran past its time budget.",
    });
  });
});

describe("conversations and control", () => {
  test("message_task on an idle task starts another turn and the receipt follows it", async () => {
    const { fake, call } = await setup();
    const started = await call("start_task", { agent_id: "codex", title: "Q", task: "x" });
    fake.finish(started.thread_id, "Which database?\nSTATUS: needs_input");
    expect((await call("get_task", { task_id: started.task_id })).outcome).toBe("needs_input");

    const sent = await call("message_task", { task_id: started.task_id, message: "Postgres." });
    expect(sent.delivered).toBe("started a new turn");
    expect((await call("get_task", { task_id: started.task_id })).status).toBe("running");
    fake.finish(started.thread_id, "Migrated to Postgres.");

    expect(await call("get_task", { task_id: started.task_id })).toMatchObject({
      status: "idle",
      outcome: "done",
      turns: 2,
    });
  });

  test("cancel_task stops the turn and the task reads as cancelled", async () => {
    const { fake, call } = await setup();
    const started = await call("start_task", { agent_id: "codex", title: "Stop", task: "x" });

    await call("cancel_task", { task_id: started.task_id });

    expect(fake.cancelled).toEqual([started.thread_id]);
    expect((await call("get_task", { task_id: started.task_id })).status).toBe("cancelled");
  });

  test("a task blocked on a permission prompt reads as waiting_for_permission", async () => {
    const { fake, call } = await setup();
    const started = await call("start_task", { agent_id: "codex", title: "Perm", task: "x" });
    fake.threads.get(started.thread_id)!.pendingPermission = true;

    expect((await call("list_tasks"))[0].status).toBe("waiting_for_permission");
  });

  test("a thread can only read and control tasks it started", async () => {
    const { fake, call, endpointFor } = await setup();
    const started = await call("start_task", { agent_id: "codex", title: "Mine", task: "x" });
    const stranger = fake.addThread("Someone else", PROJECT.path);
    const strangerCall = await endpointFor(stranger.sessionId);

    expect((await strangerCall("get_task", { task_id: started.task_id })).error).toMatch(
      /No task .* was started from this thread/,
    );
    expect(await strangerCall("list_tasks")).toEqual([]);
  });

  test("deleting the parent stops its running tasks; deleting a child settles its task", async () => {
    const { fake, parent, call, service, store } = await setup();
    const a = await call("start_task", { agent_id: "codex", title: "A", task: "a" });
    const b = await call("start_task", { agent_id: "codex", title: "B", task: "b" });

    service.onThreadDeleted(b.thread_id);
    expect(store.get(b.task_id)).toMatchObject({ status: "cancelled" });

    service.onThreadDeleted(parent.threadId);
    expect(fake.cancelled).toContain(a.thread_id);
    expect(store.get(a.task_id)!.status).toBe("cancelled");
  });
});

describe("child permissions", () => {
  function request(sessionId: string, kind: string, paths: string[]): acp.RequestPermissionRequest {
    return {
      sessionId,
      toolCall: {
        toolCallId: "call-1",
        title: "do it",
        kind,
        locations: paths.map((path) => ({ path })),
      } as acp.RequestPermissionRequest["toolCall"],
      options: [
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    };
  }

  test("edits inside the task's workspace are allowed once; everything else asks the user", async () => {
    const { fake, call, service } = await setup();
    const started = await call("start_task", {
      agent_id: "codex",
      title: "Edit",
      task: "x",
      workspace: "new",
    });
    const child = fake.threads.get(started.thread_id)!;
    const inside = `${started.workspace_path}/src/a.ts`;

    expect(service.autoPermissionResponse(request(child.sessionId, "edit", [inside]))).toEqual({
      outcome: { outcome: "selected", optionId: "once" },
    });
    expect(
      service.autoPermissionResponse(request(child.sessionId, "execute", [inside])),
    ).toBeNull();
    expect(service.autoPermissionResponse(request(child.sessionId, "delete", [inside]))).toBeNull();
    expect(
      service.autoPermissionResponse(request(child.sessionId, "edit", ["/etc/hosts"])),
    ).toBeNull();
    expect(
      service.autoPermissionResponse(
        request(child.sessionId, "edit", [`${started.workspace_path}/../x`]),
      ),
    ).toBeNull();
    expect(service.autoPermissionResponse(request(child.sessionId, "edit", []))).toBeNull();
  });

  test('with childPermissions "ask", and for threads that aren\'t tasks, nothing is auto-answered', async () => {
    const { fake, parent, call, service } = await setup({ childPermissions: "ask" });
    const started = await call("start_task", { agent_id: "codex", title: "Edit", task: "x" });
    const child = fake.threads.get(started.thread_id)!;

    expect(
      service.autoPermissionResponse(request(child.sessionId, "read", ["/repo/a.ts"])),
    ).toBeNull();
    await service.setConfig({ childPermissions: "workspace" });
    expect(
      service.autoPermissionResponse(request(parent.sessionId, "read", ["/repo/a.ts"])),
    ).toBeNull();
  });
});

describe("restart", () => {
  test("tasks a previous process left running come back as interrupted", async () => {
    const { store, call, db } = await setup();
    const started = await call("start_task", { agent_id: "codex", title: "Long", task: "x" });

    const fake = makeHost();
    const revived = new AgentTaskService({
      host: fake.host,
      store: new AgentTaskStore(() => db),
      baseDir: await mkdtemp(join(tmpdir(), "pipper-agent-tasks-")),
    });
    services.push(revived);
    fake.bind(revived);
    await revived.init();

    expect(store.get(started.task_id)!.status).toBe("interrupted");
    expect(fake.emitted.at(-1)!.map((t) => t.status)).toEqual(["interrupted"]);
  });
});

/** Calls wrap_up as the thread bound to `sessionId`; its result is plain text, not JSON. */
async function wrapUpAs(
  service: AgentTaskService,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const attached = await service.attachMcpServers([], { mcpCapabilities: { http: true } });
  service.bindSession(attached.token!, sessionId);
  const response = await fetch(attached.servers[0].url as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "wrap_up", arguments: args },
    }),
  });
  const { result } = (await response.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { text: result.content[0].text, isError: result.isError === true };
}

describe("wrap_up", () => {
  test("is listed alone when agent tasks are turned off, and still works", async () => {
    const { service, parent } = await setup({ enabled: false });
    const attached = await service.attachMcpServers([], { mcpCapabilities: { http: true } });
    expect(attached.token).not.toBeNull();
    const response = await fetch(attached.servers[0].url as string, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const { result } = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(result.tools.map((tool) => tool.name)).toEqual(["wrap_up"]);

    const done = await wrapUpAs(service, parent.sessionId, { recap: "Fixed the bug." });
    expect(done.isError).toBe(false);
    expect(done.text).toContain("closing message");
  });

  test("rejects input the card can't show, saying what to fix", async () => {
    const { service, parent } = await setup();
    const blockedWithoutAsk = await wrapUpAs(service, parent.sessionId, {
      recap: "Stuck.",
      blocked: true,
    });
    expect(blockedWithoutAsk).toMatchObject({ isError: true });
    expect(blockedWithoutAsk.text).toContain("blocked needs an ask");

    const actionsWithoutAsk = await wrapUpAs(service, parent.sessionId, {
      recap: "Done.",
      actions: [{ label: "Ship it" }],
    });
    expect(actionsWithoutAsk.text).toContain("add the ask");
  });

  test("a task's wrap_up sets its outcome and goes to the parent in the receipt and note", async () => {
    const { service, fake, parent, call } = await setup();
    const started = await call("start_task", { agent_id: "codex", title: "Pick a DB", task: "." });
    const child = fake.threads.get(started.thread_id)!;

    await wrapUpAs(service, child.sessionId, {
      recap: "Benchmarked SQLite and Postgres; both fit.",
      ask: "Which database should I wire in?",
      actions: [
        { label: "SQLite", message: "Use SQLite." },
        { label: "Postgres", message: "Use Postgres." },
      ],
      blocked: true,
    });
    // The free-text STATUS line loses to the structured wrap_up.
    fake.finish(started.thread_id, "Long report.\nSTATUS: done");
    await settleNotes();

    const receipt = await call("get_task", { task_id: started.task_id });
    expect(receipt).toMatchObject({
      outcome: "needs_input",
      recap: "Benchmarked SQLite and Postgres; both fit.",
      ask: "Which database should I wire in?",
      suggested_answers: ["Use SQLite.", "Use Postgres."],
      report: "Long report.\nSTATUS: done",
    });
    const note = fake.sent.find((p) => p.threadId === parent.threadId)!;
    expect(note.message).toContain("Benchmarked SQLite and Postgres; both fit.");
    expect(note.message).toContain("Asks: Which database should I wire in?");
    const snapshot = service.snapshots().find((task) => task.taskId === started.task_id)!;
    expect(snapshot.reportPreview).toBe("Benchmarked SQLite and Postgres; both fit.");
    expect(snapshot.nextStep?.blocked).toBe(true);
  });

  test("a later turn without wrap_up drops the earlier card and falls back to STATUS", async () => {
    const { service, fake, call } = await setup();
    const started = await call("start_task", { agent_id: "codex", title: "A", task: "." });
    const child = fake.threads.get(started.thread_id)!;
    await wrapUpAs(service, child.sessionId, {
      recap: "Need a name.",
      ask: "Name?",
      blocked: true,
    });
    fake.finish(started.thread_id, "Asked.");

    await call("message_task", { task_id: started.task_id, message: "Call it foo." });
    fake.finish(started.thread_id, "Renamed.\nSTATUS: blocked");

    const receipt = await call("get_task", { task_id: started.task_id });
    expect(receipt.outcome).toBe("blocked");
    expect(receipt.recap).toBeUndefined();
    expect(service.snapshots()[0].nextStep).toBeNull();
  });
});
