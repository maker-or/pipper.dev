import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentCapabilities, AuthMethod } from "@agentclientprotocol/sdk";
import type {
  MonitorAcpUpdate,
  MonitorBridgeEvent,
  MonitorSessionCacheEvent,
  MonitorSwitchRecord,
} from "../contracts/monitor.ts";
import type { AcpAgentDescriptor } from "../contracts/acp.ts";
import { resolveAgentSpawn } from "./agents/registry.ts";
import { classifyAgentStartFailure, type AgentStartFailureReason } from "./agents/start-failure.ts";
import {
  applyStartRecovery,
  npxPackageFor,
  planStartRecovery,
  withNpxPackageLock,
  type StartRecoveryAction,
  type StartRecoveryReport,
} from "./agents/start-recovery.ts";
import { shellPathReady } from "./shell-path.ts";
import {
  ANTIGRAVITY_INSTALL_WAIT_MS,
  waitForAntigravityInstall,
} from "./agents/antigravity-official.ts";
import { spawnProviderProcess, terminateProviderProcess } from "./provider-processes.ts";
import type { TerminalManager } from "./terminal-manager.ts";

const configuredSwitchTimeout = Number(process.env.PIPPER_ACP_SWITCH_TIMEOUT_MS);
export const ACP_SWITCH_PHASE_TIMEOUT_MS =
  Number.isFinite(configuredSwitchTimeout) && configuredSwitchTimeout >= 1_000
    ? configuredSwitchTimeout
    : 10_000;

/** npx agents may need to download on first launch — allow up to 2 minutes for initialize. */
const ACP_NPX_INIT_TIMEOUT_MS = 120_000;

export interface AgentMonitorObserver {
  onConnectionSpawned: (input: {
    connectionId: string;
    agentId: string;
    pid: number;
    spawnedAt: number;
    previousConnectionId: string | null;
  }) => void;
  onConnectionReady?: (input: { connectionId: string; initializedAt: number }) => void;
  onConnectionClosed?: (input: {
    connectionId: string;
    agentId: string;
    pid: number | null;
    activeThreadId: string | null;
    runningThreadIds: string[];
    spawnedAt: number;
    intentional: boolean;
    stderrTail: string;
    sessionCountAtTermination?: number;
    invalidatedThreadIds?: string[];
  }) => void;
  onConnectionExit: (input: {
    connectionId: string;
    agentId: string;
    pid: number | null;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    activeThreadId: string | null;
    runningThreadIds: string[];
    spawnedAt: number;
    intentional: boolean;
    stderrTail: string;
    sessionCountAtTermination?: number;
    invalidatedThreadIds?: string[];
  }) => void;
  /** Fired once per thread activation with the resolved cache phase. */
  onSwitchRecord?: (record: MonitorSwitchRecord) => void;
  onSessionCacheEvent?: (event: MonitorSessionCacheEvent) => void;
  onAcpUpdate?: (update: MonitorAcpUpdate) => void;
  onBridgeEvent?: (event: MonitorBridgeEvent) => void;
}

export function requestWithTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
  phase: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${phase} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface LiveConnection {
  connectionId: string;
  /** Spawn routing key: the provider *instance* id (driver id when default). */
  agentId: string;
  /** The underlying driver/provider id this instance is a configuration of. */
  driverId: string;
  agentInfoName: string;
  process: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  agent: acp.ClientContext;
  agentCapabilities: AgentCapabilities;
  authMethods: AuthMethod[];
  /**
   * Set only when the agent actually rejects `session/new` with an
   * `auth_required` error — i.e. the user is genuinely not signed in. This is
   * distinct from `authMethods`, which merely advertises the auth flows the
   * agent *supports* and is present even for signed-in users, so it must never
   * be used to decide whether authentication is required.
   */
  authRequiredMessage: string | null;
  /**
   * Non-standard model catalog some agents (e.g. Grok) advertise in the
   * initialize result's `_meta.modelState` instead of via session config
   * options. When present we synthesize a "model" config option from it and
   * route model switches through the custom `session/set_model` method.
   */
  modelState?: {
    currentModelId?: string | null;
    availableModels?: Array<{ modelId: string; name: string }>;
  } | null;
  closed: Promise<void>;
}

