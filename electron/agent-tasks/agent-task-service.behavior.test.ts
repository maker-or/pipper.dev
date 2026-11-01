import { afterEach, describe, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

vi.mock("electron", () => ({
  app: { getPath: () => "/nonexistent-userdata" },
}));

import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import type { AgentTaskConfig, AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";
import type { Thread } from "../../contracts/threads.ts";
import type { AcpSessionSlice } from "../../src/lib/acp-session-reducer.ts";
import type { Worktree } from "../../contracts/worktrees.ts";
import type { WorkspaceGitStatus } from "../../contracts/git.ts";
import type { Confirmation } from "../operations/define.ts";
import { ProvenanceStore, ensureProvenanceSchema } from "../operations/provenance.ts";
import { configureWorkspaceOperations, type WorkspaceDeps } from "../operations/workspaces.ts";
import { configureThreadOperations, type ThreadDeps } from "../operations/threads.ts";
import {
  configureSettingsOperations,
  ensureSettingChangeSchema,
  SettingChangeStore,
} from "../operations/settings.ts";
import type { BrowserConfig } from "../../contracts/acp.ts";
import { pathKey } from "../worktree-manager.ts";
import { AgentTaskStore, ThreadProposalStore, ensureAgentTaskSchema } from "./agent-task-store.ts";
import {
  AgentTaskService,
  type AgentTaskHost,
  type AgentTaskServiceOptions,
  type ApprovalAnswer,
  type ConfirmationAnswer,
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
  agentId: string;
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
  const slices = new Map<string, AcpSessionSlice>();
  const sent: SentPrompt[] = [];
  const cancelled: string[] = [];
  const approvals: Array<{ threadId: string; title: string }> = [];
  const grants: Array<{ threadId: string; title: string; detail: Record<string, unknown> }> = [];
  const workspaces: Array<{ path: string; rolledBack: boolean }> = [];
  const worktrees: Worktree[] = [
    { path: PROJECT.path, branch: "main", head: "a1", isProjectRoot: true },
    {
      path: "/worktrees/shared-feature",
      branch: "pipper/shared-feature",
      head: "b2",
    },
  ];
  const removed: string[] = [];
  const deletedThreads: string[] = [];
  const confirmations: Array<{
    threadId: string;
    confirmation: Confirmation;
    answer: (answer: ConfirmationAnswer) => void;
  }> = [];
  let gitStatus: Partial<WorkspaceGitStatus> = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
  };
  const emitted: AgentTaskSnapshot[][] = [];
  let approvalAnswer: ApprovalAnswer = "once";
  let createThreadError: Error | null = null;
  let changed: string[] = [];
  let counter = 0;
  let service!: AgentTaskService;
  /** Threads whose in-flight check reads stale (a turn starts right after it). */
  const staleInFlight = new Set<string>();

  const addThread = (title: string, cwd: string, agentId = "claude"): FakeThread => {
    counter += 1;
    const thread: FakeThread = {
      threadId: `thread-${counter}`,
      sessionId: `session-${counter}`,
      title,
      agentId,
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
    sessionForToolCall: async (sessionIds) =>
      callingSession === undefined ? (sessionIds[0] ?? null) : callingSession,
    threadInfo: (threadId) => {
      const thread = threads.get(threadId);
      return thread
        ? {
            threadId,
            projectId: PROJECT.id,
            projectPath: PROJECT.path,
            title: thread.title,
            agentId: thread.agentId,
            cwd: thread.cwd,
          }
        : null;
    },
    openThreadInBackground: async (threadId) => {
      backgroundTabs.push(threadId);
    },
    listThreads: () =>
      [...threads.values()].reverse().map((thread) => ({
        threadId: thread.threadId,
        projectId: PROJECT.id,
        projectPath: PROJECT.path,
        title: thread.title,
        agentId: thread.agentId,
        cwd: thread.cwd,
      })),
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
    reloadThreadSession: async (id) => {
      reloaded.push(id);
    },
    threadSlice: (threadId) => slices.get(threadId) ?? null,
    lastTurn: (threadId) => {
      const thread = threads.get(threadId);
      return thread
        ? {
            text: thread.lastText,
            toolCalls: { edit: 2, read: 1 },
            nextStep: null,
          }
        : null;
    },
    hasPendingPermission: (threadId) => Boolean(threads.get(threadId)?.pendingPermission),
    requestApproval: async (threadId, { title, detail, once }) => {
      if (once) grants.push({ threadId, title, detail });
      else approvals.push({ threadId, title });
      return approvalAnswer;
    },
    requestConfirmation: (threadId, confirmation) =>
      new Promise<ConfirmationAnswer>((resolve) => {
        confirmations.push({ threadId, confirmation, answer: resolve });
      }),
    headSha: async () => "abc123",
    changedFiles: async () => changed,
    emitTasks: (tasks) => emitted.push(tasks),
  };

  const reloaded: string[] = [];
  /** What sessionForToolCall answers for a shared endpoint; undefined = the first. */
  let callingSession: string | null | undefined;
  const backgroundTabs: string[] = [];
  /** The thread operations' view of the app: these fake threads. */
  const threadRow = (id: string): Thread | null => {
    const thread = threads.get(id);
    return thread
      ? ({
          id: thread.threadId,
          project_id: PROJECT.id,
          agent_id: thread.agentId,
          title: thread.title,
          worktree_path: thread.cwd === PROJECT.path ? null : thread.cwd,
        } as Thread)
      : null;
  };
  const threadDeps = (): ThreadDeps => ({
    getThread: threadRow,
    listModels: async () => null,
    createThread: async ({ title, worktreePath, agentId }) => {
      if (createThreadError) throw createThreadError;
      const thread = addThread(
        title ?? "Untitled",
        worktreePath ?? PROJECT.path,
        agentId ?? "claude",
      );
      return threadRow(thread.threadId)!;
    },
    getProject: (id) =>
      id === PROJECT.id ? { id: PROJECT.id, path: PROJECT.path, name: "repo", icon: "" } : null,
    listWorktrees: async () => worktrees.map((worktree) => ({ ...worktree })),
    threadTitle: (id) => threads.get(id)?.title ?? null,
    isTurnInFlight: (id) => Boolean(threads.get(id)?.inFlight),
    deleteThread: async (id) => {
      deletedThreads.push(id);
      threads.delete(id);
      service.onThreadDeleted(id);
    },
    setThreadWorkspace: (id, worktreePath) => {
      const thread = threads.get(id);
      if (thread) thread.cwd = worktreePath ?? PROJECT.path;
    },
    reloadThreadSession: async (id) => {
      reloaded.push(id);
    },
    threadChanged: () => {},
    uncommittedFiles: async () => leftBehind,
  });
  let leftBehind: string[] = [];

  /** The operations' view of the app: these fake threads and worktrees. */
  const workspaceDeps = (db: DatabaseSync): WorkspaceDeps => ({
    listProjects: () => [{ id: PROJECT.id, path: PROJECT.path, name: "repo", icon: "" }],
    getProject: (id) =>
      id === PROJECT.id ? { id: PROJECT.id, path: PROJECT.path, name: "repo", icon: "" } : null,
    listWorktrees: async () => worktrees.map((worktree) => ({ ...worktree })),
    createWorkspace: async (request) => {
      const path = `/worktrees/${request.name}`;
      const workspace = { path, rolledBack: false };
      workspaces.push(workspace);
      const worktree: Worktree = {
        path,
        branch: `pipper/${request.name}`,
        head: "c3",
      };
      worktrees.push(worktree);
      return {
        project: { id: PROJECT.id, path: PROJECT.path, name: "repo", icon: "" },
        worktree,
        policy: request.setup ?? "source-only",
        setup: Promise.resolve({ status: "skipped" }),
        rollback: async () => {
          workspace.rolledBack = true;
          worktrees.splice(worktrees.indexOf(worktree), 1);
        },
      };
    },
    cancelWorkspaceSetup: async () => {},
    removeWorktree: async (_projectPath, path) => {
      const index = worktrees.findIndex((worktree) => worktree.path === path);
      const [target] = worktrees.splice(index, 1);
      removed.push(path);
      return target;
    },
    gitStatus: async () => ({ branch: "pipper/x", ...gitStatus }) as WorkspaceGitStatus,
    listThreads: () =>
      [...threads.values()].map(
        (thread) =>
          ({
            id: thread.threadId,
            project_id: PROJECT.id,
            title: thread.title,
            worktree_path: thread.cwd === PROJECT.path ? null : thread.cwd,
          }) as Thread,
      ),
    threadTitle: (threadId) => threads.get(threadId)?.title ?? null,
    deleteThread: async (threadId) => {
      deletedThreads.push(threadId);
      threads.delete(threadId);
    },
    activeThreadId: () => null,
    switchThread: async () => {},
    clearActiveThread: async () => {},
    removeThreadTabs: async () => ({
      openThreadIds: [],
      activeThreadId: null,
      threadSwitchHistory: [],
    }),
    readOpenTabsState: async () => ({
      openThreadIds: [],
      activeThreadId: null,
      threadSwitchHistory: [],
    }),
    broadcastTabs: () => {},
    broadcastDeleted: () => {},
    broadcastChanged: () => {},
    readWorkspaceSelections: async () => ({}),
    updateWorkspaceSelection: async () => {},
    provenance: new ProvenanceStore(() => db),
  });

  return {
    host,
    slices,
    workspaceDeps,
    threadDeps,
    reloaded,
    backgroundTabs,
    setCallingSession: (sessionId: string | null) => {
      callingSession = sessionId;
    },
    setLeftBehind: (files: string[]) => {
      leftBehind = files;
    },
    worktrees,
    removed,
    deletedThreads,
    confirmations,
    setGitStatus: (next: Partial<WorkspaceGitStatus>) => {
      gitStatus = { ...gitStatus, ...next };
    },
    threads,
    sent,
    cancelled,
    approvals,
    grants,
    workspaces,
    emitted,
    addThread,
    startTurn,
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
  configureWorkspaceOperations(null);
  configureThreadOperations(null);
  configureSettingsOperations(null);
  vi.useRealTimers();
});

async function setup(
  config: Partial<AgentTaskConfig> = {},
  extra: Pick<AgentTaskServiceOptions, "connectorRequests"> = {},
) {
  const db = new DatabaseSync(":memory:");
  ensureAgentTaskSchema(db);
  ensureProvenanceSchema(db);
  ensureSettingChangeSchema(db);
  const store = new AgentTaskStore(() => db);
  const fake = makeHost();
  configureWorkspaceOperations(fake.workspaceDeps(db));
  configureThreadOperations(fake.threadDeps());
  const settingsState = {
    browser: {
      enabled: false,
      pagesPerSession: 4,
      idleMinutes: 5,
      downloads: "ask",
    } as BrowserConfig,
  };
  configureSettingsOperations({
    getAgentTasks: () => service.getConfig(),
    setAgentTasks: (partial) => service.setConfig(partial),
    getBrowser: () => settingsState.browser,
    setBrowser: async (partial) =>
      (settingsState.browser = { ...settingsState.browser, ...partial }),
    getAutoInstall: () => true,
    setAutoInstall: () => {},
    changes: new SettingChangeStore(() => db),
  });
  const baseDir = await mkdtemp(join(tmpdir(), "pipper-agent-tasks-"));
  const proposals = new ThreadProposalStore(() => db);
  const service = new AgentTaskService({
    host: fake.host,
    store,
    proposals,
    baseDir,
    noteDelayMs: 5,
    ...extra,
  });
  services.push(service);
  fake.bind(service);
  await service.init();
  await service.setConfig({ startApproval: "allow", ...config });
  const parent = fake.addThread("Build the feature", PROJECT.path);
  const attached = await service.attachMcpServers([], {
    mcpCapabilities: { http: true },
  });
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
    const other = await service.attachMcpServers([], {
      mcpCapabilities: { http: true },
    });
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

    const started = await call("start_subthread", {
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

  test("get_thread gives the parent a receipt with the report, declared outcome and Pipper's facts", async () => {
    const { fake, call } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Audit",
      task: "Audit.",
    });
    fake.finish(started.thread_id, "Found 3 call sites in src/auth.\nSTATUS: blocked");

    const receipt = await call("get_thread", { thread_id: started.thread_id });

    expect(receipt).toMatchObject({
      thread_id: started.thread_id,
      status: "idle",
      outcome: "blocked",
      turns: 1,
      tool_calls: { edit: 2, read: 1 },
    });
    expect(receipt.report).toContain("Found 3 call sites");
  });

  test("get_thread with messages reads another thread's conversation, a page at a time", async () => {
    const { fake, call } = await setup();
    const other = fake.addThread("Siri intents", PROJECT.path);
    const entries: AcpSessionSlice["entries"] = [];
    for (let i = 0; i < 25; i++) {
      entries.push({ type: "user_text", id: `u${i}`, messageId: null, text: `question ${i}` });
      entries.push({ type: "agent_thought", id: `h${i}`, messageId: null, text: "thinking" });
      entries.push({ type: "agent_text", id: `a${i}`, messageId: null, text: `answer ` });
      entries.push({ type: "agent_text", id: `b${i}`, messageId: null, text: `${i}` });
      entries.push({ type: "tool_call", id: `c${i}`, toolCallId: `t${i}` });
    }
    const toolCalls = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `t${i}`,
        { toolCallId: `t${i}`, title: "Read intents.swift", kind: "read", status: "completed" },
      ]),
    );
    fake.slices.set(other.threadId, { entries, toolCalls } as unknown as AcpSessionSlice);

    const newest = await call("get_thread", { thread_id: other.threadId, messages: true });

    // 25 user questions, 25 joined answers and 25 tool lines; no thoughts.
    expect(newest.conversation.total).toBe(75);
    expect(newest.conversation.messages).toHaveLength(40);
    expect(newest.conversation.messages.at(-1)).toEqual({
      index: 74,
      role: "tool",
      text: "read: Read intents.swift",
    });
    expect(newest.conversation.messages.at(-2)).toMatchObject({ role: "agent", text: "answer 24" });
    expect(newest.conversation.next_before).toBe(35);

    const older = await call("get_thread", {
      thread_id: other.threadId,
      messages: true,
      before: newest.conversation.next_before,
    });
    expect(older.conversation.messages[0]).toEqual({
      index: 0,
      role: "user",
      text: "question 0",
    });
    expect(older.conversation.next_before).toBeNull();
  });

  test("get_thread says when a thread has no saved conversation, and omits it unless asked", async () => {
    const { fake, call } = await setup();
    const other = fake.addThread("Never opened", PROJECT.path);

    expect(await call("get_thread", { thread_id: other.threadId })).not.toHaveProperty(
      "conversation",
    );
    expect(await call("get_thread", { thread_id: other.threadId, messages: true })).toMatchObject({
      conversation: null,
      conversation_note: expect.stringMatching(/no saved conversation/),
    });
  });

  test("get_thread shows a subthread that is still working as running, without waiting", async () => {
    const { call } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Slow",
      task: "Slow.",
    });

    const result = await call("get_thread", { thread_id: started.thread_id });

    expect(result).toMatchObject({ thread_id: started.thread_id, status: "running" });
  });

  test("wait_for_tasks and list_agents are gone; start_subthread lists the agents", async () => {
    const { service, parent } = await setup();
    const attached = await service.attachMcpServers([], { mcpCapabilities: { http: true } });
    service.bindSession(attached.token!, parent.sessionId);
    const response = await fetch(attached.servers[0].url as string, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const { result } = (await response.json()) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    const names = result.tools.map((tool) => tool.name);

    expect(names).not.toContain("wait_for_tasks");
    expect(names).not.toContain("list_agents");
    const start = result.tools.find((tool) => tool.name === "start_subthread")!;
    expect(start.description).toMatch(/Available agents:\n- codex/);
    expect(start.description).toMatch(/Pipper sends your thread a note/);
  });

  test("a retried start with the same request_key returns the first task", async () => {
    const { fake, call } = await setup();
    const args = {
      agent_id: "codex",
      title: "Once",
      task: "Once.",
      request_key: "k1",
    };

    const first = await call("start_subthread", args);
    const second = await call("start_subthread", args);

    expect(second.thread_id).toBe(first.thread_id);
    expect(fake.sent.filter((p) => p.origin === "agent-task")).toHaveLength(1);
  });

  test("unknown agents, empty briefs and bad workspaces are refused with what to do", async () => {
    const { fake, call } = await setup();

    expect(
      (
        await call("start_subthread", {
          agent_id: "nope",
          title: "x",
          task: "x",
        })
      ).error,
    ).toMatch(/Available: codex, claude/);
    expect(
      (
        await call("start_subthread", {
          agent_id: "codex",
          title: "x",
          task: " ",
        })
      ).error,
    ).toMatch(/task is required/);
    expect(
      (
        await call("start_subthread", {
          agent_id: "codex",
          title: "x",
          task: "x",
          workspace: "/etc",
        })
      ).error,
    ).toMatch(/list_workspaces/);
    expect(fake.threads.size).toBe(1);
  });
});

