import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app } from "electron";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentCapabilities, ContentBlock } from "@agentclientprotocol/sdk";
import type {
  AcpAgentDescriptor,
  AcpBridgeEvent,
  SubagentConfig,
  SubagentRunSnapshot,
  SubagentRunStatus,
} from "../../contracts/acp.ts";
import {
  applySessionUpdate,
  applyTurnStop,
  createEmptySessionSlice,
  type AcpSessionSlice,
} from "../../src/lib/acp-session-reducer.ts";
import { getAgentDescriptor, listRegisteredAgents } from "../agents/registry.ts";
import type { AnalyticsEventName, AnalyticsProperties } from "../analytics-schema.ts";
import { categorizeIntent } from "../analytics-sanitize.ts";
import {
  readSubagentConfig,
  writeSubagentConfig,
  DEFAULT_SUBAGENT_CONFIG,
} from "./subagent-config.ts";
import {
  McpHttpServer,
  type McpEndpoint,
  type McpToolDefinition,
  type McpToolResult,
} from "../mcp/mcp-http-server.ts";
import { ensureStdioProxyScript } from "../mcp/stdio-proxy.ts";

/** The slice of a live ACP connection a subagent run needs. */
export interface SubagentConnection {
  agentId: string;
  agentCapabilities: AgentCapabilities;
  agent: {
    request: (method: any, params?: any) => Promise<any>;
    notify: (method: any, params?: any) => Promise<void>;
  };
}

/**
 * What the connection manager provides to subagent runs. Kept as a small
 * delegate so this module never imports the (much larger) connection manager
 * and tests can drive runs with a fake agent.
 */
export interface SubagentHost {
  /** Get or spawn a live connection for an agent without switching the UI's active agent. */
  acquireConnection(agentId: string): Promise<SubagentConnection>;
  /** The user's regular MCP servers, so subagents get the same tools as top-level sessions. */
  baseMcpServers(caps: AgentCapabilities): Array<Record<string, unknown>>;
  emitEvent(event: AcpBridgeEvent): void;
}

export interface SubagentManagerOptions {
  host: SubagentHost;
  /** Override the agent catalog in tests. */
  listAgents?: () => AcpAgentDescriptor[];
  /** Override the userData directory in tests. */
  baseDir?: string;
  /** Product analytics sink; omitted in tests. */
  captureAnalytics?: (name: AnalyticsEventName, properties: AnalyticsProperties) => void;
}

interface TokenContext {
  sessionId: string | null;
  cwd: string;
  depth: number;
}

interface RunState {
  runId: string;
  parentToken: string;
  agentId: string;
  task: string;
  status: SubagentRunStatus;
  depth: number;
  sessionId: string | null;
  slice: AcpSessionSlice;
  startedAt: number;
  finishedAt: number | null;
  resultPreview: string | null;
  timedOut: boolean;
  cancelled: boolean;
  connection: SubagentConnection | null;
  /** Aborted by the whole-run deadline or cancellation; every phase observes it. */
  abort: AbortController;
  /** MCP token this run's own session uses to spawn children (null until attached). */
  ownToken: string | null;
  /** Whether the run currently occupies a concurrency slot. */
  holdsSlot: boolean;
  /** Children this run is awaiting; while non-zero it yields its slot to them. */
  waitingChildren: number;
}

const SUBAGENT_PREAMBLE =
  "You are running as a subagent spawned by an orchestrator agent. Work autonomously: " +
  "do not ask clarifying questions — make reasonable assumptions and state them. " +
  "Your final message is the only thing returned to the orchestrator, so end with a " +
  "self-contained report of what you did, found, or changed (including file paths).";

const FINISHED_RUNS_KEPT = 50;