/**
 * One in-flight spawn+initialize for an agent id, shared by every concurrent
 * `acquire`. `close` abandons it: the attempt never becomes the cached
 * connection, and its process (once spawned) is terminated.
 */
/** A failed agent start, as reported to analytics (no raw text). */
export interface AgentStartFailure {
  errorName?: string;
  reason: AgentStartFailureReason;
  exitCode: number | null;
  /** The repair tried before giving up, if any. */
  recovery?: AgentStartRecovery;
}

/** A repair-and-retry made while an agent was starting. */
export interface AgentStartRecovery {
  action: StartRecoveryAction;
  /** Why the first launch failed. */
  from: AgentStartFailureReason;
  /** The first launch's exit code, when it exited. */
  exitCode: number | null;
  /** When the first launch failed. */
  failedAt: number;
  /** False when the repair found nothing to change, so no retry was made. */
  retried: boolean;
}

interface SpawnAttempt {
  promise: Promise<LiveConnection>;
  child: ChildProcessWithoutNullStreams | null;
  connectionId: string | null;
  abandoned: boolean;
  /** The process's stderr so far, read locally to classify a failed start. */
  readStderr?: () => string;
  /** Set when the first launch failed and a repair-and-retry was made. */
  recovery?: AgentStartRecovery;
}

/** Client capabilities the manager hosts for every spawned agent process. */
export interface ConnectionClientHooks {
  onSessionUpdate(sessionId: string, update: acp.SessionUpdate): Promise<void>;
  onRequestPermission(
    params: acp.RequestPermissionRequest,
    requestId: string | number | null,
  ): Promise<acp.RequestPermissionResponse>;
  onReadTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  onWriteTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  /** Containment check for a terminal's starting cwd (see docs/worktree.md). */
  assertWithinWorkspace(sessionId: string | undefined, targetPath: string): void;
}

/** Diagnostics + teardown callbacks the spawn/exit reporters need. */
export interface ConnectionLifecycleDeps {
  terminal: TerminalManager;
  /**
   * App version advertised to agents in the initialize `clientInfo`. Sourced
   * from package.json (via `app.getVersion()`) so it can never drift from the
   * release version.
   */
  clientVersion: string;
  hooks: ConnectionClientHooks;
  getMonitorObserver(): AgentMonitorObserver | null;
  getActiveThreadId(): string | null;
  getRunningThreadIds(): string[];
  getSessionsByAgent(agentId: string): Array<{ threadId: string; agentSessionId: string }>;
  /** Drop cached sessions whose agent process died or transport closed. */
  invalidateAgentSessions(agentId: string): void;
  /** Analytics fire for first-time spawns only (deduped callers stay silent). */
  onConnected?(
    agentId: string,
    connectDurationMs: number,
    installKind?: string,
    recovery?: AgentStartRecovery,
  ): void;
  onConnectFailed?(agentId: string, failure: AgentStartFailure): void;
  /** A start that needed a repair, once its outcome is known. */
  onStartRecovery?(agentId: string, report: StartRecoveryReport): void;
}

/**
 * Owns ACP transports: one live agent process per agent id, spawn dedup, the
 * active UI pointer, and the incident reporting around process exits and
 * transport closes. Session/thread concerns stay in AgentConnectionManager.
 */
export class ConnectionLifecycle {
  private readonly deps: ConnectionLifecycleDeps;
  /** The connection backing the composer/UI agent. */
  private activeConnection: LiveConnection | null = null;
  /**
   * Keep one live ACP transport per agent. ACP sessions belong to the agent
   * process that created them, so tearing this down on every cross-agent
   * thread switch made switching require a new process plus session restore.
   */
  private readonly connections = new Map<string, LiveConnection>();
  /** In-flight spawn per agentId, so concurrent callers share one spawn instead of racing. */
  private readonly spawning = new Map<string, SpawnAttempt>();
  private readonly intentionalConnectionIds = new Set<string>();
  private readonly lastConnectionIds = new Map<string, string>();
  private readonly connectionSpawnedAt = new Map<string, number>();
  /**
   * Every process this lifecycle spawned that has not exited, including ones
   * still in their handshake or whose transport closed. `connections` alone
   * misses those, and shutdown must reap them all.
   */
  private readonly processes = new Map<ChildProcessWithoutNullStreams, string>();
  /** Set by terminateAll: shutdown is underway and no new provider may start. */
  private terminated = false;