describe("workspaces", () => {
  test('workspace "new" gives the task its own worktree and the receipt lists its changed files', async () => {
    const { fake, call } = await setup();
    fake.setChangedFiles(["src/auth.ts", "src/auth.test.ts"]);

    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Fix auth",
      task: "Fix it.",
      workspace: "new",
    });
    fake.finish(started.thread_id, "Fixed.\nSTATUS: done");
    const receipt = await call("get_thread", { thread_id: started.thread_id });

    expect(started.workspace).toBe("new");
    expect(started.workspace_path).toMatch(/^\/worktrees\/fix-auth-/);
    expect(started.branch).toMatch(/^pipper\/fix-auth-/);
    expect(fake.threads.get(started.thread_id)!.cwd).toBe(started.workspace_path);
    expect(fake.sent[0].message).toContain("your own worktree and branch");
    expect(receipt.files_changed).toEqual(["src/auth.ts", "src/auth.test.ts"]);
  });

  test("a worktree path from list_workspaces is accepted and shared", async () => {
    const { fake, call } = await setup();

    const started = await call("start_subthread", {
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

    const result = await call("start_subthread", {
      agent_id: "codex",
      title: "Broken",
      task: "x",
      workspace: "new",
    });

    expect(result.error).toMatch(/could not start: agent not signed in/);
    expect(fake.workspaces[0].rolledBack).toBe(true);
    expect(service.snapshots()[0]).toMatchObject({
      status: "failed",
      childThreadId: null,
    });
  });
});

