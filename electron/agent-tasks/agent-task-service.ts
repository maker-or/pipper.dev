import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { app } from "electron";
import type * as acp from "@agentclientprotocol/sdk";
import type { AgentCapabilities } from "@agentclientprotocol/sdk";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import { parseNextStep, type NextStep } from "../../contracts/next-step.ts";
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
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
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
  /** Folder the thread's session works in. */
  cwd: string;
}

export interface TaskWorkspace {
  path: string;
  branch: string | null;
  /** Remove what this creation made; only while no thread is bound to it. */
  rollback: () => Promise<void>;
}

export type ApprovalAnswer = "once" | "always" | "deny";

/**
 * What the connection manager provides. Kept small so this module never
 * imports the manager and tests can drive tasks with a fake host.
 */
export interface AgentTaskHost {
  listAgents(): AcpAgentDescriptor[];
  threadIdForSession(sessionId: string): string | null;
  threadInfo(threadId: string): TaskThreadInfo | null;
  createWorkspace(
    projectId: string,
    name: string,
    installDependencies: boolean,
  ): Promise<TaskWorkspace>;
  listWorkspaces(
    projectId: string,
  ): Promise<Array<{ path: string; branch: string | null; isProjectRoot: boolean }>>;
  /** Create a background thread bound to `cwd` (a worktree, or the project root). */
  createThread(input: {
    projectId: string;
    agentId: string;
    title: string;
    cwd: string;
    model: string | null;
  }): Promise<{ threadId: string }>;
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

interface Waiter {
  parentThreadId: string;
  taskIds: Set<string>;
  until: "all" | "any";
  resolve: () => void;
}

/** Tool kinds a child may run inside its own workspace without a prompt. */
const WORKSPACE_SAFE_KINDS: ReadonlySet<string> = new Set(["read", "search", "think", "edit"]);
const DEFAULT_NOTE_DELAY_MS = 1_500;
const MAX_DELIVERED_KEYS = 2_000;

function textResult(value: unknown): McpToolResult {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(root, target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function workspaceName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `${slug || "task"}-${randomBytes(2).toString("hex")}`;
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
  /** Endpoint token → the ACP session it was bound to. */
  private readonly tokens = new Map<string, { sessionId: string | null }>();
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
  private readonly waiters = new Set<Waiter>();
  /** `${taskId}:${turns}` already returned to the parent by a wait or note. */
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
  }

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

  async attachMcpServers(
    baseServers: Array<Record<string, unknown>>,
    caps: AgentCapabilities,
  ): Promise<{ servers: Array<Record<string, unknown>>; token: string | null }> {
    // Always attached: wrap_up serves every thread, task tools or not.
    if (this.disposed) {
      return { servers: baseServers, token: null };
    }
    const shimPath = await this.ensureStarted();
    const token = randomUUID();
    this.tokens.set(token, { sessionId: null });
    this.server.register(token, this.endpointFor(token));
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
    if (context) context.sessionId = sessionId;
  }

  releaseTokenForSession(token: string): void {
    this.tokens.delete(token);
    this.server.unregister(token);
  }

  releaseSessionMcp(sessionId: string): void {
    for (const [token, context] of this.tokens) {
      if (context.sessionId === sessionId) this.releaseTokenForSession(token);
    }
  }

  endpointCount(): number {
    return this.tokens.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.turnTimers.values()) clearTimeout(timer);
    for (const timer of this.noteTimers.values()) clearTimeout(timer);
    this.turnTimers.clear();
    this.noteTimers.clear();
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
    this.server.close();
    this.tokens.clear();
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
    for (const waiter of this.waiters) {
      if (waiter.parentThreadId === threadId) {
        this.waiters.delete(waiter);
        waiter.resolve();
      }
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
    const call = params.toolCall as { kind?: string | null; locations?: Array<{ path: string }> };
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
    if (name === "wrap_up") return this.wrapUp(token, args);
    if (!this.config.enabled) throw new Error("Agent tasks are turned off in Settings.");
    const caller = this.caller(token);
    switch (name) {
      case "list_agents":
        return textResult(
          this.availableAgents().map((a) => ({
            id: a.id,
            name: a.displayName,
            description: a.description ?? null,
          })),
        );
      case "start_task":
        return textResult(await this.startTask(caller, args));
      case "wait_for_tasks":
        return textResult(await this.waitForTasks(caller, args));
      case "get_task":
        return textResult(await this.receipt(this.ownTask(caller, requireString(args, "task_id"))));
      case "list_tasks":
        return textResult(
          this.store.listForParent(caller.threadId).map((task) => ({
            task_id: task.id,
            thread_id: task.childThreadId,
            title: task.title,
            agent_id: task.agentId,
            status: this.liveStatus(task),
            outcome: task.outcome,
            turns: task.turns,
          })),
        );
      case "message_task":
        return textResult(await this.messageTask(caller, args));
      case "cancel_task":
        return textResult(await this.cancelTask(caller, requireString(args, "task_id")));
      case "create_workspace":
        return textResult(await this.createWorkspace(caller, args));
      case "list_workspaces":
        return textResult(await this.host.listWorkspaces(caller.projectId));
      default:
        throw new ToolInputError(`unknown tool: ${name}`);
    }
  }

  private wrapUp(token: string, args: Record<string, unknown>): McpToolResult {
    const sessionId = this.tokens.get(token)?.sessionId;
    const threadId = sessionId ? this.host.threadIdForSession(sessionId) : null;
    if (!threadId) throw new Error("Only a Pipper thread can use these tools.");
    const parsed = parseNextStep(args);
    if (!parsed.ok) throw new ToolInputError(`${parsed.error}. Fix it and call wrap_up again.`);
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

  private caller(token: string): TaskThreadInfo & { depth: number } {
    const sessionId = this.tokens.get(token)?.sessionId;
    const threadId = sessionId ? this.host.threadIdForSession(sessionId) : null;
    const info = threadId ? this.host.threadInfo(threadId) : null;
    if (!info) throw new Error("Only a Pipper thread can use these tools.");
    return { ...info, depth: this.store.byChildThread(info.threadId)?.depth ?? 0 };
  }

  private ownTask(caller: TaskThreadInfo, taskId: string): AgentTaskRow {
    const task = this.store.get(taskId);
    if (!task || task.parentThreadId !== caller.threadId) {
      throw new ToolInputError(`No task ${taskId} was started from this thread. Call list_tasks.`);
    }
    return task;
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
    let mode: AgentTaskWorkspaceMode;
    let targetPath: string | null = null;
    if (workspaceArg === "shared" || workspaceArg === "new") mode = workspaceArg;
    else if (isAbsolute(workspaceArg)) {
      mode = "path";
      const workspaces = await this.host.listWorkspaces(caller.projectId);
      const match = workspaces.find((w) => resolve(w.path) === resolve(workspaceArg));
      if (!match) {
        throw new ToolInputError(
          `${workspaceArg} is not a worktree of this project. Call list_workspaces or create_workspace.`,
        );
      }
      targetPath = match.path;
    } else {
      throw new ToolInputError('workspace must be "shared", "new" or an absolute worktree path.');
    }
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

    let workspace: TaskWorkspace | null = null;
    try {
      let cwd = mode === "shared" ? caller.cwd : targetPath!;
      if (mode === "new") {
        workspace = await this.host.createWorkspace(
          caller.projectId,
          workspaceName(title),
          install,
        );
        cwd = workspace.path;
        task = this.store.update(task.id, {
          workspacePath: cwd,
          branch: workspace.branch,
          createdWorkspace: true,
          startSha: await this.host.headSha(cwd),
        })!;
      }
      const { threadId } = await this.host.createThread({
        projectId: caller.projectId,
        agentId,
        title,
        cwd,
        model,
      });
      task = this.store.update(task.id, { childThreadId: threadId, status: "running" })!;
      this.emit();
      const message = composeBrief({
        parentTitle: caller.title,
        task: brief,
        doneWhen,
        workspacePath: cwd,
        ownWorkspace: mode === "new",
      });
      void this.host
        .sendPrompt(threadId, message, { mode: null, origin: "agent-task" })
        .catch((error: unknown) => this.promptFailed(task.id, threadId, error));
      return this.startResult(task);
    } catch (error) {
      if (workspace && !this.store.get(task.id)?.childThreadId) {
        await workspace.rollback().catch(() => {});
      }
      const message = error instanceof Error ? error.message : String(error);
      this.store.update(task.id, { status: "failed", error: message });
      this.emit();
      throw new Error(`The task could not start: ${message}`);
    }
  }

  private startResult(task: AgentTaskRow): Record<string, unknown> {
    return {
      task_id: task.id,
      thread_id: task.childThreadId,
      status: this.liveStatus(task),
      workspace: task.workspaceMode,
      workspace_path: task.workspacePath,
      ...(task.branch ? { branch: task.branch } : {}),
      next: "Keep working, then call wait_for_tasks to collect the receipt.",
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

  private async waitForTasks(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requested = optionalStringArray(args, "task_ids");
    const until = args.until === "any" ? "any" : "all";
    const seconds =
      typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds)
        ? Math.min(MAX_WAIT_SECONDS, Math.max(1, args.timeout_seconds))
        : DEFAULT_WAIT_SECONDS;
    const tasks = requested.length
      ? requested.map((id) => this.ownTask(caller, id))
      : this.store.listForParent(caller.threadId).filter((task) => isActive(task.status));
    if (tasks.length === 0) return { tasks: [], note: "No running tasks to wait for." };
    const ids = new Set(tasks.map((task) => task.id));

    if (!this.waitSatisfied(ids, until)) {
      await new Promise<void>((resolveWait) => {
        const waiter: Waiter = {
          parentThreadId: caller.threadId,
          taskIds: ids,
          until,
          resolve: () => {
            clearTimeout(timer);
            this.waiters.delete(waiter);
            resolveWait();
          },
        };
        const timer = setTimeout(waiter.resolve, seconds * 1000);
        timer.unref?.();
        this.waiters.add(waiter);
      });
    }

    const receipts = [];
    let pending = 0;
    for (const id of ids) {
      const task = this.store.get(id);
      if (!task) continue;
      if (isSettled(task.status)) {
        this.markDelivered(task);
        receipts.push(await this.receipt(task));
      } else {
        pending++;
        receipts.push({ task_id: task.id, title: task.title, status: this.liveStatus(task) });
      }
    }
    return pending > 0
      ? { tasks: receipts, note: `${pending} task(s) still running; call wait_for_tasks again.` }
      : { tasks: receipts };
  }

  private waitSatisfied(ids: Set<string>, until: "all" | "any"): boolean {
    const settled = [...ids]
      .map((id) => this.store.get(id))
      .map((task) => !task || isSettled(task.status));
    return until === "all" ? settled.every(Boolean) : settled.some(Boolean);
  }

  private async messageTask(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const task = this.ownTask(caller, requireString(args, "task_id"));
    const message = requireString(args, "message");
    const steer = args.mode === "steer";
    if (!task.childThreadId) throw new Error("This task has no thread; start a new task.");
    if (task.status === "starting")
      throw new Error("The task is still starting; try again shortly.");
    // Messaging a running task adds no work in parallel; restarting an idle one does.
    if (!isActive(task.status)) this.assertBudget(caller.threadId);
    const inFlight = this.host.isTurnInFlight(task.childThreadId);
    const childThreadId = task.childThreadId;
    void this.deliver(
      childThreadId,
      message,
      inFlight ? (steer ? "steer" : "follow_up") : null,
    ).catch((error: unknown) => this.promptFailed(task.id, childThreadId, error));
    return {
      task_id: task.id,
      delivered: inFlight
        ? steer
          ? "steered the current turn"
          : "queued after the current turn"
        : "started a new turn",
      next: "Call wait_for_tasks to collect the reply.",
    };
  }

  private async cancelTask(
    caller: TaskThreadInfo,
    taskId: string,
  ): Promise<Record<string, unknown>> {
    const task = this.ownTask(caller, taskId);
    if (!isActive(task.status) || !task.childThreadId) {
      return { task_id: task.id, status: task.status, note: "Nothing was running." };
    }
    this.stopReasons.set(task.id, "cancelled");
    await this.host.cancelTurn(task.childThreadId);
    return { task_id: task.id, status: "cancelling" };
  }

  private async createWorkspace(
    caller: TaskThreadInfo,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const name = requireString(args, "name");
    await this.approve(caller, `Create workspace “${clip(name, 40)}”`, { name });
    const workspace = await this.host.createWorkspace(
      caller.projectId,
      workspaceName(name),
      args.install_dependencies === true,
    );
    return { workspace_path: workspace.path, branch: workspace.branch };
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
    const answer = await this.host.requestApproval(caller.threadId, { title, detail });
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
        `This thread already has ${mine} running tasks (limit ${this.config.maxRunningPerThread}). Call wait_for_tasks before starting more.`,
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
    for (const waiter of this.waiters) {
      if (waiter.taskIds.has(task.id) && this.waitSatisfied(waiter.taskIds, waiter.until)) {
        waiter.resolve();
      }
    }
    if (!this.config.notifyParent || this.disposed) return;
    // A waiter collecting this task gets the receipt; don't also send a note.
    if ([...this.waiters].some((waiter) => waiter.taskIds.has(task.id))) return;
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
      await this.host.sendPrompt(threadId, message, { mode, origin: "agent-task" });
    } catch (error) {
      if (mode !== null || !(error instanceof Error) || !/already in flight/i.test(error.message)) {
        throw error;
      }
      await this.host.sendPrompt(threadId, message, { mode: "follow_up", origin: "agent-task" });
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
