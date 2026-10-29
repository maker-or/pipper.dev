import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { app } from "electron";
import type * as acp from "@agentclientprotocol/sdk";
import type { AgentCapabilities } from "@agentclientprotocol/sdk";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import { parseNextStep, type NextStep } from "../../contracts/next-step.ts";
import {
  callAsAgent,
  confirmationGrew,
  parseWith,
  type AgentContext,
  type Confirmation,
  type Operation,
} from "../operations/define.ts";
import {
  applyPendingMove,
  createThread as createThreadOperation,
  deleteThread as deleteThreadOperation,
  moveThread as moveThreadOperation,
  onThreadMoved,
  workspaceNameFor,
  type CreatedThread,
} from "../operations/threads.ts";
import {
  createWorkspace as createWorkspaceOperation,
  deleteWorkspace as deleteWorkspaceOperation,
  listWorkspaces as listWorkspacesOperation,
  releaseWorkspaceToUser,
  resolveProject,
} from "../operations/workspaces.ts";
import type {
  AgentTaskConfig,
  AgentTaskOutcome,
  AgentTaskSnapshot,
  AgentTaskWorkspaceMode,
} from "../../contracts/agent-tasks.ts";
import { McpHttpServer, type McpEndpoint, type McpToolResult } from "../mcp/mcp-http-server.ts";
import { ensureStdioProxyScript } from "../mcp/stdio-proxy.ts";
import {
  DEFAULT_AGENT_TASK_CONFIG,
  readAgentTaskConfig,
  writeAgentTaskConfig,
} from "./agent-task-config.ts";
import {
  MAX_REPORT_CHARS,
  buildReceipt,
  clip,
  composeBrief,
  composeParentNote,
  isActive,
  isSettled,
  parseOutcome,
  type TurnSummary,
} from "./agent-task-receipt.ts";
import type { AgentTaskRow, AgentTaskStore } from "./agent-task-store.ts";
import type { AnalyticsEventName, AnalyticsProperties } from "../analytics-schema.ts";
import { categorizeIntent } from "../analytics-sanitize.ts";
import {
  AGENT_TASK_SERVER_INSTRUCTIONS,
  AGENT_TASK_SERVER_NAME,
  CREATE_THREAD_INPUT,
  CREATE_WORKSPACE_INPUT,
  DELETE_WORKSPACE_INPUT,
  GET_THREAD_INPUT,
  LIST_THREADS_INPUT,
  LIST_WORKSPACES_INPUT,
  MESSAGE_THREAD_INPUT,
  MOVE_THREAD_INPUT,
  THREAD_ID_INPUT,
  ToolInputError,
  WRAP_UP_TOOL,
  agentTaskToolDefinitions,
  optionalString,
  optionalStringArray,
  requireString,
} from "./agent-task-tools.ts";

/** Who started a turn: the user (or any non-task caller), or this service. */
export type TurnOrigin = "user" | "agent-task";

export interface TaskThreadInfo {
  threadId: string;
  projectId: string;
  projectPath: string;
  title: string | null;
  agentId: string;
  /** Folder the thread's session works in. */
  cwd: string;
}

export type ApprovalAnswer = "once" | "always" | "deny";

/** The user's answer to a destructive call's confirm card. */
export type ConfirmationAnswer = "confirm" | "deny" | "withdrawn";

/**
 * What the connection manager provides. Kept small so this module never
 * imports the manager and tests can drive tasks with a fake host.
 */