describe("reporting back to the parent", () => {
  test("tasks that stop while nobody waits are batched into one note in the parent thread", async () => {
    const { fake, parent, call } = await setup();
    const a = await call("start_subthread", {
      agent_id: "codex",
      title: "A",
      task: "A.",
    });
    const b = await call("start_subthread", {
      agent_id: "claude",
      title: "B",
      task: "B.",
    });

    fake.finish(a.thread_id, "A is done.");
    fake.finish(b.thread_id, "B needs a decision.\nSTATUS: needs_input");
    await settleNotes();

    const notes = fake.sent.filter((p) => p.threadId === parent.threadId);
    expect(notes).toHaveLength(1);
    expect(notes[0].origin).toBe("agent-task");
    expect(notes[0].message).toContain("2 subthreads you started have stopped");
    expect(notes[0].message).toContain(`A (thread_id ${a.thread_id}, codex): done`);
    expect(notes[0].message).toContain(`B (thread_id ${b.thread_id}, claude): needs_input`);
  });

  test("a note that races a user turn is queued as a follow-up, not dropped", async () => {
    const { fake, parent, call } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "A",
      task: "A.",
    });
    fake.userTurn(parent.threadId);
    fake.staleInFlight.add(parent.threadId);

    fake.finish(started.thread_id, "Done.");
    await settleNotes();

    const notes = fake.sent.filter((p) => p.threadId === parent.threadId);
    expect(notes.map((n) => n.mode)).toEqual([null, "follow_up"]);
  });

  test("notes pause after too many automated parent turns in a row, until the user speaks", async () => {
    const { fake, parent, call } = await setup({ maxAutomatedTurns: 1 });
    const first = await call("start_subthread", {
      agent_id: "codex",
      title: "One",
      task: "1",
    });
    const second = await call("start_subthread", {
      agent_id: "codex",
      title: "Two",
      task: "2",
    });

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
    await call("message_thread", {
      thread_id: second.thread_id,
      message: "again",
    });
    fake.finish(second.thread_id, "two again");
    await settleNotes();
    expect(fake.sent.filter((p) => p.threadId === parent.threadId)).toHaveLength(2);
  });
});