  constructor(deps: ConnectionLifecycleDeps) {
    this.deps = deps;
  }

  get active(): LiveConnection | null {
    return this.activeConnection;
  }

  setActive(live: LiveConnection | null): void {
    this.activeConnection = live;
  }

  getCached(agentId: string): LiveConnection | undefined {
    return this.connections.get(agentId);
  }

  /** All live connections, e.g. for model catalogs or process listings. */
  all(): LiveConnection[] {
    return [...this.connections.values()];
  }

  /** The session's owning connection: the active one, else the cached one. */
  connectionFor(agentId: string): LiveConnection | null {
    if (this.activeConnection?.agentId === agentId) return this.activeConnection;
    return this.connections.get(agentId) ?? null;
  }

  async acquire(descriptor: AcpAgentDescriptor): Promise<LiveConnection> {
    if (this.terminated) throw new Error("Agent connections are shut down");
    const cached = this.connections.get(descriptor.id);
    if (cached) return cached;
    let attempt = this.spawning.get(descriptor.id);
    const isNewSpawn = !attempt;
    const spawnStartedAt = Date.now();
    if (!attempt) {
      const created: SpawnAttempt = {
        promise: Promise.resolve(null as never),
        child: null,
        connectionId: null,
        abandoned: false,
      };
      created.promise = this.startWithRecovery(descriptor, created).finally(() => {
        // close() may already have replaced this attempt with a newer one.
        if (this.spawning.get(descriptor.id) === created) this.spawning.delete(descriptor.id);
      });
      this.spawning.set(descriptor.id, created);
      attempt = created;
    }
    try {
      const live = await attempt.promise;
      // terminateAll already reaped this process while its handshake finished.
      if (this.terminated) throw new Error("Agent connections are shut down");
      // close() ran while it was starting (its account was removed, or idle
      // release): it must not come back as this agent's cached connection.
      if (attempt.abandoned) throw new Error(`${descriptor.id} was closed while it was starting`);
      this.connections.set(descriptor.id, live);
      if (isNewSpawn) {
        this.deps.onConnected?.(
          descriptor.id,
          Date.now() - spawnStartedAt,
          descriptor.installKind,
          attempt.recovery,
        );
        if (attempt.recovery) this.reportRecovery(descriptor.id, attempt.recovery, "recovered");
      }
      return live;
    } catch (err) {
      // A spawn cut short by shutdown or close is not a connection failure.
      if (isNewSpawn && !this.terminated && !attempt.abandoned) {
        const exitCode = attempt.child?.exitCode ?? null;
        const reason = classifyAgentStartFailure({
          error: err,
          stderr: attempt.readStderr?.(),
          exitCode,
        });
        this.deps.onConnectFailed?.(descriptor.id, {
          errorName: err instanceof Error ? err.name : undefined,
          reason,
          exitCode,
          recovery: attempt.recovery,
        });
        if (attempt.recovery) {
          this.reportRecovery(descriptor.id, attempt.recovery, "failed", reason);
        }
      }
      // Killing an abandoned handshake surfaces as a transport error; report why.
      if (attempt.abandoned && !this.terminated) {
        throw new Error(`${descriptor.id} was closed while it was starting`, { cause: err });
      }
      throw err;
    }
  }

  private reportRecovery(
    agentId: string,
    recovery: AgentStartRecovery,
    outcome: "recovered" | "failed",
    finalFailureReason?: AgentStartFailureReason,
  ): void {
    this.deps.onStartRecovery?.(agentId, {
      failureReason: recovery.from,
      action: recovery.action,
      outcome,
      retried: recovery.retried,
      // A repair that found nothing to change ends with the first failure.
      ...(outcome === "failed" && recovery.retried && { finalFailureReason }),
      exitCode: recovery.exitCode,
      durationMs: Date.now() - recovery.failedAt,
    });
  }