export interface AgentTaskHost {
  listAgents(): AcpAgentDescriptor[];
  threadIdForSession(sessionId: string): string | null;
  /**
   * Of several sessions sharing one endpoint, the one making this tool call:
   * matched against the tool calls each session's agent reported over ACP.
   * Null when none can be told apart.
   */
  sessionForToolCall(
    sessionIds: string[],
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string | null>;
  threadInfo(threadId: string): TaskThreadInfo | null;
  /** Every thread in a project, newest first. */
  listThreads(projectId: string): TaskThreadInfo[];
  /** Add the thread's tab without switching to it. */
  openThreadInBackground(threadId: string): Promise<void>;
  /** Queue a prompt; resolves when that turn settles. */
  sendPrompt(
    threadId: string,
    message: string,
    opts: { mode: "follow_up" | "steer" | null; origin: TurnOrigin },
  ): Promise<void>;
  cancelTurn(threadId: string): Promise<void>;
  isTurnInFlight(threadId: string): boolean;
  lastTurn(threadId: string): TurnSummary | null;
  hasPendingPermission(threadId: string): boolean;
  /** Ask the user in the parent thread; resolves with their answer. */
  requestApproval(
    threadId: string,
    request: { title: string; detail: Record<string, unknown> },
  ): Promise<ApprovalAnswer>;
  /**
   * Show the hold-to-confirm card in the thread. Resolves when the user
   * answers, or "withdrawn" when the card goes away unanswered (the thread's
   * session closed). Never times out on its own.
   */
  requestConfirmation(threadId: string, confirmation: Confirmation): Promise<ConfirmationAnswer>;
  headSha(cwd: string): Promise<string | null>;
  changedFiles(cwd: string, sinceSha: string | null): Promise<string[]>;
  emitTasks(tasks: AgentTaskSnapshot[]): void;
}

export interface AgentTaskServiceOptions {
  host: AgentTaskHost;
  store: AgentTaskStore;
  /** Override the userData directory in tests. */
  baseDir?: string;
  /** Batch window for parent notes. */
  noteDelayMs?: number;
  /** Product analytics sink; omitted in tests. */
  captureAnalytics?: (name: AnalyticsEventName, properties: AnalyticsProperties) => void;
}

/** Tool kinds a child may run inside its own workspace without a prompt. */
const WORKSPACE_SAFE_KINDS: ReadonlySet<string> = new Set(["read", "search", "think", "edit"]);
const DEFAULT_NOTE_DELAY_MS = 1_500;
const MAX_DELIVERED_KEYS = 2_000;

function textResult(value: unknown): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(root, target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Client-hosted `pipper-agents` MCP server: lets a thread's agent start other
 * agents as tasks — durable child threads — and follow them up. See
 * docs/agent-tasks/design.md for the principles this enforces.
 */
export class AgentTaskService {
  private readonly host: AgentTaskHost;
  private readonly store: AgentTaskStore;
  private readonly baseDir: string | undefined;
  private readonly noteDelayMs: number;
  private readonly captureAnalytics: AgentTaskServiceOptions["captureAnalytics"];
  private config: AgentTaskConfig = { ...DEFAULT_AGENT_TASK_CONFIG };
  private readonly server = new McpHttpServer({
    name: AGENT_TASK_SERVER_NAME,
    version: "1.0.0",
    instructions: AGENT_TASK_SERVER_INSTRUCTIONS,
  });
  private started: Promise<string> | null = null;
  /**
   * Endpoint token → the ACP sessions bound to it, and attachments not yet
   * bound or released. One session per token, except for harnesses that keep
   * MCP servers per directory: their sessions in one directory share a token.
   */
  private readonly tokens = new Map<
    string,
    { sessions: Set<string>; pending: number; shareKey: string | null }
  >();
  /** Share key (connection + directory) → its shared token. */
  private readonly sharedTokens = new Map<string, string>();
  /**
   * Threads a caller started in its current turn, by tool and title. A reply
   * lost to a dropped connection makes agents retry; the retry gets the first
   * result instead of a second thread.
   */
  private readonly startedThisTurn = new Map<string, Map<string, Record<string, unknown>>>();
  /** Parent threads whose user chose "always allow" this run. */
  private readonly alwaysApproved = new Set<string>();
  /** Origin of each thread's current turn. */
  private readonly turnOrigins = new Map<string, TurnOrigin>();
  /** Parent turns in a row started by notes. */
  private readonly automatedStreaks = new Map<string, number>();
  private readonly turnStartedAt = new Map<string, number>();
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Why a task's current turn is being stopped, set before cancelling it. */
  private readonly stopReasons = new Map<string, "timed_out" | "cancelled">();
  /** The current turn's wrap_up per thread; the last call in a turn wins. */
  private readonly wrapUps = new Map<string, NextStep>();
  /** Confirm cards waiting for the user, per thread. */
  private readonly pendingConfirmations = new Map<string, number>();
  /** What each waiting card is for, so a repeated call reuses it. */
  private readonly pendingConfirmationKeys = new Set<string>();
  /** `${taskId}:${turns}` already returned to the parent in a note or get_thread. */
  private readonly delivered = new Set<string>();
  private readonly pendingNotes = new Map<string, Set<string>>();
  private readonly noteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(options: AgentTaskServiceOptions) {
    this.host = options.host;
    this.store = options.store;
    this.baseDir = options.baseDir;
    this.noteDelayMs = options.noteDelayMs ?? DEFAULT_NOTE_DELAY_MS;
    this.captureAnalytics = options.captureAnalytics;
    // A moved subthread works in its new folder; its receipt says so.
    this.stopListeningForMoves = onThreadMoved(({ threadId, cwd }) => {
      const task = this.store.byChildThread(threadId);
      if (!task) return;
      this.store.update(task.id, { workspacePath: cwd });
      this.emit();
    });
  }

  private readonly stopListeningForMoves: () => void;

  /** Load settings and mark tasks a previous process left running as interrupted. */
  async init(): Promise<void> {
    this.config = await readAgentTaskConfig(this.baseDir);
    this.store.markInterrupted();
    this.emit();
  }

  getConfig(): AgentTaskConfig {
    return { ...this.config };
  }

  async setConfig(partial: Partial<AgentTaskConfig>): Promise<AgentTaskConfig> {
    this.config = await writeAgentTaskConfig(partial, this.baseDir);
    return this.getConfig();
  }

  /** Agents the user allows as tasks (installed, non-mock unless listed). */
  availableAgents(): AcpAgentDescriptor[] {
    const allowed = this.config.allowedAgents;
    return this.host.listAgents().filter((agent) => {
      if (agent.available === false) return false;
      if (allowed === "all") return agent.installKind !== "mock";
      return allowed.includes(agent.id);
    });
  }

  snapshots(): AgentTaskSnapshot[] {
    return this.store.listRecent().map((task) => this.snapshot(task));
  }

  // ---------------------------------------------------------------------------
  // MCP endpoint lifecycle (same contract as the browser service)
  // ---------------------------------------------------------------------------

  /**
   * `shareKey` is for harnesses that register MCP servers per directory, not
   * per session (OpenCode). Every session it opens re-adds the servers it is
   * given, and re-adding one replaces the directory's client under that name,
   * closing its connection mid-call (even with identical config). So sessions
   * with one share key get one token, and only the first is given the server:
   * later sessions in that directory already see it. Callers are told apart
   * by their reported tool calls.
   */
  async attachMcpServers(
    baseServers: Array<Record<string, unknown>>,
    caps: AgentCapabilities,
    shareKey: string | null = null,
  ): Promise<{
    servers: Array<Record<string, unknown>>;
    token: string | null;
  }> {
    // Always attached: wrap_up serves every thread, task tools or not.
    if (this.disposed) {
      return { servers: baseServers, token: null };
    }
    const shimPath = await this.ensureStarted();
    let token = shareKey ? this.sharedTokens.get(shareKey) : undefined;
    const existing = token ? this.tokens.get(token) : undefined;
    if (token && existing) {
      existing.pending += 1;
      // Already registered in this directory by a live session.
      if (existing.sessions.size > 0) return { servers: baseServers, token };
    } else {
      token = randomUUID();
      this.tokens.set(token, { sessions: new Set(), pending: 1, shareKey });
      if (shareKey) this.sharedTokens.set(shareKey, token);
      this.server.register(token, this.endpointFor(token));
    }
    const url = this.server.urlFor(token);
    const entry: Record<string, unknown> = caps.mcpCapabilities?.http
      ? // `headers` is required by the ACP HttpMcpServer schema.
        { type: "http", name: AGENT_TASK_SERVER_NAME, url, headers: [] }
      : {
          type: "stdio",
          name: AGENT_TASK_SERVER_NAME,
          command: process.execPath,
          args: [shimPath, url],
          env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
        };
    return { servers: [...baseServers, entry], token };
  }

  bindSession(token: string, sessionId: string): void {
    const context = this.tokens.get(token);
    if (!context) return;
    context.pending = Math.max(0, context.pending - 1);
    context.sessions.add(sessionId);
  }

  /** Drop an attachment that never got a session (failed or probe sessions). */
  releaseTokenForSession(token: string): void {
    const context = this.tokens.get(token);
    if (!context) return;
    context.pending = Math.max(0, context.pending - 1);
    this.dropIfUnused(token);
  }

  releaseSessionMcp(sessionId: string): void {
    for (const [token, context] of this.tokens) {
      if (context.sessions.delete(sessionId)) this.dropIfUnused(token);
    }
  }

  private dropIfUnused(token: string): void {
    const context = this.tokens.get(token);
    if (!context || context.pending > 0 || context.sessions.size > 0) return;
    this.tokens.delete(token);
    if (context.shareKey && this.sharedTokens.get(context.shareKey) === token) {
      this.sharedTokens.delete(context.shareKey);
    }
    this.server.unregister(token);
  }

  endpointCount(): number {
    return this.tokens.size;
  }

  dispose(): void {
    this.disposed = true;
    this.stopListeningForMoves();
    for (const timer of this.turnTimers.values()) clearTimeout(timer);
    for (const timer of this.noteTimers.values()) clearTimeout(timer);
    this.turnTimers.clear();
    this.noteTimers.clear();
    this.server.close();
    this.tokens.clear();
    this.sharedTokens.clear();
    this.started = null;
  }

  private ensureStarted(): Promise<string> {
    if (!this.started) {
      this.started = (async () => {
        await this.server.start();
        const shimPath = join(this.baseDir ?? app.getPath("userData"), "mcp-stdio-proxy.mjs");
        return ensureStdioProxyScript(shimPath);
      })();
      this.started.catch(() => {
        this.started = null;
      });
    }
    return this.started;
  }

  private endpointFor(token: string): McpEndpoint {
    return {
      listTools: () => {
        const agents = this.config.enabled ? this.availableAgents() : [];
        return agents.length > 0
          ? [WRAP_UP_TOOL, ...agentTaskToolDefinitions(agents)]
          : [WRAP_UP_TOOL];
      },
      callTool: (name, args) => this.callTool(token, name, args),
    };
  }

  // ---------------------------------------------------------------------------
  // Turn and thread events from the connection manager
  // ---------------------------------------------------------------------------

  onTurnStarted(threadId: string, origin: TurnOrigin): void {
    this.turnOrigins.set(threadId, origin);
    this.startedThisTurn.delete(threadId);
    this.wrapUps.delete(threadId);
    this.automatedStreaks.set(
      threadId,
      origin === "agent-task" ? (this.automatedStreaks.get(threadId) ?? 0) + 1 : 0,
    );
    const task = this.store.byChildThread(threadId);
    if (!task) return;
    this.turnStartedAt.set(task.id, Date.now());
    this.stopReasons.delete(task.id);
    if (task.status !== "running") {
      this.store.update(task.id, { status: "running", error: null });
      this.emit();
    }
    this.armTurnTimer(task.id, threadId);
  }

  onTurnSettled(threadId: string, result: { stopReason?: string | null; error?: string | null }) {
    this.turnOrigins.delete(threadId);
    // A move that waited for this turn lands now (after the manager's own
    // bookkeeping for the settle has run).
    setTimeout(() => {
      void applyPendingMove(threadId).catch((error: unknown) => {
        console.error("[agent-tasks] could not apply a thread move:", error);
      });
    }, 0);
    const nextStep = this.wrapUps.get(threadId) ?? null;
    this.wrapUps.delete(threadId);
    const task = this.store.byChildThread(threadId);
    if (!task || !isActive(task.status)) return;
    this.clearTurnTimer(task.id);
    const forced = this.stopReasons.get(task.id);
    this.stopReasons.delete(task.id);
    const summary = this.host.lastTurn(threadId);
    const report = summary?.text ? clip(summary.text, MAX_REPORT_CHARS) : null;
    const status = forced
      ? forced
      : result.error
        ? "failed"
        : result.stopReason === "cancelled"
          ? "cancelled"
          : "idle";
    const updated = this.store.update(task.id, {
      status,
      outcome: status === "idle" ? turnOutcome(nextStep, report) : null,
      report: report ?? task.report,
      // A turn that didn't wrap up leaves no stale card from an earlier one.
      nextStep: status === "idle" ? nextStep : null,
      stopReason: result.stopReason ?? null,
      error: result.error ?? (forced === "timed_out" ? "The turn ran past its time budget." : null),
      turns: task.turns + 1,
    });
    this.emit();
    if (updated) this.taskSettled(updated);
  }

  /** A thread was deleted: settle tasks it ran, and stop tasks it started. */
  onThreadDeleted(threadId: string): void {
    const child = this.store.byChildThread(threadId);
    if (child && isActive(child.status)) {
      this.clearTurnTimer(child.id);
      const updated = this.store.update(child.id, {
        status: "cancelled",
        error: "The task's thread was deleted.",
      });
      if (updated) this.taskSettled(updated);
    }
    for (const task of this.store.listForParent(threadId, 500)) {
      if (!isActive(task.status) || !task.childThreadId) continue;
      this.stopReasons.set(task.id, "cancelled");
      void this.host.cancelTurn(task.childThreadId).catch(() => {});
    }
    this.alwaysApproved.delete(threadId);
    this.automatedStreaks.delete(threadId);
    this.emit();
  }

  /**
   * Permission policy for task threads. Null means "ask the user" — the
   * request then shows in the child thread like any other.
   */
  autoPermissionResponse(
    params: acp.RequestPermissionRequest,
  ): acp.RequestPermissionResponse | null {
    if (this.config.childPermissions !== "workspace") return null;
    const threadId = this.host.threadIdForSession(params.sessionId);
    const task = threadId ? this.store.byChildThread(threadId) : null;
    if (!task?.workspacePath) return null;
    const call = params.toolCall as {
      kind?: string | null;
      locations?: Array<{ path: string }>;
    };
    if (!call.kind || !WORKSPACE_SAFE_KINDS.has(call.kind)) return null;
    const locations = call.locations ?? [];
    if (call.kind !== "think" && locations.length === 0) return null;
    if (!locations.every((location) => within(task.workspacePath!, location.path))) return null;
    const allow = (params.options ?? []).find((option) => option.kind === "allow_once");
    return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : null;
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private async callTool(
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const sessionId = await this.callingSession(token, name, args);
    if (name === "wrap_up") return this.wrapUp(sessionId, args);
    if (!this.config.enabled) throw new Error("Agent tasks are turned off in Settings.");
    const caller = this.caller(sessionId);
    switch (name) {
      case "start_subthread":
        return textResult(
          await this.onceThisTurn(caller, name, args, () => this.startTask(caller, args)),
        );
      case "create_thread":
        return textResult(
          await this.onceThisTurn(caller, name, args, () => this.createUserThread(caller, args)),
        );
      case "get_thread":
        return textResult(await this.getThread(caller, args));
      case "list_threads":
        return textResult(this.listThreads(caller, args));
      case "message_thread":
        return textResult(await this.messageThread(caller, args));
      case "cancel_thread":
        return textResult(await this.cancelThread(caller, args));
      case "delete_thread":
        return textResult(await this.deleteThread(caller, args));
      case "move_thread":
        return textResult(await this.moveThread(caller, args));
      case "create_workspace":
        return textResult(await this.createWorkspace(caller, args));
      case "list_workspaces":
        return textResult(await this.listWorkspaces(caller, args));
      case "delete_workspace":
        return textResult(await this.deleteWorkspace(caller, args));
      default:
        throw new ToolInputError(`unknown tool: ${name}`);
    }
  }

  /** The session behind a call; for a shared token, the one whose agent made it. */
  private async callingSession(
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string | null> {
    const sessions = [...(this.tokens.get(token)?.sessions ?? [])];
    if (sessions.length <= 1) return sessions[0] ?? null;
    const sessionId = await this.host.sessionForToolCall(sessions, name, args);
    if (!sessionId) {
      throw new Error(
        "Pipper couldn't tell which thread made this call, because several threads in this " +
          "folder share the connection. Call the tool again.",
      );
    }
    return sessionId;
  }

  private wrapUp(sessionId: string | null, args: Record<string, unknown>): McpToolResult {
    const threadId = sessionId ? this.host.threadIdForSession(sessionId) : null;
    if (!threadId) throw new Error("Only a Pipper thread can use these tools.");
    const parsed = parseNextStep(args);
    if (!parsed.ok) throw new ToolInputError(`${parsed.error}. Fix it and call wrap_up again.`);
    // The confirm card already asks; a second question would offer buttons
    // that only send text back to the agent, which can't confirm anything.
    if (parsed.value.ask && (this.pendingConfirmations.get(threadId) ?? 0) > 0) {
      throw new ToolInputError(
        "A confirm card is already waiting for the user in this thread, and it is the question. " +
          "Skip wrap_up this turn, or call it again without ask or actions, and don't ask about " +
          "it in your reply.",
      );
    }
    this.wrapUps.set(threadId, parsed.value);
    const lines = [
      "Shown to the user as the next-step card under your reply. Now write your closing message: your answer in full, as the last thing you say this turn.",
    ];
    if (parsed.value.ask) {
      lines.push("The card asks your question; don't ask it again in the message.");
    }
    if (this.store.byChildThread(threadId)) {
      lines.push("This thread is a task: your recap and ask also go to the agent that started it.");
    }
    return { content: [{ type: "text", text: lines.join(" ") }] };
  }

  private caller(sessionId: string | null): TaskThreadInfo & { depth: number } {
    const threadId = sessionId ? this.host.threadIdForSession(sessionId) : null;
    const info = threadId ? this.host.threadInfo(threadId) : null;
    if (!info) throw new Error("Only a Pipper thread can use these tools.");
    return {
      ...info,
      depth: this.store.byChildThread(info.threadId)?.depth ?? 0,
    };
  }

  /** Run a thread-starting call once per caller, turn, tool and title. */
  private async onceThisTurn(
    caller: TaskThreadInfo,
    tool: string,
    args: Record<string, unknown>,
    start: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const title = typeof args.title === "string" ? args.title.trim().toLowerCase() : "";
    const key = `${tool}:${title}`;
    const earlier = title ? this.startedThisTurn.get(caller.threadId)?.get(key) : undefined;
    if (earlier) {
      return {
        ...earlier,
        status: "already_started",
        next:
          "You already started this thread in this turn; its first reply may not have reached " +
          "you. It is running, so don't start it again. Tell the user it has started.",
      };
    }
    const result = await start();
    if (title) {
      const started = this.startedThisTurn.get(caller.threadId) ?? new Map();
      started.set(key, result);
      this.startedThisTurn.set(caller.threadId, started);
    }
    return result;
  }

  private async startTask(
    caller: TaskThreadInfo & { depth: number },
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const agentId = requireString(args, "agent_id");
    const title = clip(requireString(args, "title"), 80);
    const brief = requireString(args, "task");
    const doneWhen = optionalStringArray(args, "done_when");
    const workspaceArg = optionalString(args, "workspace") ?? "shared";
    const model = optionalString(args, "model");
    const requestKey = optionalString(args, "request_key");
    const install = args.install_dependencies === true;

    if (requestKey) {
      const existing = this.store.byRequestKey(caller.threadId, requestKey);
      if (existing) return this.startResult(existing);
    }
    if (caller.depth + 1 > this.config.maxDepth) {
      throw new Error(
        `This thread is a task at depth ${caller.depth}; tasks may go ${this.config.maxDepth} deep (Settings → Agent tasks). Do the work yourself.`,
      );
    }
    const agents = this.availableAgents();
    if (!agents.some((agent) => agent.id === agentId)) {
      throw new ToolInputError(
        `Unknown or disallowed agent_id "${agentId}". Available: ${agents.map((a) => a.id).join(", ")}`,
      );
    }
    const { mode, path: targetPath } = await this.workspaceTarget(caller, workspaceArg);
    this.assertBudget(caller.threadId);

    await this.approve(caller, `Start ${this.agentName(agentId)} task “${title}”`, {
      agent: agentId,
      workspace: mode === "path" ? targetPath : mode,
      task: clip(brief, 2_000),
    });
    // The user may have taken a while; budgets could have filled meanwhile.
    this.assertBudget(caller.threadId);

    let task = this.store.insert({
      id: randomUUID(),
      parentThreadId: caller.threadId,
      childThreadId: null,
      projectId: caller.projectId,
      agentId,
      title,
      brief,
      requestKey,
      status: "starting",
      workspaceMode: mode,
      workspacePath: mode === "shared" ? caller.cwd : targetPath,
      branch: null,
      createdWorkspace: false,
      startSha: null,
      depth: caller.depth + 1,
    });
    this.emit();

    try {
      const created = await this.runOperation(
        createThreadOperation,
        {
          project: caller.projectId,
          agent: agentId,
          title,
          workspace: mode === "new" ? "new" : targetPath,
          setup: install ? "prepared" : "source-only",
          model,
          activation: "background",
        },
        caller,
      );
      const threadId = created.thread.id;
      task = this.store.update(task.id, {
        childThreadId: threadId,
        status: "running",
        workspacePath: created.cwd,
        ...(created.createdWorkspace
          ? {
              branch: created.createdWorkspace.branch,
              createdWorkspace: true,
              startSha: await this.host.headSha(created.cwd),
            }
          : {}),
      })!;
      this.emit();
      const message = composeBrief({
        parentThreadId: caller.threadId,
        parentTitle: caller.title,
        task: brief,
        doneWhen,
        workspacePath: created.cwd,
        ownWorkspace: mode === "new",
      });
      void this.host
        .sendPrompt(threadId, message, { mode: null, origin: "agent-task" })
        .catch((error: unknown) => this.promptFailed(task.id, threadId, error));
      return this.startResult(task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.update(task.id, { status: "failed", error: message });
      this.emit();
      throw new Error(`The task could not start: ${message}`);
    }
  }

  /**
   * Where a new thread runs, checked before any card is shown: "shared" is
   * the caller's own directory, "new" a worktree made for it, or a path of
   * this project's.
   */
  private async workspaceTarget(
    caller: TaskThreadInfo,
    workspace: string,
  ): Promise<{ mode: AgentTaskWorkspaceMode; path: string | null }> {
    if (workspace === "shared") return { mode: "shared", path: caller.cwd };
    if (workspace === "new") return { mode: "new", path: null };
    if (!isAbsolute(workspace)) {
      throw new ToolInputError('workspace must be "shared", "new" or an absolute worktree path.');
    }
    const workspaces = await this.runOperation(
      listWorkspacesOperation,
      { project: caller.projectId },
      caller,
    );
    const match = workspaces.find((w) => resolve(w.path) === resolve(workspace));
    if (!match) {
      throw new ToolInputError(
        `${workspace} is not a worktree of this project. Call list_workspaces or create_workspace.`,
      );
    }
    return { mode: "path", path: match.path };
  }

  private startResult(task: AgentTaskRow): Record<string, unknown> {
    return {
      thread_id: task.childThreadId,
      status: this.liveStatus(task),
      workspace: task.workspaceMode,
      workspace_path: task.workspacePath,
      ...(task.branch ? { branch: task.branch } : {}),
      next:
        "Keep working, or end your turn. When it stops, Pipper adds a note to your thread " +
        "with its receipt.",
    };
  }

  /** A prompt rejected before (or without) a turn the manager reported. */
  private promptFailed(taskId: string, threadId: string, error: unknown): void {
    const task = this.store.get(taskId);
    if (!task || !isActive(task.status) || this.host.isTurnInFlight(threadId)) return;
    this.clearTurnTimer(taskId);
    const forced = this.stopReasons.get(taskId);
    this.stopReasons.delete(taskId);
    const updated = this.store.update(taskId, {
      status: forced ?? "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    this.emit();
    if (updated) this.taskSettled(updated);
  }

  // ---------------------------------------------------------------------------
  // Threads
  // ---------------------------------------------------------------------------

  private requireThreadInfo(threadId: string): TaskThreadInfo {
    const info = this.host.threadInfo(threadId);
    if (!info) throw new ToolInputError(`No thread ${threadId}. Call list_threads.`);
    return info;
  }

  private threadStatus(threadId: string): string {
    if (!this.host.isTurnInFlight(threadId)) return "idle";
    return this.host.hasPendingPermission(threadId) ? "waiting_for_permission" : "running";
  }

  /**
   * A top-level thread for the user: no parent link, no depth limit, no
   * receipt. Only for a request the user made in this turn; a turn another
   * thread started can't open tabs on the user's behalf.
   */
  private async createUserThread(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = parseWith(CREATE_THREAD_INPUT, args);
    if (this.turnOrigins.get(caller.threadId) === "agent-task") {
      throw new Error(
        "Only start a new thread when the user asked for one in their own message; this turn " +
          "was started by another thread. Use start_subthread, or ask the user.",
      );
    }
    const agents = this.availableAgents();
    if (!agents.some((agent) => agent.id === input.agent_id)) {
      throw new ToolInputError(
        `Unknown or disallowed agent_id "${input.agent_id}". Available: ${agents.map((a) => a.id).join(", ")}`,
      );
    }
    const title = clip(input.title, 80);
    const { mode, path } = await this.workspaceTarget(caller, input.workspace ?? "shared");
    let created: CreatedThread;
    try {
      created = await this.runOperation(
        createThreadOperation,
        {
          project: caller.projectId,
          agent: input.agent_id,
          title,
          workspace: mode === "new" ? "new" : path,
          setup: input.install_dependencies ? "prepared" : "source-only",
          model: input.model ?? null,
          activation: "background",
        },
        caller,
      );
    } catch (error) {
      throw new Error(
        `The thread could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The thread is the user's, so a workspace made for it is too.
    if (created.createdWorkspace) releaseWorkspaceToUser(created.createdWorkspace.path);
    const threadId = created.thread.id;
    const cwd = created.cwd;
    await this.host.openThreadInBackground(threadId).catch((error: unknown) => {
      console.warn("[agent-tasks] could not open the new thread's tab:", error);
    });
    const sender = `“${caller.title ?? "Untitled"}” (${this.agentName(caller.agentId)}), thread_id ${caller.threadId}`;
    const brief = `[Started by ${sender} because the user asked for a separate thread. You work for the user now; the thread that started you won't follow up.]\n\n${input.task}`;
    void this.deliver(threadId, brief, null).catch((error: unknown) => {
      console.warn("[agent-tasks] could not send the new thread its brief:", error);
    });
    return {
      status: "started",
      thread_id: threadId,
      title,
      agent_id: input.agent_id,
      workspace_path: cwd,
      next:
        "It runs in its own tab and belongs to the user; you get no report from it. Pipper " +
        "shows the user a link to it under your reply, so don't paste its id. Tell the user it " +
        "has started, and carry on.",
    };
  }

  private async getThread(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { thread_id: threadId } = parseWith(GET_THREAD_INPUT, args);
    const info = this.requireThreadInfo(threadId);
    const task = this.store.byChildThread(threadId);
    const family = {
      parent_thread_id: task?.parentThreadId ?? null,
      children: this.store
        .listForParent(threadId)
        .map((child) => child.childThreadId)
        .filter((id): id is string => Boolean(id)),
    };
    if (task && task.parentThreadId === caller.threadId) {
      return { ...(await this.receipt(task)), ...family };
    }
    const summary = this.host.lastTurn(threadId);
    const nextStep = summary?.nextStep ?? task?.nextStep ?? null;
    return {
      thread_id: threadId,
      title: info.title,
      agent_id: info.agentId,
      project_id: info.projectId,
      workspace_path: info.cwd,
      status: this.threadStatus(threadId),
      ...family,
      last_turn: summary?.text ? clip(summary.text, MAX_REPORT_CHARS) : null,
      ...(nextStep
        ? {
            recap: nextStep.recap,
            ...(nextStep.ask ? { ask: nextStep.ask } : {}),
          }
        : {}),
    };
  }

  private listThreads(caller: TaskThreadInfo, args: Record<string, unknown>): unknown {
    const input = parseWith(LIST_THREADS_INPUT, args);
    if (input.scope !== "project") {
      return this.store.listForParent(caller.threadId).map((task) => ({
        thread_id: task.childThreadId,
        title: task.title,
        agent_id: task.agentId,
        status: this.liveStatus(task),
        outcome: task.outcome,
        turns: task.turns,
      }));
    }
    const projectId = input.project ? resolveProject(input.project).id : caller.projectId;
    return this.host
      .listThreads(projectId)
      .slice(0, MAX_LISTED_THREADS)
      .map((info) => ({
        thread_id: info.threadId,
        title: info.title,
        agent_id: info.agentId,
        workspace_path: info.cwd,
        status: this.threadStatus(info.threadId),
        parent_thread_id: this.store.byChildThread(info.threadId)?.parentThreadId ?? null,
        ...(info.threadId === caller.threadId ? { you: true } : {}),
      }));
  }

  private async messageThread(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = parseWith(MESSAGE_THREAD_INPUT, args);
    const threadId = input.thread_id;
    if (threadId === caller.threadId) {
      throw new ToolInputError("That's your own thread; just keep working.");
    }
    const target = this.requireThreadInfo(threadId);
    const task = this.store.byChildThread(threadId);
    if (task?.status === "starting") {
      throw new Error("That subthread is still starting; try again shortly.");
    }
    const ownSubthread = task?.parentThreadId === caller.threadId;
    // Waking an idle subthread adds work in parallel; messaging a running one doesn't.
    if (task && ownSubthread && !isActive(task.status)) this.assertBudget(caller.threadId);
    const inFlight = this.host.isTurnInFlight(threadId);
    // Loop guard: threads that keep waking each other wait for the user. A
    // parent driving its own subthread is bounded by the subthread budgets
    // instead (every subthread turn is automated).
    if (
      !ownSubthread &&
      !inFlight &&
      (this.automatedStreaks.get(threadId) ?? 0) >= this.config.maxAutomatedTurns
    ) {
      throw new Error(
        `"${target.title ?? threadId}" has run ${this.config.maxAutomatedTurns} turns in a row ` +
          "for other threads; it waits for the user before taking more messages.",
      );
    }
    const sender = `“${caller.title ?? "Untitled"}” (${this.agentName(caller.agentId)}), thread_id ${caller.threadId}`;
    const text = `[Message from ${sender}]\n\n${input.message}`;
    const steer = input.mode === "steer";
    void this.deliver(threadId, text, inFlight ? (steer ? "steer" : "follow_up") : null).catch(
      (error: unknown) => {
        if (task) this.promptFailed(task.id, threadId, error);
        else console.warn("[agent-tasks] could not deliver a message to a thread:", error);
      },
    );
    return {
      thread_id: threadId,
      delivered: inFlight
        ? steer
          ? "steered the current turn"
          : "queued after the current turn"
        : "started a new turn",
      next: "Don't wait for it. A reply, if any, arrives as a message to your thread.",
    };
  }

  private async cancelThread(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { thread_id: threadId } = parseWith(THREAD_ID_INPUT, args);
    if (threadId === caller.threadId) {
      throw new ToolInputError("That's your own thread; end your turn instead.");
    }
    this.requireThreadInfo(threadId);
    if (!this.host.isTurnInFlight(threadId)) {
      return {
        thread_id: threadId,
        status: "idle",
        note: "Nothing was running.",
      };
    }
    const task = this.store.byChildThread(threadId);
    if (task && isActive(task.status)) this.stopReasons.set(task.id, "cancelled");
    await this.host.cancelTurn(threadId);
    return { thread_id: threadId, status: "cancelling" };
  }

  private async deleteThread(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { thread_id: threadId } = parseWith(THREAD_ID_INPUT, args);
    const key = [caller.threadId, deleteThreadOperation.id, threadId].join("\u0000");
    if (this.pendingConfirmationKeys.has(key)) return stillWaiting();
    const outcome = await callAsAgent(
      deleteThreadOperation,
      { thread: threadId },
      this.agentContext(caller.threadId),
    );
    if (outcome.status === "done") {
      return {
        status: "deleted",
        thread_id: threadId,
        title: outcome.result.title,
      };
    }
    this.pendingConfirmationKeys.add(key);
    this.confirmThenRun(
      caller.threadId,
      deleteThreadOperation,
      outcome.input as Parameters<typeof deleteThreadOperation.run>[0],
      outcome.confirmation,
      (result) => `Deleted thread “${result.title}”.`,
      () => this.pendingConfirmationKeys.delete(key),
    );
    return awaitingConfirmation(outcome.confirmation, "deletes the thread");
  }

  private async moveThread(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = parseWith(MOVE_THREAD_INPUT, args);
    const threadId = input.thread_id ?? caller.threadId;
    const result = await this.runOperation(
      moveThreadOperation,
      { thread: threadId, workspace: input.workspace },
      caller,
    );
    const own = threadId === caller.threadId;
    const when =
      result.status === "unchanged"
        ? `The thread already works in ${result.workspace}.`
        : result.status === "after_turn"
          ? own
            ? `Moved to ${result.workspace}. From your next turn you work in ${result.cwd}; for the rest of this turn, use paths inside it.`
            : `That thread moves to ${result.workspace} (${result.cwd}) when its current turn ends.`
          : `Moved to ${result.workspace}; the thread works in ${result.cwd} from its next turn.`;
    return {
      status: result.status,
      thread_id: threadId,
      workspace_path: result.cwd,
      message: when,
      ...(result.leftBehind.length > 0
        ? {
            left_behind: result.leftBehind.slice(0, 50),
            note: "These uncommitted changes stay in the old workspace; commit, stash or redo them deliberately.",
          }
        : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Workspaces (electron/operations/workspaces.ts)
  // ---------------------------------------------------------------------------

  private async listWorkspaces(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const input = parseWith(LIST_WORKSPACES_INPUT, args);
    const worktrees = await this.runOperation(
      listWorkspacesOperation,
      { project: input.project ?? caller.projectId },
      caller,
    );
    return worktrees.map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch,
      isProjectRoot: Boolean(worktree.isProjectRoot),
    }));
  }

  private async createWorkspace(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = parseWith(CREATE_WORKSPACE_INPUT, args);
    const created = await this.runOperation(
      createWorkspaceOperation,
      {
        project: input.project ?? caller.projectId,
        name: workspaceNameFor(input.name),
        setup: input.install_dependencies ? "prepared" : "source-only",
        activation: "background",
      },
      caller,
    );
    return {
      workspace_path: created.worktree.path,
      branch: created.worktree.branch,
    };
  }

  private async deleteWorkspace(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = parseWith(DELETE_WORKSPACE_INPUT, args);
    const key = [
      caller.threadId,
      deleteWorkspaceOperation.id,
      input.project ?? caller.projectId,
      resolve(input.path),
    ].join("\u0000");
    if (this.pendingConfirmationKeys.has(key)) return stillWaiting();
    const ctx = this.agentContext(caller.threadId);
    const outcome = await callAsAgent(
      deleteWorkspaceOperation,
      { project: input.project ?? caller.projectId, path: input.path },
      ctx,
    );
    if (outcome.status === "done") {
      return { status: "deleted", path: outcome.result.path };
    }
    this.pendingConfirmationKeys.add(key);
    this.confirmThenRun(
      caller.threadId,
      deleteWorkspaceOperation,
      outcome.input as Parameters<typeof deleteWorkspaceOperation.run>[0],
      outcome.confirmation,
      (result) => `Deleted workspace ${result.path}.`,
      () => this.pendingConfirmationKeys.delete(key),
    );
    return awaitingConfirmation(outcome.confirmation, "deletes the workspace");
  }

  /** Run an operation as this thread's agent; destructive ones go through deleteWorkspace. */
  private async runOperation<I, O>(
    operation: Operation<I, O>,
    raw: unknown,
    caller: TaskThreadInfo,
  ): Promise<O> {
    const outcome = await callAsAgent(operation, raw, this.agentContext(caller.threadId));
    if (outcome.status !== "done") throw new Error(`${operation.id} needs confirmation`);
    return outcome.result;
  }

  /** Who the caller is: its thread, the threads above it, and what it owns. */
  private agentContext(threadId: string): AgentContext {
    const lineage = [threadId];
    for (let parent = this.parentOf(threadId); parent && lineage.length < 64; ) {
      if (lineage.includes(parent)) break;
      lineage.push(parent);
      parent = this.parentOf(parent);
    }
    return {
      caller: { kind: "agent", threadId },
      lineage,
      owns: (candidate) => {
        for (let current = candidate, steps = 0; current && steps < 64; steps++) {
          if (current === threadId) return true;
          current = this.parentOf(current);
        }
        return false;
      },
    };
  }

  private parentOf(threadId: string): string | null {
    return this.store.byChildThread(threadId)?.parentThreadId ?? null;
  }

  /**
   * Ask the user with the hold-to-confirm card, then run the operation
   * ourselves and tell the agent in a note. The agent's call already
   * returned, so nothing here can run twice. When the impact grew while the
   * card waited, show the new impact and ask again instead of running.
   */
  private confirmThenRun<I, O>(
    threadId: string,
    operation: Operation<I, O>,
    input: I,
    confirmation: Confirmation,
    describeResult: (result: O) => string,
    settled: () => void,
  ): void {
    const note = (text: string) => {
      if (this.disposed || !this.host.threadInfo(threadId)) return;
      const inFlight = this.host.isTurnInFlight(threadId);
      void this.deliver(threadId, `[Pipper] ${text}`, inFlight ? "follow_up" : null).catch(
        (error: unknown) => {
          console.warn("[agent-tasks] could not deliver a confirmation note:", error);
        },
      );
    };
    const ask = async (seen: Confirmation): Promise<void> => {
      this.pendingConfirmations.set(threadId, (this.pendingConfirmations.get(threadId) ?? 0) + 1);
      let answer: ConfirmationAnswer;
      try {
        answer = await this.host.requestConfirmation(threadId, seen);
      } finally {
        const left = (this.pendingConfirmations.get(threadId) ?? 1) - 1;
        if (left > 0) this.pendingConfirmations.set(threadId, left);
        else this.pendingConfirmations.delete(threadId);
      }
      if (answer === "deny") {
        note(`The user declined: ${lowerFirst(seen.title)}. Don't retry it.`);
        return;
      }
      if (answer === "withdrawn") {
        note(`Your request to ${lowerFirst(seen.title)} was withdrawn before anyone answered.`);
        return;
      }
      const ctx = this.agentContext(threadId);
      const now = await operation.describe?.(input, ctx);
      if (now && confirmationGrew(seen, now)) {
        await ask(now);
        return;
      }
      const result = await operation.run(input, ctx);
      note(`The user confirmed. ${describeResult(result)}`);
    };
    void ask(confirmation)
      .catch((error: unknown) => {
        note(
          `The user confirmed, but it failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(settled);
  }

  // ---------------------------------------------------------------------------
  // Policy, budgets, receipts, notes
  // ---------------------------------------------------------------------------

  private async approve(
    caller: TaskThreadInfo,
    title: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    // A turn a note started never starts work on its own: chains need a person.
    const automated = this.turnOrigins.get(caller.threadId) === "agent-task";
    const needsAsk =
      automated ||
      (this.config.startApproval === "ask" && !this.alwaysApproved.has(caller.threadId));
    if (!needsAsk) return;
    const answer = await this.host.requestApproval(caller.threadId, {
      title,
      detail,
    });
    if (answer === "deny") {
      throw new Error("The user declined. Don't retry this; do the work yourself or ask the user.");
    }
    if (answer === "always" && !automated) this.alwaysApproved.add(caller.threadId);
  }

  private assertBudget(parentThreadId: string): void {
    const active = this.store.listActive();
    const mine = active.filter((task) => task.parentThreadId === parentThreadId).length;
    if (mine >= this.config.maxRunningPerThread) {
      throw new Error(
        `This thread already has ${mine} running tasks (limit ${this.config.maxRunningPerThread}). Wait for one to stop (Pipper adds a note) before starting more.`,
      );
    }
    if (active.length >= this.config.maxRunningTotal) {
      throw new Error(
        `Pipper is running ${active.length} tasks (limit ${this.config.maxRunningTotal}). Wait for some to finish.`,
      );
    }
  }

  private armTurnTimer(taskId: string, threadId: string): void {
    this.clearTurnTimer(taskId);
    const timer = setTimeout(() => {
      this.turnTimers.delete(taskId);
      this.stopReasons.set(taskId, "timed_out");
      void this.host.cancelTurn(threadId).catch(() => {});
    }, this.config.turnTimeoutMs);
    timer.unref?.();
    this.turnTimers.set(taskId, timer);
  }

  private clearTurnTimer(taskId: string): void {
    const timer = this.turnTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.turnTimers.delete(taskId);
  }

  private liveStatus(task: AgentTaskRow): string {
    return task.childThreadId &&
      task.status === "running" &&
      this.host.hasPendingPermission(task.childThreadId)
      ? "waiting_for_permission"
      : task.status;
  }

  private async receipt(task: AgentTaskRow): Promise<Record<string, unknown>> {
    let filesChanged: string[] | null = null;
    if (task.workspaceMode === "new" && task.workspacePath) {
      filesChanged = await this.host
        .changedFiles(task.workspacePath, task.startSha)
        .catch(() => null);
    }
    const startedAt = this.turnStartedAt.get(task.id);
    const summary =
      task.childThreadId && isSettled(task.status) ? this.host.lastTurn(task.childThreadId) : null;
    return buildReceipt(task, {
      waitingForPermission: this.liveStatus(task) === "waiting_for_permission",
      filesChanged,
      toolCalls: summary?.toolCalls ?? null,
      durationMs: startedAt != null && isSettled(task.status) ? task.updatedAt - startedAt : null,
    });
  }

  private taskSettled(task: AgentTaskRow): void {
    const startedAt = this.turnStartedAt.get(task.id);
    this.captureAnalytics?.("agent_task_settled", {
      agent_id: task.agentId,
      status: task.status,
      depth: task.depth,
      ...(startedAt != null ? { execution_duration_ms: Date.now() - startedAt } : {}),
      task_category: categorizeIntent(task.brief),
    });
    if (!this.config.notifyParent || this.disposed) return;
    let pending = this.pendingNotes.get(task.parentThreadId);
    if (!pending) {
      pending = new Set();
      this.pendingNotes.set(task.parentThreadId, pending);
    }
    pending.add(task.id);
    if (this.noteTimers.has(task.parentThreadId)) return;
    const timer = setTimeout(() => this.flushNotes(task.parentThreadId), this.noteDelayMs);
    timer.unref?.();
    this.noteTimers.set(task.parentThreadId, timer);
  }

  private flushNotes(parentThreadId: string): void {
    this.noteTimers.delete(parentThreadId);
    const ids = this.pendingNotes.get(parentThreadId);
    this.pendingNotes.delete(parentThreadId);
    if (!ids || this.disposed || !this.host.threadInfo(parentThreadId)) return;
    const tasks = [...ids]
      .map((id) => this.store.get(id))
      .filter((task): task is AgentTaskRow => {
        if (!task || !isSettled(task.status)) return false;
        return !this.delivered.has(`${task.id}:${task.turns}`);
      });
    if (tasks.length === 0) return;
    // Loop guard: after N automated parent turns in a row, wait for the user.
    if ((this.automatedStreaks.get(parentThreadId) ?? 0) >= this.config.maxAutomatedTurns) return;
    for (const task of tasks) this.markDelivered(task);
    const inFlight = this.host.isTurnInFlight(parentThreadId);
    void this.deliver(
      parentThreadId,
      composeParentNote(tasks),
      inFlight ? "follow_up" : null,
    ).catch((error: unknown) => {
      console.warn("[agent-tasks] could not deliver a note to the parent thread:", error);
    });
  }

  /**
   * Send a service prompt. A turn can start between the in-flight check and
   * the send (the user typed); the manager then refuses a plain prompt, so
   * queue it as a follow-up instead of dropping it.
   */
  private async deliver(
    threadId: string,
    message: string,
    mode: "follow_up" | "steer" | null,
  ): Promise<void> {
    try {
      await this.host.sendPrompt(threadId, message, {
        mode,
        origin: "agent-task",
      });
    } catch (error) {
      if (mode !== null || !(error instanceof Error) || !/already in flight/i.test(error.message)) {
        throw error;
      }
      await this.host.sendPrompt(threadId, message, {
        mode: "follow_up",
        origin: "agent-task",
      });
    }
  }

  private markDelivered(task: AgentTaskRow): void {
    this.delivered.add(`${task.id}:${task.turns}`);
    // Bounded: only recent turns can still be waiting for a note.
    if (this.delivered.size > MAX_DELIVERED_KEYS) {
      this.delivered.delete(this.delivered.values().next().value!);
    }
  }

  private agentName(agentId: string): string {
    return this.host.listAgents().find((agent) => agent.id === agentId)?.displayName ?? agentId;
  }

  private snapshot(task: AgentTaskRow): AgentTaskSnapshot {
    return {
      taskId: task.id,
      parentThreadId: task.parentThreadId,
      childThreadId: task.childThreadId,
      projectId: task.projectId,
      agentId: task.agentId,
      title: task.title,
      status: task.status,
      outcome: task.outcome,
      waitingForPermission: this.liveStatus(task) === "waiting_for_permission",
      workspaceMode: task.workspaceMode,
      workspacePath: task.workspacePath,
      branch: task.branch,
      depth: task.depth,
      turns: task.turns,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      reportPreview:
        task.nextStep?.recap ?? (task.report ? clip(task.report.replace(/\s+/g, " "), 200) : null),
      nextStep: task.nextStep,
      error: task.error,
    };
  }

  private emit(): void {
    if (this.disposed) return;
    this.host.emitTasks(this.snapshots());
  }
}

/**
 * A settled turn's outcome: from its wrap_up when it called one, else from the
 * report's STATUS line (agents that can't reach the MCP server still write it).
 */
function turnOutcome(nextStep: NextStep | null, report: string | null): AgentTaskOutcome {
  if (nextStep) return nextStep.blocked ? "needs_input" : "done";
  return report ? parseOutcome(report) : "done";
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

const MAX_LISTED_THREADS = 100;

/** The result of a destructive call that now waits on the user's confirm card. */
function awaitingConfirmation(confirmation: Confirmation, effect: string): Record<string, unknown> {
  return {
    status: "awaiting_confirmation",
    message:
      "Pipper is showing the user a confirm card for this in your thread. That card ends " +
      "your turn: don't call wrap_up, and don't ask about it yourself. Say in one line that " +
      `it's waiting for the user, then stop. If they confirm, Pipper ${effect} itself, and ` +
      "either way you get the outcome as a note. Don't retry or poll.",
    confirmation: { title: confirmation.title, impact: confirmation.impact },
  };
}

function stillWaiting(): Record<string, unknown> {
  return {
    status: "awaiting_confirmation",
    message:
      "The confirm card for this is still waiting for the user; Pipper didn't add another. " +
      "Don't call wrap_up or call this again; say in one line that it's waiting for them.",
  };
}