describe("approvals", () => {
  test('with "ask", a declined start creates nothing and tells the agent not to retry', async () => {
    const { fake, parent, call, service } = await setup({
      startApproval: "ask",
    });
    fake.setApproval("deny");

    const result = await call("start_subthread", {
      agent_id: "codex",
      title: "No",
      task: "x",
    });

    expect(result.error).toMatch(/declined/);
    expect(fake.approvals).toEqual([{ threadId: parent.threadId, title: "Start Codex task “No”" }]);
    expect(fake.threads.size).toBe(1);
    expect(service.snapshots()).toHaveLength(0);
  });

  test('"allow for this thread" stops asking for that thread', async () => {
    const { fake, call } = await setup({ startApproval: "ask" });
    fake.setApproval("always");

    await call("start_subthread", { agent_id: "codex", title: "1", task: "1" });
    await call("start_subthread", { agent_id: "codex", title: "2", task: "2" });

    expect(fake.approvals).toHaveLength(1);
  });

  test("a turn started by a note always asks before starting more work", async () => {
    const { fake, parent, call } = await setup({ startApproval: "allow" });
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "1",
      task: "1",
    });
    fake.finish(started.thread_id, "done");
    await settleNotes();
    expect(fake.threads.get(parent.threadId)!.inFlight).toBe(true); // the note's turn

    await call("start_subthread", { agent_id: "codex", title: "2", task: "2" });

    expect(fake.approvals).toHaveLength(1);
  });
});

describe("budgets", () => {
  test("the per-thread running limit is enforced with an actionable error", async () => {
    const { call } = await setup({ maxRunningPerThread: 1 });
    await call("start_subthread", { agent_id: "codex", title: "1", task: "1" });

    const result = await call("start_subthread", {
      agent_id: "codex",
      title: "2",
      task: "2",
    });

    expect(result.error).toMatch(/already has 1 running tasks \(limit 1\)\. Wait for one to stop/);
  });

  test("a task thread can't start tasks beyond the depth limit", async () => {
    const { fake, call, endpointFor } = await setup({ maxDepth: 1 });
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Child",
      task: "x",
    });
    const childCall = await endpointFor(fake.threads.get(started.thread_id)!.sessionId);

    const result = await childCall("start_subthread", {
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
      (
        await call(token, "start_subthread", {
          agent_id: "codex",
          title: "Slow",
          task: "x",
        })
      ).content[0].text,
    );
    expect(parent).toBeTruthy();

    vi.advanceTimersByTime(60_001);
    await Promise.resolve();

    expect(fake.cancelled).toContain(started.thread_id);
    expect(store.byChildThread(started.thread_id)).toMatchObject({
      status: "timed_out",
      error: "The turn ran past its time budget.",
    });
  });
});

describe("conversations and control", () => {
  test("message_task on an idle task starts another turn and the receipt follows it", async () => {
    const { fake, call } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Q",
      task: "x",
    });
    fake.finish(started.thread_id, "Which database?\nSTATUS: needs_input");
    expect((await call("get_thread", { thread_id: started.thread_id })).outcome).toBe(
      "needs_input",
    );

    const sent = await call("message_thread", {
      thread_id: started.thread_id,
      message: "Postgres.",
    });
    expect(sent.delivered).toBe("started a new turn");
    expect((await call("get_thread", { thread_id: started.thread_id })).status).toBe("running");
    fake.finish(started.thread_id, "Migrated to Postgres.");

    expect(await call("get_thread", { thread_id: started.thread_id })).toMatchObject({
      status: "idle",
      outcome: "done",
      turns: 2,
    });
  });

  test("cancel_task stops the turn and the task reads as cancelled", async () => {
    const { fake, call } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Stop",
      task: "x",
    });

    await call("cancel_thread", { thread_id: started.thread_id });

    expect(fake.cancelled).toEqual([started.thread_id]);
    expect((await call("get_thread", { thread_id: started.thread_id })).status).toBe("cancelled");
  });

  test("a task blocked on a permission prompt reads as waiting_for_permission", async () => {
    const { fake, call } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Perm",
      task: "x",
    });
    fake.threads.get(started.thread_id)!.pendingPermission = true;

    expect((await call("list_threads"))[0].status).toBe("waiting_for_permission");
  });

  test("any thread can read another's status; only its parent gets the receipt", async () => {
    const { fake, parent, call, endpointFor } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Mine",
      task: "x",
    });
    const stranger = fake.addThread("Someone else", PROJECT.path);
    const strangerCall = await endpointFor(stranger.sessionId);

    const seen = await strangerCall("get_thread", {
      thread_id: started.thread_id,
    });
    expect(seen).toMatchObject({
      thread_id: started.thread_id,
      title: "Mine",
      agent_id: "codex",
      status: "running",
      parent_thread_id: parent.threadId,
    });
    expect(seen.report).toBeUndefined();
    expect(await strangerCall("list_threads")).toEqual([]);
    const everyone = (await strangerCall("list_threads", {
      scope: "project",
    })) as Array<{
      thread_id: string;
    }>;
    expect(everyone.map((t) => t.thread_id)).toEqual(
      expect.arrayContaining([parent.threadId, started.thread_id, stranger.threadId]),
    );
  });

  test("deleting the parent stops its running tasks; deleting a child settles its task", async () => {
    const { fake, parent, call, service, store } = await setup();
    const a = await call("start_subthread", {
      agent_id: "codex",
      title: "A",
      task: "a",
    });
    const b = await call("start_subthread", {
      agent_id: "codex",
      title: "B",
      task: "b",
    });

    service.onThreadDeleted(b.thread_id);
    expect(store.byChildThread(b.thread_id)).toMatchObject({
      status: "cancelled",
    });

    service.onThreadDeleted(parent.threadId);
    expect(fake.cancelled).toContain(a.thread_id);
    expect(store.byChildThread(a.thread_id)!.status).toBe("cancelled");
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
    const started = await call("start_subthread", {
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
    const { fake, parent, call, service } = await setup({
      childPermissions: "ask",
    });
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Edit",
      task: "x",
    });
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
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Long",
      task: "x",
    });

    const fake = makeHost();
    const revived = new AgentTaskService({
      host: fake.host,
      store: new AgentTaskStore(() => db),
      proposals: new ThreadProposalStore(() => db),
      baseDir: await mkdtemp(join(tmpdir(), "pipper-agent-tasks-")),
    });
    services.push(revived);
    fake.bind(revived);
    await revived.init();

    expect(store.byChildThread(started.thread_id)!.status).toBe("interrupted");
    expect(fake.emitted.at(-1)!.map((t) => t.status)).toEqual(["interrupted"]);
  });
});