  /**
   * Shutdown: mark every live connection intentional, close the transports,
   * and terminate every provider process this lifecycle started (with its
   * process group). Later spawns are refused.
   */
  async terminateAll(): Promise<void> {
    this.terminated = true;
    const liveConnections = [...this.connections.values()];
    this.connections.clear();
    this.activeConnection = null;
    for (const live of liveConnections) {
      try {
        live.connection.close();
      } catch {
        // ignore
      }
    }
    const processes = [...this.processes];
    for (const [, connectionId] of processes) this.intentionalConnectionIds.add(connectionId);
    await Promise.all(processes.map(([child]) => terminateProviderProcess(child)));
  }

  /**
   * Close and forget one instance's transport (e.g. its account was removed),
   * without touching other instances of the same driver.
   */
  async close(agentId: string): Promise<void> {
    const attempt = this.spawning.get(agentId);
    if (attempt) {
      // Still starting: abandon it so later acquires spawn fresh, and stop its
      // process now rather than after a handshake that may take minutes.
      this.spawning.delete(agentId);
      attempt.abandoned = true;
      if (attempt.connectionId) this.intentionalConnectionIds.add(attempt.connectionId);
      if (attempt.child) await terminateProviderProcess(attempt.child);
    }
    const live = this.connections.get(agentId);
    if (!live) {
      if (attempt) this.deps.invalidateAgentSessions(agentId);
      return;
    }
    this.connections.delete(agentId);
    this.intentionalConnectionIds.add(live.connectionId);
    if (this.activeConnection === live) this.activeConnection = null;
    try {
      live.connection.close();
    } catch {
      // ignore
    }
    await terminateProviderProcess(live.process);
    this.deps.invalidateAgentSessions(agentId);
  }

  /**
   * Start an agent; when the launch fails for a reason a repair can fix (see
   * agents/start-recovery.ts), repair it and launch once more. Waits for the
   * login-shell PATH first, and launches of one npx package take turns so
   * parallel installs can't corrupt the npx cache.
   */
  private async startWithRecovery(
    descriptor: AcpAgentDescriptor,
    attempt: SpawnAttempt,
  ): Promise<LiveConnection> {
    await shellPathReady();
    const npmPackage = npxPackageFor(descriptor);
    return withNpxPackageLock(npmPackage, async () => {
      try {
        return await this.spawnAndInitialize(descriptor, attempt);
      } catch (err) {
        if (this.terminated || attempt.abandoned) throw err;
        const stderr = attempt.readStderr?.();
        const reason = classifyAgentStartFailure({
          error: err,
          stderr,
          exitCode: attempt.child?.exitCode ?? null,
        });
        const action = planStartRecovery({
          reason,
          stderr,
          message: err instanceof Error ? err.message : String(err),
          npmPackage,
        });
        if (!action) throw err;
        attempt.recovery = {
          action,
          from: reason,
          exitCode: attempt.child?.exitCode ?? null,
          failedAt: Date.now(),
          retried: false,
        };
        console.warn(`[acp-agent:${descriptor.id}] start failed (${reason}); trying ${action}`);
        if (!(await applyStartRecovery(action, { npmPackage }))) throw err;
        if (this.terminated || attempt.abandoned) throw err;
        attempt.recovery.retried = true;
        // A PATH refresh can turn "not installed" into an npx launch: take
        // that package's turn too (never the one already held).
        const retryPackage = npxPackageFor(descriptor);
        const retry = () =>
          this.spawnAndInitialize(descriptor, attempt, action === "retry_longer" ? 2 : 1);
        return retryPackage && retryPackage !== npmPackage
          ? withNpxPackageLock(retryPackage, retry)
          : retry();
      }
    });
  }