/*
 * Long-running call contract. `spawn_subagent` is one blocking MCP
 * `tools/call` whose whole operation (queueing, connection, session/new and
 * the prompt) is bounded by `runTimeoutMs` (default 10 minutes). Some MCP
 * clients stop waiting sooner (OpenCode's tools/call limit was observed at
 * 300 s) and may retry the call. So:
 *
 * - A caller giving up does not cancel the run; it keeps its own deadline and
 *   is cancelled only by that deadline, the parent session's cancellation or
 *   the parent session closing.
 * - A retry with identical arguments from the same parent session attaches to
 *   the run already in flight instead of starting a duplicate, and a
 *   successful report stays available to such a retry for
 *   RETRY_RESULT_RETENTION_MS. Failed or cancelled runs are not retained: a
 *   retry after a failure starts a fresh run.
 *
 * A start/status/cancel job API with durable ids was considered and not
 * added: every supported agent already calls the tool synchronously, retry
 * attachment covers the observed client-timeout case without a protocol
 * change, and runs are bounded by their deadline either way.
 */
/** How long a finished report can still be collected by a retried call. */
export const RETRY_RESULT_RETENTION_MS = 10 * 60_000;
/** Finished reports retained for retries, across all sessions. */
const RETAINED_RESULTS_MAX = 16;

interface SpawnCall {
  token: string;
  report: Promise<string>;
  /** Set once the run succeeded; failed calls are dropped instead. */
  settledAt: number | null;
}