/** Calls wrap_up as the thread bound to `sessionId`; its result is plain text, not JSON. */
async function wrapUpAs(
  service: AgentTaskService,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const attached = await service.attachMcpServers([], {
    mcpCapabilities: { http: true },
  });
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
    const attached = await service.attachMcpServers([], {
      mcpCapabilities: { http: true },
    });
    expect(attached.token).not.toBeNull();
    const response = await fetch(attached.servers[0].url as string, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const { result } = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(result.tools.map((tool) => tool.name)).toEqual(["wrap_up"]);

    const done = await wrapUpAs(service, parent.sessionId, {
      recap: "Fixed the bug.",
    });
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
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Pick a DB",
      task: ".",
    });
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

    const receipt = await call("get_thread", { thread_id: started.thread_id });
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
    const snapshot = service.snapshots().find((task) => task.childThreadId === started.thread_id)!;
    expect(snapshot.reportPreview).toBe("Benchmarked SQLite and Postgres; both fit.");
    expect(snapshot.nextStep?.blocked).toBe(true);
  });

  test("a later turn without wrap_up drops the earlier card and falls back to STATUS", async () => {
    const { service, fake, call } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "A",
      task: ".",
    });
    const child = fake.threads.get(started.thread_id)!;
    await wrapUpAs(service, child.sessionId, {
      recap: "Need a name.",
      ask: "Name?",
      blocked: true,
    });
    fake.finish(started.thread_id, "Asked.");

    await call("message_thread", {
      thread_id: started.thread_id,
      message: "Call it foo.",
    });
    fake.finish(started.thread_id, "Renamed.\nSTATUS: blocked");

    const receipt = await call("get_thread", { thread_id: started.thread_id });
    expect(receipt.outcome).toBe("blocked");
    expect(receipt.recap).toBeUndefined();
    expect(service.snapshots()[0].nextStep).toBeNull();
  });
});

describe("delete_workspace", () => {
  /** Let the confirmation's promise chain run (describe, delete, note). */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  test("a workspace the caller created, with no one else's threads, is deleted at once", async () => {
    const { fake, call, db } = await setup();
    const created = await call("create_workspace", { name: "scratch" });
    const store = new ProvenanceStore(() => db);
    expect(store.createdBy("workspace", pathKey(created.workspace_path))).toBe("thread-1");

    const result = await call("delete_workspace", {
      path: created.workspace_path,
    });

    expect(result).toEqual({ status: "deleted", path: created.workspace_path });
    expect(fake.removed).toEqual([created.workspace_path]);
    expect(fake.confirmations).toHaveLength(0);
    expect(store.createdBy("workspace", pathKey(created.workspace_path))).toBeNull();
  });

  test("a parent deletes its task's worktree, and the task's thread in it, without asking", async () => {
    const { fake, call } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Spike",
      task: "Try it.",
      workspace: "new",
    });
    fake.finish(started.thread_id, "Done.");

    const result = await call("delete_workspace", {
      path: started.workspace_path,
    });

    expect(result.status).toBe("deleted");
    expect(fake.deletedThreads).toEqual([started.thread_id]);
    expect(fake.confirmations).toHaveLength(0);
  });

  test("the user's workspace needs confirming; the card says what is lost, and a confirm deletes it", async () => {
    const { fake, parent, call } = await setup();
    fake.addThread("Fix billing", "/worktrees/shared-feature");
    fake.setGitStatus({ staged: 1, unstaged: 2, untracked: 1, ahead: 2 });

    const result = await call("delete_workspace", {
      path: "/worktrees/shared-feature",
    });

    expect(result.status).toBe("awaiting_confirmation");
    expect(fake.removed).toEqual([]);
    const [card] = fake.confirmations;
    expect(card.threadId).toBe(parent.threadId);
    expect(card.confirmation.title).toBe("Delete workspace pipper/shared-feature");
    expect(card.confirmation.impact).toEqual([
      "1 thread, including “Fix billing”",
      "uncommitted changes in 4 files",
      "2 commits not pushed on pipper/x",
    ]);

    card.answer("confirm");
    await settle();

    expect(fake.removed).toEqual(["/worktrees/shared-feature"]);
    const note = fake.sent.find((p) => p.threadId === parent.threadId)!;
    expect(note.message).toMatch(/^\[Pipper\] The user confirmed\. Deleted workspace/);
  });

  test("a decline deletes nothing and tells the agent not to retry", async () => {
    const { fake, parent, call } = await setup();
    await call("delete_workspace", { path: "/worktrees/shared-feature" });

    fake.confirmations[0].answer("deny");
    await settle();

    expect(fake.removed).toEqual([]);
    const note = fake.sent.find((p) => p.threadId === parent.threadId)!;
    expect(note.message).toContain("The user declined: delete workspace");
    expect(note.message).toContain("Don't retry it.");
  });

  test("when more would be lost by the time the user confirms, the card asks again", async () => {
    const { fake, call } = await setup();
    await call("delete_workspace", { path: "/worktrees/shared-feature" });
    fake.setGitStatus({ unstaged: 3 });

    fake.confirmations[0].answer("confirm");
    await settle();

    expect(fake.removed).toEqual([]);
    expect(fake.confirmations).toHaveLength(2);
    expect(fake.confirmations[1].confirmation.impact).toContain("uncommitted changes in 3 files");
    fake.confirmations[1].answer("confirm");
    await settle();
    expect(fake.removed).toEqual(["/worktrees/shared-feature"]);
  });

  test("while the card waits, wrap_up can't ask about it too; once answered it can ask again", async () => {
    const { fake, parent, call, service } = await setup();
    const pending = await call("delete_workspace", {
      path: "/worktrees/shared-feature",
    });
    expect(pending.message).toContain("That card ends your turn: don't call wrap_up");

    const doubled = await wrapUpAs(service, parent.sessionId, {
      recap: "Waiting for you to confirm the delete.",
      ask: "Confirm the delete?",
      actions: [{ label: "Delete it" }, { label: "Cancel" }],
    });
    expect(doubled.isError).toBe(true);
    expect(doubled.text).toContain("A confirm card is already waiting");
    expect(
      (
        await wrapUpAs(service, parent.sessionId, {
          recap: "Waiting for your confirmation.",
        })
      ).isError,
    ).toBe(false);

    fake.confirmations[0].answer("deny");
    await settle();
    expect(
      (
        await wrapUpAs(service, parent.sessionId, {
          recap: "Kept it.",
          ask: "Anything else?",
        })
      ).isError,
    ).toBe(false);
  });

  test("asking again while the card waits reuses it; once answered a new ask gets a new card", async () => {
    const { fake, call } = await setup();
    await call("delete_workspace", { path: "/worktrees/shared-feature" });

    const again = await call("delete_workspace", {
      path: "/worktrees/shared-feature",
    });

    expect(again.status).toBe("awaiting_confirmation");
    expect(again.message).toContain("still waiting");
    expect(fake.confirmations).toHaveLength(1);

    fake.confirmations[0].answer("deny");
    await settle();
    await call("delete_workspace", { path: "/worktrees/shared-feature" });
    expect(fake.confirmations).toHaveLength(2);
  });

  test("a card withdrawn unanswered deletes nothing and says so", async () => {
    const { fake, parent, call } = await setup();
    await call("delete_workspace", { path: "/worktrees/shared-feature" });

    fake.confirmations[0].answer("withdrawn");
    await settle();

    expect(fake.removed).toEqual([]);
    const note = fake.sent.find((p) => p.threadId === parent.threadId)!;
    expect(note.message).toContain("was withdrawn before anyone answered");
  });

  test("its own workspace, its parent's and the project root can't be deleted at all", async () => {
    const { fake, call, service } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Child",
      task: "x",
      workspace: "/worktrees/shared-feature",
    });
    const child = fake.threads.get(started.thread_id)!;
    const asChild = await (async () => {
      const attached = await service.attachMcpServers([], {
        mcpCapabilities: { http: true },
      });
      service.bindSession(attached.token!, child.sessionId);
      return async (args: Record<string, unknown>) => {
        const response = await fetch(attached.servers[0].url as string, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "delete_workspace", arguments: args },
          }),
        });
        const { result } = (await response.json()) as {
          result: { content: Array<{ text: string }> };
        };
        return result.content[0].text;
      };
    })();

    expect(await asChild({ path: "/worktrees/shared-feature" })).toBe(
      "You can't delete the workspace your own thread runs in.",
    );
    expect((await call("delete_workspace", { path: PROJECT.path })).error).toMatch(
      /project's root, which can't be deleted/,
    );
    expect(fake.confirmations).toHaveLength(0);
    expect(fake.removed).toEqual([]);
  });

  test("another project can be named by path", async () => {
    const { call } = await setup();
    const listed = await call("list_workspaces", { project: PROJECT.path });
    expect(listed.map((w: { path: string }) => w.path)).toContain("/worktrees/shared-feature");
    expect((await call("list_workspaces", { project: "/elsewhere" })).error).toBe(
      "Project not found: /elsewhere",
    );
  });
});