  private async spawnAndInitialize(
    descriptor: AcpAgentDescriptor,
    attempt: SpawnAttempt,
    /** Multiplies the handshake budget (a retry after a timeout gets more). */
    timeoutScale = 1,
  ): Promise<LiveConnection> {
    if (descriptor.id === "antigravity-acp") {
      // First use downloads Google's server (~107 MiB). Bound the wait to the
      // download's own budget so a slow install fails with a retryable message
      // instead of letting the renderer's thread-switch timeout fire first and
      // then receive the thread after it already reported failure.
      const installed = await waitForAntigravityInstall(ANTIGRAVITY_INSTALL_WAIT_MS).catch(
        (error) => {
          throw new Error(
            `Antigravity could not be installed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      );
      if (!installed)
        throw new Error(
          "Antigravity is still downloading for first use. Try again once the download finishes.",
        );
    }
    // Checked after the install wait and right before spawning, with no await
    // in between, so nothing can start once terminateAll has taken its list.
    if (this.terminated) throw new Error("Agent connections are shut down");
    if (attempt.abandoned) throw new Error(`${descriptor.id} was closed while it was starting`);
    const { command, args, env } = resolveAgentSpawn(descriptor);
    const useShell = process.platform === "win32" && /\.cmd$/i.test(command);
    const child = spawnProviderProcess(command, args, { env, shell: useShell });
    const connectionId = randomUUID();
    attempt.child = child;
    attempt.connectionId = connectionId;
    if (child.pid !== undefined) {
      this.processes.set(child, connectionId);
      child.once("exit", () => this.processes.delete(child));
    }
    const spawnedAt = Date.now();
    const previousConnectionId = this.lastConnectionIds.get(descriptor.id) ?? null;
    let stderrTail = "";
    const appendStderr = (buf: Buffer): void => {
      const text = buf.toString("utf8");
      stderrTail = `${stderrTail}${text}`.slice(-16_384);
    };
    attempt.readStderr = () => stderrTail;

    child.stderr.on("data", (buf: Buffer) => {
      appendStderr(buf);
      const text = buf.toString("utf8").trim();
      if (text) console.error(`[acp-agent:${descriptor.id}]`, text);
    });

    // Register the lifecycle before the handshake. A process that dies or
    // times out during initialize is still a real connection episode and must
    // not disappear from diagnostics.
    this.connectionSpawnedAt.set(connectionId, spawnedAt);
    this.lastConnectionIds.set(descriptor.id, connectionId);
    this.deps.getMonitorObserver()?.onConnectionSpawned({
      connectionId,
      agentId: descriptor.id,
      pid: child.pid ?? 0,
      spawnedAt,
      previousConnectionId,
    });
    let exitReported = false;
    const reportExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (exitReported) return;
      exitReported = true;
      const targetSessions = this.deps.getSessionsByAgent(descriptor.id);
      const invalidatedThreadIds = targetSessions.map((session) => session.threadId);
      this.deps.getMonitorObserver()?.onConnectionExit({
        connectionId,
        agentId: descriptor.id,
        pid: child.pid ?? null,
        exitCode,
        signal,
        activeThreadId: this.deps.getActiveThreadId(),
        runningThreadIds: this.deps.getRunningThreadIds(),
        spawnedAt,
        intentional: this.intentionalConnectionIds.has(connectionId),
        stderrTail,
        sessionCountAtTermination: targetSessions.length,
        invalidatedThreadIds,
      });
      this.connectionSpawnedAt.delete(connectionId);
      this.intentionalConnectionIds.delete(connectionId);
      const current = this.connections.get(descriptor.id);
      if (this.activeConnection?.process === child) this.activeConnection = null;
      if (current?.process === child) {
        this.connections.delete(descriptor.id);
        this.deps.invalidateAgentSessions(descriptor.id);
      }
    };
    child.on("exit", reportExit);

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    let agentCtx!: acp.ClientContext;
    let initResult!: acp.InitializeResponse;

    const hooks = this.deps.hooks;
    const app = acp
      .client({ name: "pipper" })
      .onNotification(acp.methods.client.session.update, async (ctx) => {
        await hooks.onSessionUpdate(ctx.params.sessionId, ctx.params.update);
      })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        return hooks.onRequestPermission(ctx.params, ctx.requestId);
      })
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        return hooks.onReadTextFile(ctx.params);
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        return hooks.onWriteTextFile(ctx.params);
      })
      .onRequest(acp.methods.client.terminal.create, async (ctx) => {
        // Option A path guard: bound the terminal's *starting* cwd to the
        // session's workspace. The spawned process can still `cd` out — an
        // honest agent won't; a hard boundary (OS sandbox) is deferred. See
        // docs/worktree.md "Threat model".
        if (ctx.params.cwd) {
          hooks.assertWithinWorkspace(ctx.params.sessionId, ctx.params.cwd);
        }
        const terminalId = this.deps.terminal.create({
          command: ctx.params.command,
          args: ctx.params.args ?? undefined,
          cwd: ctx.params.cwd ?? undefined,
          sessionId: ctx.params.sessionId,
          env: ctx.params.env as never,
          outputByteLimit: ctx.params.outputByteLimit ?? undefined,
        });
        return { terminalId };
      })
      .onRequest(acp.methods.client.terminal.output, async (ctx) => {
        const out = this.deps.terminal.getOutput(ctx.params.terminalId);
        return {
          output: out.output,
          truncated: out.truncated,
          exitStatus: out.exitStatus,
        };
      })
      .onRequest(acp.methods.client.terminal.waitForExit, async (ctx) => {
        const result = await this.deps.terminal.waitForExit(
          ctx.params.terminalId,
          ACP_SWITCH_PHASE_TIMEOUT_MS,
        );
        return { exitCode: result.exitCode, signal: result.signal };
      })
      .onRequest(acp.methods.client.terminal.kill, async (ctx) => {
        this.deps.terminal.kill(ctx.params.terminalId);
        return {};
      })
      .onRequest(acp.methods.client.terminal.release, async (ctx) => {
        this.deps.terminal.release(ctx.params.terminalId);
        return {};
      });

    const connection = app.connect(stream);
    agentCtx = connection.agent;

    try {
      initResult = await requestWithTimeout(
        agentCtx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
          clientInfo: {
            name: "pipper",
            title: "Pipper",
            version: this.deps.clientVersion,
          },
        }),
        (/\bnpx(?:\.cmd)?$/i.test(command)
          ? ACP_NPX_INIT_TIMEOUT_MS
          : ACP_SWITCH_PHASE_TIMEOUT_MS) * timeoutScale,
        "agent/initialize",
      );
    } catch (err) {
      // A timed-out handshake has no usable owner. Close both sides so the
      // abandoned request cannot keep the child process and transport alive.
      try {
        connection.close();
      } catch {
        // best effort
      }
      await terminateProviderProcess(child);
      throw err;
    }

    const agentInfoName = initResult.agentInfo?.name ?? descriptor.name ?? descriptor.id;
    const agentCapabilities = initResult.agentCapabilities ?? {};
    const authMethods = initResult.authMethods ?? [];
    const modelState =
      (initResult as { _meta?: { modelState?: LiveConnection["modelState"] } })._meta?.modelState ??
      null;

    const closed = connection.closed.then(() => {
      // A transport can close while its child is still alive. That is a
      // different failure mode from a process exit and must be visible in the
      // incident log. The exit handler owns the latter case.
      if (child.exitCode == null && child.signalCode == null) {
        const targetSessions = this.deps.getSessionsByAgent(descriptor.id);
        const invalidatedThreadIds = targetSessions.map((session) => session.threadId);
        this.deps.getMonitorObserver()?.onConnectionClosed?.({
          connectionId,
          agentId: descriptor.id,
          pid: child.pid ?? null,
          activeThreadId: this.deps.getActiveThreadId(),
          runningThreadIds: this.deps.getRunningThreadIds(),
          spawnedAt,
          intentional: this.intentionalConnectionIds.has(connectionId),
          stderrTail,
          sessionCountAtTermination: targetSessions.length,
          invalidatedThreadIds,
        });
      }
      const current = this.connections.get(descriptor.id);
      if (this.activeConnection?.process === child) this.activeConnection = null;
      if (current?.process === child) {
        this.connections.delete(descriptor.id);
        this.deps.invalidateAgentSessions(descriptor.id);
      }
    });

    this.deps.getMonitorObserver()?.onConnectionReady?.({
      connectionId,
      initializedAt: Date.now(),
    });

    return {
      connectionId,
      agentId: descriptor.id,
      driverId: descriptor.driverId ?? descriptor.id,
      agentInfoName,
      process: child,
      connection,
      agent: agentCtx,
      agentCapabilities,
      authMethods,
      authRequiredMessage: null,
      modelState,
      closed,
    };
  }
}