/** Settle with `promise`, or reject with the signal's reason as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function truncate(text: string, max: number): string {
  // Copy the small prefix: V8 sliced strings can otherwise keep the entire
  // multi-MiB report alive through a 300-character activity preview.
  return text.length <= max
    ? text
    : `${text
        .slice(0, max - 1)
        .split("")
        .join("")}…`;
}

export class SubagentManager {
  private readonly host: SubagentHost;
  private readonly listAgents: () => AcpAgentDescriptor[];
  private readonly baseDir: string | undefined;
  private config: SubagentConfig = { ...DEFAULT_SUBAGENT_CONFIG };
  private readonly server = new McpHttpServer();
  private started: Promise<string> | null = null;
  private readonly tokens = new Map<string, TokenContext>();
  private readonly runs = new Map<string, RunState>();
  private readonly runsBySession = new Map<string, RunState>();
  private activeRuns = 0;
  /** spawn_subagent calls by parent token + arguments, for retry attachment. */
  private readonly spawnCalls = new Map<string, SpawnCall>();
  private readonly slotWaiters: Array<() => void> = [];
  private disposed = false;

  private readonly captureAnalytics:
    | ((name: AnalyticsEventName, properties: AnalyticsProperties) => void)
    | undefined;

  constructor(options: SubagentManagerOptions) {
    this.host = options.host;
    this.listAgents = options.listAgents ?? listRegisteredAgents;
    this.baseDir = options.baseDir;
    this.captureAnalytics = options.captureAnalytics;
  }

  async init(): Promise<void> {
    this.config = await readSubagentConfig(this.baseDir);
  }

  getConfig(): SubagentConfig {
    return { ...this.config };
  }

  async setConfig(partial: Partial<SubagentConfig>): Promise<SubagentConfig> {
    this.config = await writeSubagentConfig(partial, this.baseDir);
    return this.getConfig();
  }

  getRunSnapshots(): SubagentRunSnapshot[] {
    return [...this.runs.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((run) => ({
        runId: run.runId,
        parentSessionId: this.tokens.get(run.parentToken)?.sessionId ?? null,
        sessionId: run.sessionId,
        agentId: run.agentId,
        task: truncate(run.task, 200),
        status: run.status,
        depth: run.depth,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        resultPreview: run.resultPreview,
      }));
  }

  /** Agents the user allows as subagents (installed, non-mock unless opted in). */
  availableSubagents(): AcpAgentDescriptor[] {
    const allowed = this.config.allowedAgents;
    return this.listAgents().filter((agent) => {
      if (agent.available === false) return false;
      if (allowed === "all") return agent.installKind !== "mock";
      return allowed.includes(agent.id);
    });
  }

  /**
   * Append the subagent MCP server to a session's server list, minting a
   * per-session endpoint token. Callers must bindSession() the token to the
   * ACP session id once session/new (or load/resume) returns, so tool calls
   * from that session are attributable.
   */
  async attachMcpServers(
    baseServers: Array<Record<string, unknown>>,
    caps: AgentCapabilities,
    context: { cwd: string; depth: number },
  ): Promise<{ servers: Array<Record<string, unknown>>; token: string | null }> {
    if (
      this.disposed ||
      !this.config.enabled ||
      context.depth >= this.config.maxDepth ||
      this.availableSubagents().length === 0
    ) {
      return { servers: baseServers, token: null };
    }

    const shimPath = await this.ensureStarted();
    const token = randomUUID();
    this.tokens.set(token, { sessionId: null, cwd: context.cwd, depth: context.depth });
    this.server.register(token, this.endpointFor(token));

    const url = this.server.urlFor(token);
    const entry: Record<string, unknown> = caps.mcpCapabilities?.http
      ? // `headers` is a required array in the ACP HttpMcpServer schema
        // (opencode rejects the session with -32602 if it's absent).
        { type: "http", name: "pipper-subagents", url, headers: [] }
      : {
          type: "stdio",
          name: "pipper-subagents",
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

  /** Release MCP endpoints owned by an ACP session after it is closed. */
  releaseSessionMcp(sessionId: string): void {
    for (const [token, context] of this.tokens) {
      if (context.sessionId === sessionId) this.releaseToken(token);
    }
  }

  private releaseToken(token: string | null): void {
    if (!token) return;
    this.tokens.delete(token);
    this.server.unregister(token);
    // Nobody can retry through a released endpoint; drop its retained reports.
    for (const [key, call] of this.spawnCalls) {
      if (call.token === token) this.spawnCalls.delete(key);
    }
  }

  /** Release an endpoint created for a session before that session is bound. */
  releaseTokenForSession(token: string): void {
    this.releaseToken(token);
  }

  /** Registered MCP endpoints (lifecycle diagnostics). */
  endpointCount(): number {
    return this.tokens.size;
  }

  /** True while a run for this provider is queued or running (keeps it warm). */
  hasActiveRunsForAgent(agentId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.agentId === agentId && (run.status === "queued" || run.status === "running")) {
        return true;
      }
    }
    return false;
  }

  /** True when the session belongs to a subagent run (vs a user-facing thread). */
  ownsSession(sessionId: string): boolean {
    return this.runsBySession.has(sessionId);
  }

  /** Route a session/update into the owning run's slice. False if not ours. */
  handleSessionUpdate(sessionId: string, update: acp.SessionUpdate): boolean {
    const run = this.runsBySession.get(sessionId);
    if (!run) return false;
    run.slice = applySessionUpdate(run.slice, update);
    return true;
  }

  /**
   * Auto-approve permission requests from headless subagent sessions (they
   * have no UI surface to answer on). Null means "not ours — ask the user".
   */
  autoPermissionResponse(
    params: acp.RequestPermissionRequest,
  ): acp.RequestPermissionResponse | null {
    if (!this.ownsSession(params.sessionId)) return null;
    if (!this.config.autoApprovePermissions) return null;
    const options = params.options ?? [];
    const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
    if (!allow) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }

  /** Cancel every queued/running run spawned by the given orchestrator session. */
  cancelRunsForParent(parentSessionId: string): void {
    for (const run of this.runs.values()) {
      if (run.status !== "queued" && run.status !== "running") continue;
      if (this.tokens.get(run.parentToken)?.sessionId !== parentSessionId) continue;
      void this.cancelRun(run);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const run of this.runs.values()) {
      if (run.status === "queued" || run.status === "running") void this.cancelRun(run);
    }
    this.server.close();
    this.tokens.clear();
    this.spawnCalls.clear();
    this.started = null;
  }

  private async cancelRun(run: RunState): Promise<void> {
    if (run.cancelled) return;
    run.cancelled = true;
    if (!run.abort.signal.aborted) run.abort.abort(new Error("subagent run was cancelled"));
    // Descendants cannot report to a cancelled parent; cancel queued ones too.
    if (run.ownToken) {
      for (const child of this.runs.values()) {
        if (child.parentToken !== run.ownToken) continue;
        if (child.status !== "queued" && child.status !== "running") continue;
        void this.cancelRun(child);
      }
    }
    if (run.connection && run.sessionId) {
      try {
        await run.connection.agent.notify(acp.methods.agent.session.cancel, {
          sessionId: run.sessionId,
        });
      } catch {
        // connection may already be gone
      }
    }
  }

  /** Start the HTTP server and materialize the stdio shim once, lazily. */
  private ensureStarted(): Promise<string> {
    if (!this.started) {
      this.started = (async () => {
        await this.server.start();
        const shimPath = join(this.baseDir ?? app.getPath("userData"), "subagent-stdio-proxy.mjs");
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
      listTools: () => this.toolDefinitions(),
      callTool: (name, args) => this.callTool(token, name, args),
    };
  }

  private toolDefinitions(): McpToolDefinition[] {
    const agents = this.availableSubagents();
    const catalog = agents
      .map((a) => `- ${a.id} (${a.displayName})${a.description ? `: ${a.description}` : ""}`)
      .join("\n");
    return [
      {
        name: "list_subagents",
        description:
          "List the coding agents available to spawn as subagents, with their ids and descriptions.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "spawn_subagent",
        description:
          "Delegate a task to another coding agent running in its own isolated session, and get its " +
          "final report back. The subagent shares NO context with you — include every needed detail " +
          "(background, file paths, constraints, expected output) in the task. Call this tool multiple " +
          "times, including in parallel, to fan work out across agents. If this call times out on " +
          "your side, the subagent keeps running: call spawn_subagent again with identical " +
          "arguments to wait for (or collect) that same run's report instead of starting another." +
          "\n\nAvailable agents:\n" +
          catalog,
        inputSchema: {
          type: "object",
          properties: {
            agent_id: {
              type: "string",
              description: "Which agent to spawn.",
              enum: agents.map((a) => a.id),
            },
            task: {
              type: "string",
              description:
                "Complete, self-contained task description. The subagent sees nothing else.",
            },
            context: {
              type: "string",
              description: "Optional extra background (findings so far, relevant snippets).",
            },
            cwd: {
              type: "string",
              description: "Optional working directory override; defaults to your own.",
            },
          },
          required: ["agent_id", "task"],
          additionalProperties: false,
        },
      },
    ];
  }

  private async callTool(
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    if (name === "list_subagents") {
      const agents = this.availableSubagents().map((a) => ({
        id: a.id,
        name: a.displayName,
        description: a.description ?? null,
      }));
      return { content: [{ type: "text", text: JSON.stringify(agents, null, 2) }] };
    }
    if (name === "spawn_subagent") {
      const text = await this.spawnOrAttach(token, args);
      return { content: [{ type: "text", text }] };
    }
    throw new Error(`unknown tool: ${name}`);
  }

  /**
   * Start a run, or attach a retried call to the identical run already in
   * flight (or recently finished) for the same parent session.
   */
  private spawnOrAttach(token: string, args: Record<string, unknown>): Promise<string> {
    const now = Date.now();
    for (const [key, call] of this.spawnCalls) {
      if (call.settledAt != null && now - call.settledAt >= RETRY_RESULT_RETENTION_MS) {
        this.spawnCalls.delete(key);
      }
    }
    const key = JSON.stringify([
      token,
      args.agent_id ?? null,
      typeof args.task === "string" ? args.task.trim() : null,
      args.context ?? null,
      args.cwd ?? null,
    ]);
    const existing = this.spawnCalls.get(key);
    if (existing) return existing.report;

    const call: SpawnCall = { token, report: this.runSubagent(token, args), settledAt: null };
    this.spawnCalls.set(key, call);
    call.report.then(
      () => {
        if (this.spawnCalls.get(key) !== call) return;
        call.settledAt = Date.now();
        // Re-insert so iteration order is settle order, then bound retention.
        this.spawnCalls.delete(key);
        this.spawnCalls.set(key, call);
        let retained = 0;
        for (const candidate of this.spawnCalls.values()) {
          if (candidate.settledAt != null) retained++;
        }
        for (const [candidateKey, candidate] of this.spawnCalls) {
          if (retained <= RETAINED_RESULTS_MAX) break;
          if (candidate.settledAt == null) continue;
          this.spawnCalls.delete(candidateKey);
          retained--;
        }
      },
      () => {
        if (this.spawnCalls.get(key) === call) this.spawnCalls.delete(key);
      },
    );
    return call.report;
  }

  private async runSubagent(token: string, args: Record<string, unknown>): Promise<string> {
    const parent = this.tokens.get(token);
    if (!parent) throw new Error("unknown orchestrator session");
    if (parent.depth + 1 > this.config.maxDepth) {
      throw new Error(`subagent depth limit reached (maxDepth=${this.config.maxDepth})`);
    }
    const agentId = typeof args.agent_id === "string" ? args.agent_id : "";
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!task) throw new Error("spawn_subagent requires a non-empty task");
    const descriptor = this.availableSubagents().find((a) => a.id === agentId);
    if (!descriptor) {
      const ids = this.availableSubagents()
        .map((a) => a.id)
        .join(", ");
      throw new Error(`unknown or disallowed agent_id "${agentId}". Available: ${ids}`);
    }

    const run: RunState = {
      runId: randomUUID(),
      parentToken: token,
      agentId: descriptor.id,
      task,
      status: "queued",
      depth: parent.depth + 1,
      sessionId: null,
      slice: createEmptySessionSlice(),
      startedAt: Date.now(),
      finishedAt: null,
      resultPreview: null,
      timedOut: false,
      cancelled: false,
      connection: null,
      abort: new AbortController(),
      ownToken: null,
      holdsSlot: false,
      waitingChildren: 0,
    };
    this.runs.set(run.runId, run);
    this.emitRuns();

    // One deadline covers queueing, connection, session/new and the prompt.
    const timeoutMs = this.config.runTimeoutMs;
    const deadline = setTimeout(() => {
      run.timedOut = true;
      run.abort.abort(new Error(`subagent run timed out after ${timeoutMs}ms`));
      void this.cancelRun(run);
    }, timeoutMs);
    deadline.unref?.();
    const signal = run.abort.signal;

    // A subagent that delegates is waiting, not executing: lend its slot to
    // the child so nested runs cannot deadlock behind their own parents.
    const delegatingRun = this.activeRunForOwnToken(token);
    if (delegatingRun) this.yieldSlot(delegatingRun);

    let attachedToken: string | null = null;
    try {
      await this.acquireSlot(signal);
      run.holdsSlot = true;
      if (this.disposed) throw new Error("subagent run was cancelled");
      run.status = "running";
      this.emitRuns();

      const connection = await untilAborted(this.host.acquireConnection(descriptor.id), signal);
      run.connection = connection;

      const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : parent.cwd;
      const attached = await this.attachMcpServers(
        this.host.baseMcpServers(connection.agentCapabilities),
        connection.agentCapabilities,
        { cwd, depth: run.depth },
      );
      attachedToken = attached.token;
      run.ownToken = attached.token;
      signal.throwIfAborted();

      const createRequest = connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: attached.servers as never,
      }) as Promise<{ sessionId: string }>;
      let created: { sessionId: string };
      try {
        created = await untilAborted(createRequest, signal);
      } catch (error) {
        // The provider may still create the session after we stop waiting.
        // Close that one session; never kill the shared provider for it.
        createRequest.then(
          (late) =>
            connection.agent
              .request(acp.methods.agent.session.close, { sessionId: late.sessionId })
              .catch(() => {}),
          () => {},
        );
        throw error;
      }
      run.sessionId = created.sessionId;
      this.runsBySession.set(created.sessionId, run);
      if (attached.token) this.bindSession(attached.token, created.sessionId);
      // Cancelled or expired while the session was being created: never dispatch.
      signal.throwIfAborted();

      const context = typeof args.context === "string" && args.context ? args.context : null;
      const promptText =
        `${SUBAGENT_PREAMBLE}\n\n<task>\n${task}\n</task>` +
        (context ? `\n\n<context>\n${context}\n</context>` : "");
      const prompt: ContentBlock[] = [{ type: "text", text: promptText }];

      await untilAborted(
        connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt,
        }),
        signal,
      );

      run.slice = applyTurnStop(run.slice);
      // ACP assistant chunks are separate for the renderer's markdown layout,
      // but they are still transport fragments for the subagent protocol.
      // Recombine them without adding presentation whitespace to the report
      // returned to the orchestrator.
      const text = run.slice.entries
        .filter((entry) => entry.type === "agent_text")
        .map((entry) => entry.text)
        .join("")
        .trim();

      signal.throwIfAborted();

      run.status = "finished";
      run.resultPreview = text ? truncate(text, 300) : null;
      return text || "(the subagent finished without a final text message)";
    } catch (err) {
      run.status = run.cancelled || run.timedOut ? "cancelled" : "failed";
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(deadline);
      run.finishedAt = Date.now();
      this.captureAnalytics?.("subagent_run_completed", {
        agent_id: run.agentId,
        agent_name: getAgentDescriptor(run.agentId)?.name,
        status: run.status,
        depth: run.depth,
        // Duration of just this run, from admission to settlement.
        execution_duration_ms: run.finishedAt - run.startedAt,
        task_category: categorizeIntent(run.task),
      });
      if (run.connection && run.sessionId) {
        run.connection.agent
          .request(acp.methods.agent.session.close, { sessionId: run.sessionId })
          .catch(() => {});
        this.runsBySession.delete(run.sessionId);
      }
      // Activity history only needs the compact snapshot. Release completed
      // transcripts, full task strings and process/transport references on
      // success, cancellation and error, while keeping the returned report.
      run.slice = createEmptySessionSlice();
      run.task = truncate(run.task, 200);
      run.connection = null;
      this.releaseToken(attachedToken);
      if (run.holdsSlot) {
        run.holdsSlot = false;
        this.releaseSlot();
      }
      this.pruneFinishedRuns();
      this.emitRuns();
      // The delegating parent resumes executing before it sees this result.
      if (delegatingRun) await this.reclaimSlot(delegatingRun);
    }
  }

  private activeRunForOwnToken(token: string): RunState | undefined {
    for (const run of this.runs.values()) {
      if (run.ownToken === token && run.status === "running") return run;
    }
    return undefined;
  }

  private yieldSlot(run: RunState): void {
    run.waitingChildren++;
    if (run.waitingChildren === 1 && run.holdsSlot) {
      run.holdsSlot = false;
      this.releaseSlot();
    }
  }

  private async reclaimSlot(run: RunState): Promise<void> {
    run.waitingChildren--;
    if (run.waitingChildren > 0 || run.holdsSlot || run.finishedAt !== null) return;
    try {
      // Resuming work goes ahead of new admissions so parents cannot starve.
      await this.acquireSlot(run.abort.signal, true);
      run.holdsSlot = true;
    } catch {
      // The parent was cancelled or timed out; its own run settles without a slot.
    }
  }

  private acquireSlot(signal: AbortSignal, front = false): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.activeRuns < this.config.maxConcurrent) {
      this.activeRuns++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.slotWaiters.indexOf(waiter);
        if (index >= 0) this.slotWaiters.splice(index, 1);
        reject(signal.reason);
      };
      const waiter = () => {
        signal.removeEventListener("abort", onAbort);
        this.activeRuns++;
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (front) this.slotWaiters.unshift(waiter);
      else this.slotWaiters.push(waiter);
    });
  }

  private releaseSlot(): void {
    this.activeRuns--;
    this.slotWaiters.shift()?.();
  }

  private pruneFinishedRuns(): void {
    const finished = [...this.runs.values()]
      .filter((r) => r.status !== "queued" && r.status !== "running")
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    while (finished.length > FINISHED_RUNS_KEPT) {
      const oldest = finished.shift()!;
      this.runs.delete(oldest.runId);
    }
  }

  private emitRuns(): void {
    this.host.emitEvent({ type: "subagent-runs", runs: this.getRunSnapshots() });
  }
}