describe("threads", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  test("a subthread's brief names its parent, and its message reaches the parent signed by Pipper", async () => {
    const { fake, parent, call, endpointFor } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Pick",
      task: "x",
    });
    const brief = fake.sent.find((p) => p.threadId === started.thread_id)!;
    expect(brief.message).toContain(`(thread_id ${parent.threadId})`);

    const child = fake.threads.get(started.thread_id)!;
    const childCall = await endpointFor(child.sessionId);
    const sent = await childCall("message_thread", {
      thread_id: parent.threadId,
      message: "SQLite or Postgres?",
    });

    expect(sent).toMatchObject({
      thread_id: parent.threadId,
      delivered: "started a new turn",
    });
    const received = fake.sent.find((p) => p.threadId === parent.threadId)!;
    expect(received.message).toBe(
      `[Message from “Pick” (Codex), thread_id ${started.thread_id}]\n\nSQLite or Postgres?`,
    );
    expect(
      (
        await childCall("message_thread", {
          thread_id: child.threadId,
          message: "hi",
        })
      ).error,
    ).toMatch(/your own thread/);
  });

  test("threads that keep waking each other wait for the user", async () => {
    const { fake, call } = await setup({ maxAutomatedTurns: 1 });
    const other = fake.addThread("Other", PROJECT.path);

    await call("message_thread", { thread_id: other.threadId, message: "one" });
    fake.finish(other.threadId, "ok");
    const again = await call("message_thread", {
      thread_id: other.threadId,
      message: "two",
    });

    expect(again.error).toMatch(/waits for the user/);
  });

  test("cancel_thread stops any thread's turn, but not the caller's own", async () => {
    const { fake, parent, call } = await setup();
    const other = fake.addThread("Other", PROJECT.path);
    fake.userTurn(other.threadId);

    expect(await call("cancel_thread", { thread_id: other.threadId })).toEqual({
      thread_id: other.threadId,
      status: "cancelling",
    });
    expect(fake.cancelled).toEqual([other.threadId]);
    expect((await call("cancel_thread", { thread_id: parent.threadId })).error).toMatch(
      /your own thread/,
    );
  });

  test("delete_thread: a subthread goes at once, the user's thread needs the card", async () => {
    const { fake, parent, call } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Mine",
      task: "x",
    });
    fake.finish(started.thread_id, "Done.");

    expect(await call("delete_thread", { thread_id: started.thread_id })).toMatchObject({
      status: "deleted",
      title: "Mine",
    });
    expect(fake.deletedThreads).toEqual([started.thread_id]);

    const users = fake.addThread("User's work", PROJECT.path);
    const pending = await call("delete_thread", { thread_id: users.threadId });
    expect(pending.status).toBe("awaiting_confirmation");
    expect(fake.confirmations[0].confirmation.title).toBe("Delete thread “User's work”");
    expect((await call("delete_thread", { thread_id: users.threadId })).message).toContain(
      "still waiting",
    );
    expect(fake.confirmations).toHaveLength(1);

    fake.confirmations[0].answer("confirm");
    await settle();
    expect(fake.deletedThreads).toEqual([started.thread_id, users.threadId]);
    const notes = fake.sent.filter((p) => p.threadId === parent.threadId);
    expect(notes.some((p) => p.message.includes("Deleted thread “User's work”."))).toBe(true);
  });

  test("delete_thread refuses the caller's own thread and the thread that started it", async () => {
    const { fake, parent, call, endpointFor } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Kid",
      task: "x",
    });
    const childCall = await endpointFor(fake.threads.get(started.thread_id)!.sessionId);

    expect((await call("delete_thread", { thread_id: parent.threadId })).error).toBe(
      "You can't delete your own thread.",
    );
    expect((await childCall("delete_thread", { thread_id: parent.threadId })).error).toBe(
      "You can't delete a thread that started you.",
    );
    expect(fake.confirmations).toHaveLength(0);
  });

  test("move_thread on the caller's own running thread lands when its turn ends", async () => {
    const { fake, parent, call, service } = await setup();
    fake.setLeftBehind(["src/a.ts"]);
    parent.inFlight = true;

    const moved = await call("move_thread", {
      workspace: "/worktrees/shared-feature",
    });

    expect(moved).toMatchObject({
      status: "after_turn",
      workspace_path: "/worktrees/shared-feature",
      left_behind: ["src/a.ts"],
    });
    expect(moved.message).toContain("From your next turn you work in /worktrees/shared-feature");
    expect(parent.cwd).toBe(PROJECT.path);

    parent.inFlight = false;
    service.onTurnSettled(parent.threadId, { stopReason: "end_turn" });
    await settle();
    expect(parent.cwd).toBe("/worktrees/shared-feature");
    expect(fake.reloaded).toEqual([parent.threadId]);
  });

  test("an idle subthread moves at once and its receipt follows", async () => {
    const { fake, call } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Kid",
      task: "x",
    });
    fake.finish(started.thread_id, "Done.");

    const moved = await call("move_thread", {
      thread_id: started.thread_id,
      workspace: "/worktrees/shared-feature",
    });

    expect(moved.status).toBe("moved");
    expect((await call("get_thread", { thread_id: started.thread_id })).workspace_path).toBe(
      "/worktrees/shared-feature",
    );
  });

  test("move_thread refuses someone else's thread and unknown workspaces; moving back cancels", async () => {
    const { fake, parent, call, service } = await setup();
    const other = fake.addThread("Other", PROJECT.path);
    expect(
      (
        await call("move_thread", {
          thread_id: other.threadId,
          workspace: PROJECT.path,
        })
      ).error,
    ).toMatch(/only move your own thread/);
    expect((await call("move_thread", { workspace: "/nowhere" })).error).toMatch(
      /not a workspace of this thread's project/,
    );

    parent.inFlight = true;
    await call("move_thread", { workspace: "/worktrees/shared-feature" });
    expect((await call("move_thread", { workspace: PROJECT.path })).status).toBe("unchanged");
    parent.inFlight = false;
    service.onTurnSettled(parent.threadId, { stopReason: "end_turn" });
    await settle();
    expect(parent.cwd).toBe(PROJECT.path);
    expect(fake.reloaded).toEqual([]);
  });
});

describe("create_thread", () => {
  test("starts a top-level thread for the user in a background tab, with no depth limit", async () => {
    const { fake, call, endpointFor, service } = await setup({ maxDepth: 1 });
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Kid",
      task: "x",
    });
    fake.finish(started.thread_id, "Done.");
    // The user types into the subthread (depth 1, the limit) and asks for a new thread.
    fake.userTurn(started.thread_id);
    const childCall = await endpointFor(fake.threads.get(started.thread_id)!.sessionId);

    const created = await childCall("create_thread", {
      initiation: "user_asked",
      agent_id: "claude",
      title: "Explore the codebase",
      task: "Map the repository.",
    });

    expect(created).toMatchObject({
      status: "started",
      title: "Explore the codebase",
    });
    expect(fake.backgroundTabs).toEqual([created.thread_id]);
    const brief = fake.sent.find((p) => p.threadId === created.thread_id)!;
    expect(brief.message).toContain(`[Started by “Kid” (Codex), thread_id ${started.thread_id}`);
    expect(brief.message).toContain("Map the repository.");
    // Not a subthread: no receipt, not nested, not in the caller's list.
    expect(await childCall("list_threads")).toEqual([]);
    expect(service.snapshots().some((task) => task.childThreadId === created.thread_id)).toBe(
      false,
    );
  });

  test("a turn another thread started can't open threads for the user", async () => {
    const { fake, call, endpointFor } = await setup();
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Kid",
      task: "x",
    });
    const childCall = await endpointFor(fake.threads.get(started.thread_id)!.sessionId);

    const refused = await childCall("create_thread", {
      initiation: "user_asked",
      agent_id: "claude",
      title: "T",
      task: "x",
    });

    expect(refused.error).toMatch(/Only start a new thread when the user asked/);
    expect(refused.error).toMatch(/initiation "propose"/);
    expect(fake.backgroundTabs).toEqual([]);
  });

  test("a proposal starts nothing until the user presses Start, then runs as theirs", async () => {
    const { fake, call, parent, service } = await setup();
    const proposed = await call("create_thread", {
      initiation: "propose",
      agent_id: "claude",
      title: "Fix billing tests",
      task: "Make the billing suite pass.",
    });

    expect(proposed).toMatchObject({ status: "proposed", title: "Fix billing tests" });
    expect(proposed.thread_id).toBeUndefined();
    expect(fake.backgroundTabs).toEqual([]);
    const [open] = service.getProposals([proposed.proposal_id]);
    expect(open).toMatchObject({ state: "open", workspace: PROJECT.path, threadId: null });

    const started = await service.startProposal(proposed.proposal_id);
    expect(started.state).toBe("started");
    expect(fake.backgroundTabs).toEqual([started.threadId]);
    const brief = fake.sent.find((p) => p.threadId === started.threadId)!;
    expect(brief.message).toContain(
      `[Proposed by “Build the feature” (Claude), thread_id ${parent.threadId} and started by the user.`,
    );
    expect(brief.message).toContain("Make the billing suite pass.");

    // A second press returns the same thread.
    expect((await service.startProposal(proposed.proposal_id)).threadId).toBe(started.threadId);
    expect(fake.backgroundTabs).toHaveLength(1);
  });

  test("a turn another thread started may propose a thread; a dismissed one can't start", async () => {
    const { fake, call, endpointFor, service } = await setup();
    const started = await call("start_subthread", { agent_id: "codex", title: "Kid", task: "x" });
    const childCall = await endpointFor(fake.threads.get(started.thread_id)!.sessionId);

    const proposed = await childCall("create_thread", {
      initiation: "propose",
      agent_id: "claude",
      title: "Follow-up",
      task: "x",
    });
    expect(proposed.status).toBe("proposed");

    expect(service.dismissProposal(proposed.proposal_id).state).toBe("dismissed");
    expect((await service.startProposal(proposed.proposal_id)).state).toBe("dismissed");
    expect(fake.backgroundTabs).toEqual([]);
  });

  test("a proposal nobody answered expires after a week", async () => {
    const { call, service } = await setup();
    const proposed = await call("create_thread", {
      initiation: "propose",
      agent_id: "claude",
      title: "Old",
      task: "x",
    });
    const [proposal] = service.getProposals([proposed.proposal_id]);
    const db = (service as unknown as { proposals: { db: () => DatabaseSync } }).proposals.db();
    db.prepare("UPDATE thread_proposals SET created_at = ? WHERE id = ?").run(
      proposal!.createdAt - 8 * 24 * 60 * 60_000,
      proposed.proposal_id,
    );

    expect(service.getProposals([proposed.proposal_id])[0]!.state).toBe("expired");
    await expect(service.startProposal(proposed.proposal_id)).rejects.toThrow(/expired/);
  });

  test("its new workspace belongs to the user, so deleting it needs confirming", async () => {
    const { fake, call } = await setup();
    const created = await call("create_thread", {
      initiation: "user_asked",
      agent_id: "claude",
      title: "Own branch",
      task: "x",
      workspace: "new",
    });
    fake.finish(created.thread_id, "Started.");

    const pending = await call("delete_workspace", {
      path: created.workspace_path,
    });

    expect(pending.status).toBe("awaiting_confirmation");
    expect(fake.removed).toEqual([]);
  });
});

describe("an endpoint shared by a directory's sessions (OpenCode)", () => {
  const SHARE = "connection-1\0/repo";
  const http = { mcpCapabilities: { http: true } };

  test("only a directory's first session is given the server; the token goes with the last", async () => {
    const { service } = await setup();
    const before = service.endpointCount();
    const first = await service.attachMcpServers([], http, SHARE);
    service.bindSession(first.token!, "s-a");
    const second = await service.attachMcpServers([], http, SHARE);
    service.bindSession(second.token!, "s-b");

    expect(first.servers).toHaveLength(1);
    // OpenCode would re-add it and close the first session's connection.
    expect(second.servers).toEqual([]);
    expect(second.token).toBe(first.token);
    expect(service.endpointCount()).toBe(before + 1);

    service.releaseSessionMcp("s-a");
    expect(service.endpointCount()).toBe(before + 1);
    service.releaseSessionMcp("s-b");
    expect(service.endpointCount()).toBe(before);
  });

  test("a probe session that never binds doesn't take the shared endpoint down", async () => {
    const { service } = await setup();
    const live = await service.attachMcpServers([], http, SHARE);
    service.bindSession(live.token!, "s-a");
    const probe = await service.attachMcpServers([], http, SHARE);
    service.releaseTokenForSession(probe.token!);

    expect(service.endpointCount()).toBeGreaterThan(0);
    const again = await service.attachMcpServers([], http, SHARE);
    expect(again.token).toBe(live.token);
  });

  test("a call is attributed to the session whose agent made it, not the newest one", async () => {
    const { fake, parent, call, service } = await setup({ maxDepth: 1 });
    // The parent's user turn starts a subthread in the same folder; both share an endpoint.
    fake.userTurn(parent.threadId);
    const started = await call("start_subthread", {
      agent_id: "codex",
      title: "Kid",
      task: "x",
    });
    const attached = await service.attachMcpServers([], http, SHARE);
    service.bindSession(attached.token!, parent.sessionId);
    // The subthread's session registered last, as it does in OpenCode.
    service.bindSession(attached.token!, fake.threads.get(started.thread_id)!.sessionId);
    const shared = attached.servers[0].url as string;
    fake.setCallingSession(parent.sessionId);

    const response = await fetch(shared, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_thread",
          arguments: { initiation: "user_asked", agent_id: "claude", title: "T", task: "x" },
        },
      }),
    });
    const { result } = (await response.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "started",
    });
  });

  test("an ambiguous caller is refused with a retry hint, not guessed", async () => {
    const { fake, parent, service } = await setup();
    const attached = await service.attachMcpServers([], http, SHARE);
    service.bindSession(attached.token!, parent.sessionId);
    service.bindSession(attached.token!, "s-other");
    fake.setCallingSession(null);

    const response = await fetch(attached.servers[0].url as string, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_threads", arguments: {} },
      }),
    });
    const { result } = (await response.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/couldn't tell which thread made this call/);
  });
});

describe("a retried thread-starting call", () => {
  test("create_thread with the same title in one turn returns the first thread", async () => {
    const { fake, parent, call } = await setup();
    fake.userTurn(parent.threadId);
    const first = await call("create_thread", {
      initiation: "user_asked",
      agent_id: "codex",
      title: "Explore",
      task: "x",
    });
    // The reply was lost; the agent retries, even with another agent.
    const retry = await call("create_thread", {
      initiation: "user_asked",
      agent_id: "claude",
      title: "Explore ",
      task: "x",
    });

    expect(retry).toMatchObject({ status: "already_started", thread_id: first.thread_id });
    expect(fake.backgroundTabs).toEqual([first.thread_id]);
  });

  test("a new turn may start a thread with the same title again", async () => {
    const { fake, parent, call } = await setup();
    fake.userTurn(parent.threadId);
    const first = await call("create_thread", {
      initiation: "user_asked",
      agent_id: "codex",
      title: "Explore",
      task: "x",
    });
    fake.finish(parent.threadId, "Started.");
    fake.userTurn(parent.threadId);
    const again = await call("create_thread", {
      initiation: "user_asked",
      agent_id: "codex",
      title: "Explore",
      task: "x",
    });

    expect(again.status).toBe("started");
    expect(again.thread_id).not.toBe(first.thread_id);
  });

  test("start_subthread is deduplicated the same way", async () => {
    const { fake, parent, call, service } = await setup();
    fake.userTurn(parent.threadId);
    const first = await call("start_subthread", { agent_id: "codex", title: "Kid", task: "x" });
    const retry = await call("start_subthread", { agent_id: "codex", title: "Kid", task: "x" });

    expect(retry).toMatchObject({ status: "already_started", thread_id: first.thread_id });
    expect(service.snapshots()).toHaveLength(1);
  });
});

describe("settings tools", () => {
  test("get_settings reads; a tightening update applies at once without a card", async () => {
    const { fake, call, service } = await setup();

    expect((await call("get_settings")).agent_tasks).toMatchObject({ start_approval: "allow" });
    const result = await call("update_settings", { agent_tasks: { max_running_per_thread: 2 } });

    expect(result).toMatchObject({
      status: "changed",
      change_id: expect.any(String),
      changed: [{ setting: "agent_tasks.max_running_per_thread", from: 4, to: 2, applies: "now" }],
    });
    expect(service.getConfig().maxRunningPerThread).toBe(2);
    expect(fake.grants).toEqual([]);
  });

  test("a widening update waits for a one-click grant, and applies only if allowed", async () => {
    const { fake, parent, call, service } = await setup();
    fake.setApproval("deny");

    const declined = await call("update_settings", {
      browser: { enabled: true },
      agent_tasks: { max_depth: 2 },
    });

    expect(declined.error).toMatch(/didn't allow this change/);
    expect(fake.grants).toEqual([
      {
        threadId: parent.threadId,
        title: "Change Pipper settings",
        detail: {
          changes: ["Subthread depth: 1 level → 2 levels", "Browser for agents: off → on"],
        },
      },
    ]);
    expect(service.getConfig().maxDepth).toBe(1);

    fake.setApproval("once");
    const allowed = await call("update_settings", { browser: { enabled: true } });
    expect(allowed.status).toBe("changed");
    expect(allowed.next).toMatch(/apply to new threads/);
  });

  test("an update to the values already set changes nothing", async () => {
    const { call } = await setup();
    expect(await call("update_settings", { agent_tasks: { notify_parent: true } })).toMatchObject({
      status: "unchanged",
    });
  });
});

describe("connector tools", () => {
  const asks: Array<{ threadId: string; input: unknown }> = [];
  const connectorRequests = {
    ask: (threadId: string, input: unknown) => {
      asks.push({ threadId, input });
      return { request_id: "req-1", status: "awaiting_user" };
    },
  };

  test("add_connector passes the thread's ask on, only in a turn the user started", async () => {
    asks.length = 0;
    const { fake, parent, call } = await setup({}, { connectorRequests });

    expect(await call("add_connector", { catalog: "linear", reason: "File the bug" })).toEqual({
      request_id: "req-1",
      status: "awaiting_user",
    });
    expect(asks).toEqual([
      { threadId: parent.threadId, input: { catalog: "linear", reason: "File the bug" } },
    ]);
    expect((await call("add_connector", { catalog: "linear" })).error).toMatch(/reason/);

    void fake.startTurn(parent, "agent-task");
    expect(
      (await call("add_connector", { catalog: "linear", reason: "From a note" })).error,
    ).toMatch(/turn the user started/);
    expect(asks).toHaveLength(1);
  });

  test("a ready connector reloads the thread after its running turn, then sends the note", async () => {
    const { fake, parent, service } = await setup({}, { connectorRequests });
    void fake.startTurn(parent, "user");

    service.connectorReady(parent.threadId, "[Pipper] Linear is connected.");
    await settleNotes();
    expect(fake.reloaded).toEqual([]);

    parent.finishTurn!();
    service.onTurnSettled(parent.threadId, { stopReason: "end_turn" });
    await settleNotes();
    expect(fake.reloaded).toEqual([parent.threadId]);
    expect(fake.sent.at(-1)).toMatchObject({
      threadId: parent.threadId,
      message: "[Pipper] Linear is connected.",
      origin: "agent-task",
    });
  });
});
