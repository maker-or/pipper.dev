import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  ContentBlock,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type {
  AcpAgentDescriptor,
  AcpBridgeEvent,
  AcpPromptInput,
  AcpReplacePromptInput,
  AcpSessionState,
  AcpToolCallState,
} from "../contracts/acp.ts";
import type { OpenTabsState, Thread } from "../contracts/threads.ts";
import { commitThreadNavigation, readOpenTabsState } from "./open-tabs.ts";
import { getProject } from "./projects.ts";
import { getAppSetting, setAppSetting, getSelectedAgentIds } from "./db.ts";
import { setActiveProjectId } from "./session.ts";
import {
  getThread,
  listThreads,
  createThread as createThreadRow,
  updateThreadTitle,
  updateThreadAgentSessionId,
  touchThread,
  getThreadSortOrder,
  deleteThread as removeThreadRow,
} from "./threads.ts";
import { commitNavigation, readLaunchState, updateLaunchSelection } from "./launch-state.ts";
import { normalizeWorkspacePath, pickWorkspaceThread } from "../contracts/workspace-scope.ts";
import { isLiveWorktree } from "./worktree-manager.ts";
import { getAgentDescriptor, getDefaultAgentId, listRegisteredAgents } from "./agents/registry.ts";
import { listAgentInstanceDescriptors, hasAgentInstances } from "./agent-instances.ts";
import {
  ACP_SWITCH_PHASE_TIMEOUT_MS,
  ConnectionLifecycle,
  requestWithTimeout,
  type AgentMonitorObserver,
  type LiveConnection,
} from "./connection-lifecycle.ts";
import type { BrowserService } from "./browser/browser-service.ts";
import { listMcpServers, toAcpMcpServers } from "./mcp-servers.ts";
import { SubagentManager } from "./subagents/subagent-manager.ts";
import { TerminalManager } from "./terminal-manager.ts";
import type { AgentOsNotification, OsNotifier } from "./os-notifications.ts";
import type { WindowAttentionSource, WindowVisibilitySource } from "./window-visibility.ts";
import { WorkspaceGuard } from "./workspace-guard.ts";
import { ThreadSessionRegistry, type ThreadSessionRuntime } from "./thread-session-registry.ts";
import { SnapshotFreshness } from "./snapshot-freshness.ts";
import {
  ThreadSnapshotBodiesUnavailableError,
  ThreadSnapshotStore,
  hydrateSnapshotImages,
  snapshotImageRefs,
  type LoadedThreadSnapshot,
} from "./thread-snapshot-store.ts";
import {
  isActivationSuperseded,
  KeyedMutex,
  raceActivation,
  SelectionFence,
  type SelectionTicket,
} from "./activation.ts";
import { ProviderCatalogStore, sameModels, type CatalogModel } from "./provider-catalog-store.ts";
import { PermissionCoordinator } from "./permission-coordinator.ts";
import { ACP_PROMPT_TIMEOUT_MS, PromptScheduler } from "./prompt-scheduler.ts";
import { RendererBroadcaster } from "./renderer-broadcaster.ts";
import { waitBounded } from "./bounded-shutdown.ts";
import {
  applySessionUpdate,
  applySessionUpdateInPlace,
  applyTurnStop,
  appendLocalUserMessage,
  assemblePromptBlocks,
  createEmptySessionSlice,
  trimSessionSlice,
  type AcpSessionSlice,
} from "../src/lib/acp-session-reducer.ts";
import {
  SessionRetentionTracker,
  captureRetentionTail,
  estimateJsonBytes,
} from "../src/lib/session-retention.ts";
import {
  hydrateToolCalls,
  mergeToolCallPayload,
  payloadFromSessionUpdate,
  stripToolPayloadFromSessionUpdate,
  type ToolCallPayload,
} from "../src/lib/tool-call-payload.ts";
import type { AnalyticsEventName, AnalyticsProperties } from "./analytics-schema.ts";
import type {
  MonitorProcessDescriptor,
  MonitorSwitchPhase,
  MonitorSwitchRecord,
} from "../contracts/monitor.ts";

/** Persisted pointer to the last-used provider instance. */
const PREFERRED_INSTANCE_KEY = "preferred_agent_instance";
/**
 * Opt-in: minutes a provider may sit with no sessions, prompts, auth, catalog
 * probes or subagent runs before its process is released. Unset or 0 keeps
 * every used provider warm (the default), because releasing one makes the
 * next thread on it pay a cold start.
 */
const PROVIDER_IDLE_RELEASE_KEY = "provider_idle_release_minutes";
export const PROVIDER_IDLE_RELEASE_MIN_MINUTES = 30;
const PROVIDER_IDLE_RELEASE_MAX_MINUTES = 24 * 60;
const PROVIDER_IDLE_SWEEP_MS = 60_000;

function clampIdleReleaseMinutes(value: unknown): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(
    PROVIDER_IDLE_RELEASE_MAX_MINUTES,
    Math.max(PROVIDER_IDLE_RELEASE_MIN_MINUTES, Math.round(minutes)),
  );
}

function loadIdleReleaseMinutes(): number {
  try {
    return clampIdleReleaseMinutes(getAppSetting(PROVIDER_IDLE_RELEASE_KEY));
  } catch {
    return 0;
  }
}

/** What a thread's runtime preparation resolved, shared by every caller waiting on it. */
interface PreparedThread {
  thread: Thread;
  project: NonNullable<ReturnType<typeof getProject>>;
  runtime: ThreadSessionRuntime;
  live: LiveConnection;
  phase: MonitorSwitchPhase;
  openSource: "resident" | "replay" | "snapshot";
  restoreStartedAt: number;
}

/** A thread plus the validated cwd its session runs in. */
interface ThreadTarget {
  thread: Thread;
  project: NonNullable<ReturnType<typeof getProject>>;
  cwd: string;
}

function isPhaseTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message);
}

/**
 * How long dispose waits for snapshot writes before abandoning them. A write
 * replaces its generation atomically (temp file, rename, one row update), so an
 * abandoned or interrupted write leaves the previous snapshot intact.
 */
export const DISPOSE_SNAPSHOT_FLUSH_MS = 3_000;

function loadPreferredAgentId(): string {
  try {
    const stored = getAppSetting(PREFERRED_INSTANCE_KEY);
    if (stored && getAgentDescriptor(stored)) return stored;
  } catch {
    // Database may not be ready in some embedding contexts; fall back.
  }
  return getDefaultAgentId();
}

function persistPreferredAgentId(agentId: string): void {
  try {
    setAppSetting(PREFERRED_INSTANCE_KEY, agentId);
  } catch {
    // Non-fatal: preference simply won't survive a restart.
  }
}

function modelOptionsFromConfig(
  options: SessionConfigOption[] | undefined,
): Array<{ modelId: string; name: string; provider?: string }> {
  const option =
    options?.find((o) => o.category === "model") ?? options?.find((o) => o.id === "model");
  if (!option || option.type !== "select" || !Array.isArray(option.options)) return [];
  const out: Array<{ modelId: string; name: string; provider?: string }> = [];
  for (const item of option.options as Array<Record<string, unknown>>) {
    if (typeof item.value === "string") {
      let modelId = item.value;
      let name = typeof item.name === "string" ? item.name : item.value;
      if (modelId.includes("\t")) {
        const parts = modelId.split("\t");
        modelId = parts[1]?.trim() || parts[0]?.trim() || modelId;
        name = parts[1]?.trim() || name;
      }
      out.push({
        modelId,
        name,
        provider: typeof item.provider === "string" ? item.provider : undefined,
      });
      continue;
    }
    if (!Array.isArray(item.options)) continue;
    const provider = typeof item.name === "string" ? item.name : undefined;
    for (const nested of item.options as Array<Record<string, unknown>>) {
      if (typeof nested.value !== "string") continue;
      let modelId = nested.value;
      let name = typeof nested.name === "string" ? nested.name : nested.value;
      if (modelId.includes("\t")) {
        const parts = modelId.split("\t");
        modelId = parts[1]?.trim() || parts[0]?.trim() || modelId;
        name = parts[1]?.trim() || name;
      }
      out.push({
        modelId,
        name,
        provider: typeof nested.provider === "string" ? nested.provider : provider,
      });
    }
  }
  return out;
}

type SendToRenderer = (channel: string, payload: unknown) => void;
type EventSendToRenderer = (event: AcpBridgeEvent) => void;
type SetWindowTitle = (title: string) => void;
function jsonBytes(value: unknown): number {
  return estimateJsonBytes(value);
}

/**
 * True when an ACP request rejected with the protocol's `auth_required` error.
 * The SDK's `RequestError.authRequired()` helper emits code -32000 with an
 * "Authentication required" message; -32000 is a generic server-error code
 * reused for other failures (permission/turn), so we also match the message.
 */
function isAuthRequiredError(err: unknown): boolean {
  if (!(err instanceof acp.RequestError)) return false;
  return err.code === -32000 && /auth(?:entication)?[\s_-]*required/i.test(err.message);
}

/**
 * `O_NOFOLLOW` refuses to open a final path component that is a symlink, so a
 * symlink swapped in after the containment check can't redirect an agent's
 * read/write out of the workspace (TOCTOU). Unavailable on Windows — fall back
 * to plain flags there.
 */
const NO_FOLLOW = process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number";

/** Constant per platform; hoisted so agent fs requests don't rebuild them. */
const READ_FILE_OPTIONS: { encoding: "utf8"; flag?: number } = NO_FOLLOW
  ? { encoding: "utf8", flag: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW }
  : { encoding: "utf8" };

/** Constant per platform; hoisted so agent fs requests don't rebuild them. */
const WRITE_FILE_OPTIONS: { encoding: "utf8"; flag?: number } = NO_FOLLOW
  ? {
      encoding: "utf8",
      flag:
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    }
  : { encoding: "utf8" };

function emptySessionState(): AcpSessionState {
  return {
    projectId: null,
    threadId: null,
    agentId: null,
    agentSessionId: null,
    cwd: null,
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

/**
 * Spawns ACP agent processes, owns sessions, and bridges session/update to the renderer.
 * Replaces the pi-sdk AgentManager.
 */
export class AgentConnectionManager {
  private readonly sendToRenderer: SendToRenderer;
  private readonly setWindowTitle: SetWindowTitle;
  private readonly broadcastActiveProject?: (projectId: string) => void;
  private readonly captureAnalytics?: (
    name: AnalyticsEventName,
    properties: AnalyticsProperties,
  ) => void;
  private readonly setAgentContext?: (
    ctx: { agentId?: string | null; agentName?: string | null; modelId?: string | null } | null,
  ) => void;
  private readonly onRunningThreadsChanged?: (threadIds: string[]) => void;

  private activeProjectId: string | null = null;
  private activeThreadId: string | null = null;
  private preferredAgentId: string = loadPreferredAgentId();
  private readonly sessions = new ThreadSessionRegistry();
  /**
   * Session replay is delivered as session/update notifications while
   * session/load is still in flight. Keep those notifications in the main
   * process until the activation can publish one complete authoritative state.
   */
  private readonly loadingSessionThreads = new Set<string>();
  /** Resolves callers waiting to submit while a cached display restores ACP. */
  private readonly sessionReadyWaiters = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();
  private readonly snapshotStore = new ThreadSnapshotStore({
    isPinned: (threadId) => this.sessions.has(threadId),
  });
  private readonly snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly snapshotFreshness = new SnapshotFreshness();
  /** Tail of each thread's write chain: at most one active write plus one pending. */
  private readonly snapshotWriteChains = new Map<string, Promise<boolean>>();
  /** Set once dispose starts: no new debounced snapshot writes are scheduled. */
  private disposing = false;
  private disposed: Promise<void> | null = null;
  /** Queued writes that have not started; they capture the runtime when they run. */
  private readonly pendingSnapshotWrites = new Map<string, Promise<boolean>>();
  private readonly backgroundToolCallTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private snapshotPreloadTask: ReturnType<typeof setImmediate> | null = null;
  /** Consecutive failed snapshot writes; debounced writes back off while non-zero. */
  private snapshotWriteFailures = 0;
  private snapshotWritesBlockedUntil = 0;
  /** Per-session filesystem containment for agent reads/writes/terminals. */
  private readonly workspaceGuard = new WorkspaceGuard();
  private readonly permissions = new PermissionCoordinator({
    autoResponse: (params) => this.subagents.autoPermissionResponse(params),
    findThreadBySessionId: (sessionId) => this.findThreadBySessionId(sessionId),
    emit: (event) => this.emit(event),
    notifyIfHidden: (notification) => this.notifyIfHidden(notification),
    threadDisplayTitle: (threadId) => this.threadDisplayTitle(threadId),
  });
  private readonly prompts = new PromptScheduler();
  private readonly abortGenerations = new Map<string, number>();
  private readonly terminalManager: TerminalManager;
  private broadcaster!: RendererBroadcaster;
  private lifecycle!: ConnectionLifecycle;
  /** Client-hosted subagent tool: lets any session spawn sibling agent sessions. */
  private readonly subagents: SubagentManager;
  private readonly browser: BrowserService | null;
  /** Dedup key for the last broadcast running-threads set. */
  private lastRunningThreadsKey = "";
  /** Per tool-call start timestamps for `tool_call_finished` timing, keyed `${sessionId}:${toolCallId}`. */
  private readonly toolCallStarts = new Map<string, { startedAt: number; kind?: string }>();
  private monitorObserver: AgentMonitorObserver | null = null;
  /**
   * Orders active-selection commits. Preparation is not queued behind it: a
   * slow provider start never delays an unrelated resident switch.
   */
  private readonly selection = new SelectionFence();
  /** Per-thread exclusion for prepare, close and delete of the same thread. */
  private readonly threadMutations = new KeyedMutex();
  /** In-flight runtime preparation per thread; concurrent callers share it. */
  private readonly threadPreparations = new Map<string, Promise<PreparedThread>>();
  /** Persisted model catalogs, so pickers never start a provider just to list models. */
  private readonly catalogs: ProviderCatalogStore;
  /** Leases that keep a provider busy for idle release (prepares, creates, auth, probes). */
  private readonly providerLeases = new Map<string, number>();
  /** Last time each live provider was observed busy; drives opt-in idle release. */
  private readonly providerLastBusyAt = new Map<string, number>();
  private providerIdleReleaseMinutes = loadIdleReleaseMinutes();
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null;

  private currentEditorText = "";
  private turnSequence = 0;

  constructor(options: {
    sendToRenderer: SendToRenderer | EventSendToRenderer;
    setWindowTitle: SetWindowTitle;
    broadcastActiveProject?: (projectId: string) => void;
    captureAnalytics?: (name: AnalyticsEventName, properties: AnalyticsProperties) => void;
    onRunningThreadsChanged?: (threadIds: string[]) => void;
    setAgentContext?: (
      ctx: { agentId?: string | null; agentName?: string | null; modelId?: string | null } | null,
    ) => void;
    visibility?: WindowVisibilitySource;
    attention?: WindowAttentionSource;
    notify?: OsNotifier;
    /** App version for ACP `clientInfo`; defaults when unset (tests). */
    clientVersion?: string;
    /** Provider catalog cache file; defaults to userData (tests override). */
    catalogPath?: string;
    /** Headless browser exposed to sessions over MCP; omitted in tests. */
    browser?: BrowserService | null;
  }) {
    this.browser = options.browser ?? null;
    // Downloads from agent pages are approved in the session's thread, like
    // any other permission an agent asks for.
    this.browser?.setPermissionRequester(async ({ sessionId, title, detail }) => {
      const response = await this.permissions.handle(
        {
          sessionId,
          toolCall: {
            toolCallId: `browser-download-${randomUUID()}`,
            title,
            kind: "fetch",
            status: "pending",
            rawInput: detail,
          },
          options: [
            { optionId: "allow", name: "Download", kind: "allow_once" },
            { optionId: "deny", name: "Don't download", kind: "reject_once" },
          ],
        },
        null,
      );
      return response.outcome.outcome === "selected" && response.outcome.optionId === "allow";
    });
    this.browser?.setWidgetHooks({
      resolveThread: (sessionId) => this.findThreadBySessionId(sessionId),
      onWidgetUpdated: ({ widgetId, threadId }) =>
        this.emit({ type: "widget-updated", widgetId, threadId }),
    });
    this.catalogs = new ProviderCatalogStore({ path: options.catalogPath });
    this.sendToRenderer =
      options.sendToRenderer.length <= 1
        ? (_channel, payload) =>
            (options.sendToRenderer as EventSendToRenderer)(payload as AcpBridgeEvent)
        : (options.sendToRenderer as SendToRenderer);
    this.setWindowTitle = options.setWindowTitle;
    this.broadcastActiveProject = options.broadcastActiveProject;
    this.captureAnalytics = options.captureAnalytics;
    this.onRunningThreadsChanged = options.onRunningThreadsChanged;
    this.setAgentContext = options.setAgentContext;
    this.broadcaster = new RendererBroadcaster({
      send: this.sendToRenderer,
      visibility: options.visibility,
      attention: options.attention,
      notify: options.notify,
      getActiveThreadId: () => this.activeThreadId,
      getBridgeEventObserver: () => this.monitorObserver?.onBridgeEvent,
      flushAfterHiddenPeriod: () => this.flushCoalescedStateToRenderer(),
    });
    this.terminalManager = new TerminalManager({
      onOutput: (terminalId, chunk) => {
        this.emit({ type: "terminal-output", terminalId, output: chunk, append: true });
      },
    });
    this.subagents = new SubagentManager({
      host: {
        acquireConnection: async (agentId) => {
          const live = await this.acquireConnection(agentId);
          return {
            agentId: live.agentId,
            agentCapabilities: live.agentCapabilities,
            agent: live.agent,
          };
        },
        baseMcpServers: (caps) => toAcpMcpServers(listMcpServers(), caps.mcpCapabilities),
        emitEvent: (event) => this.emit(event),
      },
      captureAnalytics: (name, properties) => this.captureAnalytics?.(name, properties),
    });
    void this.subagents.init();
    this.lifecycle = new ConnectionLifecycle({
      terminal: this.terminalManager,
      clientVersion: options.clientVersion ?? "0.0.0",
      hooks: {
        onSessionUpdate: (sessionId, update) => this.handleSessionUpdate(sessionId, update),
        onRequestPermission: (params, requestId) => this.handlePermissionRequest(params, requestId),
        onReadTextFile: (params) => this.handleReadTextFile(params),
        onWriteTextFile: (params) => this.handleWriteTextFile(params),
        assertWithinWorkspace: (sessionId, targetPath) =>
          this.workspaceGuard.assertWithin(sessionId, targetPath),
      },
      getMonitorObserver: () => this.monitorObserver,
      getActiveThreadId: () => this.activeThreadId,
      getRunningThreadIds: () => this.getRunningThreadIds(),
      getSessionsByAgent: (agentId) =>
        [...this.sessions.values()]
          .filter((session) => session.agentId === agentId)
          .map((session) => ({
            threadId: session.threadId,
            agentSessionId: session.agentSessionId,
          })),
      invalidateAgentSessions: (agentId) => this.invalidateAgentSessions(agentId),
      onConnected: (agentId, connectDurationMs, installKind) =>
        this.captureAnalytics?.("agent_connected", {
          ...this.agentProps(agentId),
          connect_duration_ms: connectDurationMs,
          install_kind: installKind,
        } as AnalyticsProperties),
      onConnectFailed: (agentId, errorName) =>
        this.captureAnalytics?.("agent_connection_failed", {
          ...this.agentProps(agentId),
          error_type: errorName,
        } as AnalyticsProperties),
    });
    this.scheduleIdleSweep();
  }

  getSubagentConfig() {
    return this.subagents.getConfig();
  }

  setSubagentConfig(partial: Parameters<SubagentManager["setConfig"]>[0]) {
    return this.subagents.setConfig(partial);
  }

  getSubagentRuns() {
    return this.subagents.getRunSnapshots();
  }

  listAgents(): AcpAgentDescriptor[] {
    // Once instance storage is seeded, it is the source of truth: return the
    // enabled instances even when that list is empty (all accounts disabled).
    // Only fall back to the raw driver catalog in the uninitialized/legacy
    // state, so a disabled default account is never re-exposed as selectable.
    if (hasAgentInstances()) return listAgentInstanceDescriptors();
    return listRegisteredAgents();
  }

  /**
   * Reconcile a removed account: drop its cached sessions, close its process,
   * and move the preferred pointer off it. Thread rows are re-pointed at the
   * driver's default instance by `deleteAgentInstance`.
   */
  async removeAgentInstance(instanceId: string): Promise<void> {
    // Collect first: removing entries while iterating the registry would skip
    // siblings when several threads share the account.
    const ownedThreadIds: string[] = [];
    for (const [threadId, runtime] of this.sessions.entries()) {
      if (runtime.agentId === instanceId) ownedThreadIds.push(threadId);
    }
    for (const threadId of ownedThreadIds) {
      const runtime = this.sessions.get(threadId);
      if (!runtime) continue;
      this.permissions.cancelForSession(runtime.agentSessionId);
      this.prompts.cancelInFlight(threadId, "account removed");
      this.sessions.remove(threadId);
    }
    await this.lifecycle.close(instanceId);
    if (this.preferredAgentId === instanceId) {
      this.preferredAgentId = getDefaultAgentId();
      persistPreferredAgentId(this.preferredAgentId);
    }
  }

  /**
   * Model catalogs for pickers. Cached catalogs are returned immediately and
   * nothing is started to serve them: only `refresh` may start a provider,
   * and only the providers it names (e.g. the provider a draft targets that
   * has no catalog yet, which is about to be used anyway). Providers that are
   * already running refresh a missing or stale catalog in the background and
   * publish the result as a `model-catalogs` event.
   */
  async getModelCatalogs(
    options: { refresh?: readonly string[] } = {},
  ): Promise<Record<string, CatalogModel[]>> {
    await this.catalogs.load();
    const refreshIds = [...new Set(options.refresh ?? [])].filter((id) => getAgentDescriptor(id));
    // Explicit refresh is awaited so the caller receives the fresh catalog.
    await Promise.all(refreshIds.map((agentId) => this.refreshCatalog(agentId, { start: true })));

    const agentIds = new Set([...this.catalogAgentIds(), ...refreshIds]);
    // A provider used before keeps its catalog visible, as long as it exists.
    for (const agentId of this.catalogs.agentIds()) {
      if (getAgentDescriptor(agentId)) agentIds.add(agentId);
    }
    for (const runtime of this.sessions.values()) agentIds.add(runtime.agentId);
    for (const live of this.lifecycle.all()) agentIds.add(live.agentId);
    for (const agentId of agentIds) {
      if (refreshIds.includes(agentId)) continue;
      if (!this.lifecycle.getCached(agentId) || !this.catalogs.needsRefresh(agentId)) continue;
      void this.refreshCatalog(agentId, { start: false });
    }

    const result: Record<string, CatalogModel[]> = {};
    for (const agentId of agentIds) {
      const models = this.catalogs.get(agentId);
      if (models?.length) result[agentId] = models;
    }
    return result;
  }

  /**
   * Selections are provider-level (a driver id or a default instance id), but
   * catalogs are keyed per instance: include every enabled instance whose
   * driver is selected so accounts added later in Settings appear too.
   */
  private catalogAgentIds(): string[] {
    const selectedAgentIds = getSelectedAgentIds();
    const selectedSet = new Set(selectedAgentIds);
    const ids = new Set(selectedAgentIds);
    for (const instance of listAgentInstanceDescriptors()) {
      const driver = instance.driverId ?? instance.id;
      if (selectedSet.has(instance.id) || selectedSet.has(driver)) ids.add(instance.id);
    }
    return [...ids];
  }

  /**
   * Refresh one provider's catalog; concurrent refreshes share one probe.
   * With `start: false` a provider that is not already running is skipped,
   * so background refreshes never spawn a process.
   */
  private async refreshCatalog(agentId: string, opts: { start: boolean }): Promise<void> {
    const before = this.catalogs.get(agentId);
    const models = await this.catalogs.refresh(agentId, async () => {
      const live = opts.start
        ? await this.acquireConnection(agentId).catch(() => null)
        : (this.lifecycle.getCached(agentId) ?? null);
      if (!live) return null;
      return this.withProviderLease(live.agentId, () => this.probeCatalog(live));
    });
    if (models && !(before && sameModels(before, models))) this.emitCatalog(agentId, models);
  }

  /**
   * Read a running provider's models: initialize metadata or a resident
   * session's options when available, else a temporary session that is closed
   * again (several ACP agents only advertise models from session/new).
   */
  private async probeCatalog(live: LiveConnection): Promise<CatalogModel[] | null> {
    const fromInit = (live.modelState?.availableModels ?? []).map((model) => ({
      modelId: model.modelId,
      name: model.name,
    }));
    if (fromInit.length) return fromInit;
    for (const runtime of this.sessions.values()) {
      if (runtime.agentId !== live.agentId) continue;
      const models = modelOptionsFromConfig(runtime.slice.configOptions);
      if (models.length) return models;
    }
    const cwd =
      (await this.getActiveCwd()) ??
      (this.activeProjectId
        ? (getProject(this.activeProjectId)?.path ?? process.cwd())
        : process.cwd());
    let attached: Awaited<ReturnType<typeof this.sessionMcpServers>> | null = null;
    let sessionId: string | null = null;
    try {
      attached = await this.sessionMcpServers(live, cwd);
      const request = live.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: attached.servers as never,
      }) as Promise<{ sessionId: string; configOptions?: SessionConfigOption[] | null }>;
      let created: Awaited<typeof request>;
      try {
        created = await requestWithTimeout(
          request,
          ACP_SWITCH_PHASE_TIMEOUT_MS,
          "agent/model-catalog-session-new",
        );
      } catch (error) {
        this.closeLateSession(live, request);
        throw error;
      }
      sessionId = created.sessionId;
      const models = modelOptionsFromConfig(
        this.withModelOption(live, created.configOptions ?? []),
      );
      return models.length ? models : null;
    } finally {
      if (sessionId) {
        try {
          await requestWithTimeout(
            live.agent.request(acp.methods.agent.session.close, { sessionId }),
            ACP_SWITCH_PHASE_TIMEOUT_MS,
            "agent/model-catalog-session-close",
          );
        } catch {
          // best effort
        }
      }
      attached?.release();
    }
  }

  /** Record models a session or initialize reply advertised; publish when they changed. */
  private recordCatalog(agentId: string, models: CatalogModel[]): void {
    if (!models.length || !this.catalogs.record(agentId, models)) return;
    this.emitCatalog(agentId, this.catalogs.get(agentId) ?? models);
  }

  private emitCatalog(agentId: string, models: CatalogModel[]): void {
    this.emit({ type: "model-catalogs", catalogs: { [agentId]: models } });
  }

  /** Mark a provider busy for idle release while `task` runs. */
  private async withProviderLease<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    this.providerLeases.set(agentId, (this.providerLeases.get(agentId) ?? 0) + 1);
    this.providerLastBusyAt.set(agentId, Date.now());
    try {
      return await task();
    } finally {
      const remaining = (this.providerLeases.get(agentId) ?? 1) - 1;
      if (remaining > 0) this.providerLeases.set(agentId, remaining);
      else this.providerLeases.delete(agentId);
      this.providerLastBusyAt.set(agentId, Date.now());
    }
  }

  getProviderIdleReleaseMinutes(): number {
    return this.providerIdleReleaseMinutes;
  }

  /**
   * Opt in to releasing idle providers. 0 disables it (the default); other
   * values are clamped to at least PROVIDER_IDLE_RELEASE_MIN_MINUTES.
   */
  setProviderIdleReleaseMinutes(minutes: number): number {
    this.providerIdleReleaseMinutes = clampIdleReleaseMinutes(minutes);
    try {
      setAppSetting(PROVIDER_IDLE_RELEASE_KEY, String(this.providerIdleReleaseMinutes));
    } catch {
      // Non-fatal: the setting applies for this run only.
    }
    this.scheduleIdleSweep();
    return this.providerIdleReleaseMinutes;
  }

  private scheduleIdleSweep(): void {
    if (this.idleSweepTimer) clearInterval(this.idleSweepTimer);
    this.idleSweepTimer = null;
    if (this.providerIdleReleaseMinutes <= 0) return;
    this.idleSweepTimer = setInterval(() => {
      void this.releaseIdleProviders();
    }, PROVIDER_IDLE_SWEEP_MS);
    this.idleSweepTimer.unref?.();
  }

  /** A provider is busy while anything could still need its process. */
  private providerBusy(agentId: string): boolean {
    if (this.providerLeases.has(agentId)) return true;
    if (this.catalogs.isRefreshing(agentId)) return true;
    if (this.subagents.hasActiveRunsForAgent(agentId)) return true;
    for (const runtime of this.sessions.values()) {
      if (runtime.agentId === agentId) return true;
    }
    return false;
  }

  /**
   * Release providers idle for the configured period. The preferred provider
   * (where new threads start) and the composer's active provider stay warm.
   * Returns the released provider ids.
   */
  private async releaseIdleProviders(now = Date.now()): Promise<string[]> {
    const thresholdMs = this.providerIdleReleaseMinutes * 60_000;
    if (thresholdMs <= 0) return [];
    const liveIds = new Set<string>();
    const released: string[] = [];
    for (const live of this.lifecycle.all()) {
      const agentId = live.agentId;
      liveIds.add(agentId);
      if (this.providerBusy(agentId)) {
        this.providerLastBusyAt.set(agentId, now);
        continue;
      }
      if (agentId === this.preferredAgentId || this.lifecycle.active === live) continue;
      const lastBusyAt = this.providerLastBusyAt.get(agentId);
      if (lastBusyAt == null) {
        this.providerLastBusyAt.set(agentId, now);
        continue;
      }
      if (now - lastBusyAt < thresholdMs) continue;
      released.push(agentId);
    }
    for (const agentId of this.providerLastBusyAt.keys()) {
      if (!liveIds.has(agentId)) this.providerLastBusyAt.delete(agentId);
    }
    for (const agentId of released) {
      this.providerLastBusyAt.delete(agentId);
      await this.lifecycle.close(agentId);
    }
    return released;
  }

  async getToolCalls(
    threadId: string,
    requestedIds?: readonly string[],
  ): Promise<Record<string, AcpToolCallState>> {
    const runtime = this.sessions.get(threadId);
    if (!runtime) return {};
    const ids = requestedIds?.length
      ? requestedIds.filter((id) => Boolean(runtime.slice.toolCalls[id]))
      : Object.keys(runtime.slice.toolCalls);
    const payloads = this.payloadsFor(runtime);
    // Persisted bodies are request-scoped. Keeping every expanded trace in
    // runtime.toolPayloads defeated snapshot eviction until the next write.
    let selectedPayloads: ReadonlyMap<string, ToolCallPayload> = payloads;
    const missingIds = ids.filter(
      (id) => runtime.slice.toolCalls[id]?.hasPayload && !payloads.has(id),
    );
    if (missingIds.length > 0 && runtime.snapshotPayloadSource) {
      try {
        const restored = await this.snapshotStore.loadPayloads(
          runtime.snapshotPayloadSource,
          missingIds,
        );
        if (this.sessions.get(threadId) === runtime) {
          // Live updates can arrive while the sidecar is being read; prefer
          // their newer bodies over the persisted generation.
          selectedPayloads = new Map([...restored, ...payloads]);
        }
      } catch (error) {
        console.warn(`[thread-snapshot] selective payload restore failed for ${threadId}:`, error);
        runtime.snapshotPayloadSource = undefined;
        void this.deletePersistedSnapshot(threadId);
      }
    }
    const selected = Object.fromEntries(
      ids.map((id) => [id, runtime.slice.toolCalls[id]]).filter(([, toolCall]) => toolCall),
    ) as Record<string, AcpToolCallState>;
    return hydrateToolCalls(selected, selectedPayloads);
  }

  private payloadsFor(runtime: ThreadSessionRuntime): Map<string, ToolCallPayload> {
    if (!runtime.toolPayloads) runtime.toolPayloads = new Map();
    return runtime.toolPayloads;
  }

  private beginThreadLoad(threadId: string): void {
    this.loadingSessionThreads.add(threadId);
    if (this.sessionReadyWaiters.has(threadId)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.sessionReadyWaiters.set(threadId, { promise, resolve });
  }

  private endThreadLoad(threadId: string): void {
    this.loadingSessionThreads.delete(threadId);
    const waiter = this.sessionReadyWaiters.get(threadId);
    this.sessionReadyWaiters.delete(threadId);
    waiter?.resolve();
  }

  private async waitForThreadReady(threadId: string): Promise<void> {
    await this.sessionReadyWaiters.get(threadId)?.promise;
    const runtime = this.sessions.get(threadId);
    if (!runtime || runtime.agentReady === false) {
      throw new Error("The agent session is not ready for this thread.");
    }
  }

  private retentionFor(runtime: ThreadSessionRuntime): SessionRetentionTracker {
    if (!runtime.retention) runtime.retention = new SessionRetentionTracker();
    return runtime.retention;
  }

  private syncPayloadsFor(
    slice: AcpSessionSlice,
    payloads: Map<string, ToolCallPayload>,
    update: SessionUpdate,
  ): void {
    const extracted = payloadFromSessionUpdate(update);
    if (extracted) {
      payloads.set(
        extracted.toolCallId,
        mergeToolCallPayload(payloads.get(extracted.toolCallId), extracted.payload),
      );
    }
    // Orphans can only appear when the reducer replaced the record with a
    // smaller one (trim). Chunk-heavy streams keep the record reference-equal,
    // so this scan runs per tool-call mutation instead of per streamed chunk.
    for (const id of payloads.keys()) {
      if (!slice.toolCalls[id]) payloads.delete(id);
    }
  }

  private syncToolPayloads(runtime: ThreadSessionRuntime, update: SessionUpdate): void {
    const previous = runtime.lastSyncedToolCalls;
    const extracted = payloadFromSessionUpdate(update);
    if (runtime.slice.toolCalls === previous && !extracted) return;
    this.syncPayloadsFor(runtime.slice, this.payloadsFor(runtime), update);
    runtime.lastSyncedToolCalls = runtime.slice.toolCalls;
    if (extracted) runtime.payloadRevision = (runtime.payloadRevision ?? 0) + 1;
  }

  private evictOrphanToolPayloads(runtime: ThreadSessionRuntime): void {
    const payloads = this.payloadsFor(runtime);
    for (const id of payloads.keys()) {
      if (!runtime.slice.toolCalls[id]) payloads.delete(id);
    }
  }

  private scheduleSnapshot(runtime: ThreadSessionRuntime): void {
    if (this.disposing || !this.snapshotStore.enabled || runtime.snapshotDirty === false) return;
    this.snapshotFreshness.noteSettled(runtime.threadId);
    const existing = this.snapshotTimers.get(runtime.threadId);
    if (existing) clearTimeout(existing);
    // While storage is failing, debounced writes wait out the backoff instead
    // of hammering a full or broken disk. Explicit flushes still try once.
    const delay = Math.max(2_000, this.snapshotWritesBlockedUntil - Date.now());
    const timer = setTimeout(() => {
      this.snapshotTimers.delete(runtime.threadId);
      void this.queueSnapshotWrite(runtime);
    }, delay);
    timer.unref?.();
    this.snapshotTimers.set(runtime.threadId, timer);
  }

  private snapshotWritable(runtime: ThreadSessionRuntime): boolean {
    return (
      this.snapshotStore.enabled &&
      !runtime.slice.isStreaming &&
      !runtime.promptInFlight &&
      !this.loadingSessionThreads.has(runtime.threadId) &&
      runtime.agentReady !== false
    );
  }

  /**
   * Queue a display-snapshot write. Resolves true only when the runtime's
   * state is on disk: written by this request, or already clean. A failed,
   * skipped (turn in progress) or store-disabled write resolves false.
   * Requests made while a write is already pending share it:
   * the pending write captures the runtime when it starts, so it persists the
   * latest revision and retains one input per thread instead of one per call.
   */
  private queueSnapshotWrite(runtime: ThreadSessionRuntime): Promise<boolean> {
    if (!this.snapshotWritable(runtime)) return Promise.resolve(runtime.snapshotDirty === false);
    const threadId = runtime.threadId;
    const pending = this.pendingSnapshotWrites.get(threadId);
    if (pending) return pending;
    const previous = this.snapshotWriteChains.get(threadId) ?? Promise.resolve(true);
    const write: Promise<boolean> = previous
      .catch(() => false)
      .then(() => {
        if (this.pendingSnapshotWrites.get(threadId) === write) {
          this.pendingSnapshotWrites.delete(threadId);
        }
        return this.writeSnapshotNow(runtime);
      })
      .finally(() => {
        if (this.snapshotWriteChains.get(threadId) === write) {
          this.snapshotWriteChains.delete(threadId);
        }
      });
    this.pendingSnapshotWrites.set(threadId, write);
    this.snapshotWriteChains.set(threadId, write);
    return write;
  }

  private async writeSnapshotNow(runtime: ThreadSessionRuntime): Promise<boolean> {
    // A turn may have started while this write waited behind the previous one;
    // settling that turn schedules the next write.
    if (!this.snapshotWritable(runtime)) return runtime.snapshotDirty === false;
    const slice = runtime.slice;
    const payloadRevision = runtime.payloadRevision ?? 0;
    const baseSnapshot = runtime.snapshotPayloadSource;
    try {
      const snapshot = await this.snapshotStore.write({
        threadId: runtime.threadId,
        agentSessionId: runtime.agentSessionId,
        agentId: runtime.agentId,
        slice,
        payloads: new Map(this.payloadsFor(runtime)),
        // Resolve the base generation only after the prior per-thread write
        // settles; that write may have atomically replaced and unlinked it.
        baseSnapshot,
      });
      this.snapshotWriteFailures = 0;
      this.snapshotWritesBlockedUntil = 0;
      if (!snapshot) return false;
      this.snapshotFreshness.notePersisted(runtime.threadId);
      if (this.sessions.get(runtime.threadId) !== runtime) return true;
      runtime.snapshotPayloadSource = snapshot;
      if ((runtime.payloadRevision ?? 0) === payloadRevision) {
        // The immutable sidecar is now the backing store. Keep the main
        // process lean; individual trace/diff payloads reload on demand.
        this.payloadsFor(runtime).clear();
        if (runtime.slice === slice) runtime.snapshotDirty = false;
      }
      return true;
    } catch (error) {
      // Back off globally (one disk serves every thread) but never disable
      // writes for the rest of the session: the next success resets it. Live
      // payloads stay in memory because they were not persisted.
      this.snapshotWriteFailures++;
      const backoffMs = Math.min(5 * 60_000, 2_000 * 2 ** (this.snapshotWriteFailures - 1));
      this.snapshotWritesBlockedUntil = Date.now() + backoffMs;
      if (this.snapshotWriteFailures === 1) {
        console.warn("[thread-snapshot] write failed; retrying with backoff:", error);
      }
      const baseUnreadable =
        error instanceof ThreadSnapshotBodiesUnavailableError ||
        ((error as NodeJS.ErrnoException | null)?.code === "ENOENT" &&
          (error as NodeJS.ErrnoException).path === baseSnapshot?.payloadPath);
      if (baseSnapshot && runtime.snapshotPayloadSource === baseSnapshot && baseUnreadable) {
        // The generation this write copies from is gone or corrupt. Retrying
        // against it can never succeed; write what is still in memory instead.
        runtime.snapshotPayloadSource = undefined;
      }
      if (this.sessions.get(runtime.threadId) === runtime) this.scheduleSnapshot(runtime);
      return false;
    }
  }

  /**
   * Large images in a restored transcript paint as placeholders; their stored
   * content follows right after the first paint.
   */
  private async hydrateSnapshotImages(
    runtime: ThreadSessionRuntime,
    snapshot: LoadedThreadSnapshot,
  ): Promise<void> {
    const refs = snapshotImageRefs(snapshot.slice);
    if (refs.length === 0) return;
    try {
      const images = await this.snapshotStore.loadImages(snapshot, refs);
      if (this.sessions.get(runtime.threadId) !== runtime) return;
      // The replay may already have replaced the slice; only placeholders
      // that are still present are filled in.
      const entries = hydrateSnapshotImages(runtime.slice.entries, images);
      if (!entries) return;
      runtime.slice = { ...runtime.slice, entries };
      this.pushState(runtime.threadId);
    } catch (error) {
      console.warn(`[thread-snapshot] image restore failed for ${runtime.threadId}:`, error);
    }
  }

  private flushRuntimeSnapshot(runtime: ThreadSessionRuntime): Promise<boolean> {
    const timer = this.snapshotTimers.get(runtime.threadId);
    if (timer) clearTimeout(timer);
    this.snapshotTimers.delete(runtime.threadId);
    return this.queueSnapshotWrite(runtime);
  }

  /** Display-cache freshness and disk budget categories (diagnostics, benchmarks). */
  snapshotStorageStats() {
    return {
      freshness: this.snapshotFreshness.summary(),
      usage: this.snapshotStore.enabled ? this.snapshotStore.storageUsage() : null,
    };
  }

  /** Force a settled snapshot to disk (used by benchmark setup and shutdown). */
  async flushThreadSnapshot(threadId: string): Promise<boolean> {
    const runtime = this.sessions.get(threadId);
    if (!runtime || runtime.agentReady === false || this.loadingSessionThreads.has(threadId)) {
      return false;
    }
    return this.flushRuntimeSnapshot(runtime);
  }

  private async flushAllSnapshots(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((runtime) => this.flushRuntimeSnapshot(runtime)),
    );
    await Promise.all(this.snapshotWriteChains.values());
  }

  private async deletePersistedSnapshot(threadId: string): Promise<void> {
    this.snapshotFreshness.forget(threadId);
    const timer = this.snapshotTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.snapshotTimers.delete(threadId);
    await this.snapshotWriteChains.get(threadId)?.catch(() => undefined);
    await this.snapshotStore.delete(threadId).catch((error) => {
      console.warn(`[thread-snapshot] delete failed for ${threadId}:`, error);
    });
  }

  private settleRuntime(runtime: ThreadSessionRuntime): void {
    runtime.slice = applyTurnStop(runtime.slice);
    this.flushBackgroundToolCalls(runtime);
    this.scheduleSnapshot(runtime);
  }

  private scheduleBackgroundToolCalls(runtime: ThreadSessionRuntime): void {
    runtime.backgroundToolCallsDirty = true;
    if (this.backgroundToolCallTimers.has(runtime.threadId)) return;
    const timer = setTimeout(() => {
      this.backgroundToolCallTimers.delete(runtime.threadId);
      this.flushBackgroundToolCalls(runtime);
    }, 100);
    timer.unref?.();
    this.backgroundToolCallTimers.set(runtime.threadId, timer);
  }

  private flushBackgroundToolCalls(runtime: ThreadSessionRuntime): void {
    const timer = this.backgroundToolCallTimers.get(runtime.threadId);
    if (timer) clearTimeout(timer);
    this.backgroundToolCallTimers.delete(runtime.threadId);
    if (!runtime.backgroundToolCallsDirty || this.sessions.get(runtime.threadId) !== runtime) {
      return;
    }
    runtime.backgroundToolCallsDirty = false;
    runtime.emittedToolCalls = runtime.slice.toolCalls;
    this.emit({
      type: "thread-tool-calls",
      threadId: runtime.threadId,
      toolCalls: runtime.slice.toolCalls,
    });
  }

  private async yieldAfterBackgroundWork(
    runtime: ThreadSessionRuntime,
    loading: boolean,
  ): Promise<void> {
    if (!loading && runtime.threadId === this.activeThreadId) return;
    const now = performance.now();
    runtime.backgroundWorkStartedAt ??= now;
    runtime.backgroundUpdatesSinceYield = (runtime.backgroundUpdatesSinceYield ?? 0) + 1;
    if (runtime.backgroundUpdatesSinceYield < 32 && now - runtime.backgroundWorkStartedAt < 4) {
      return;
    }
    runtime.backgroundUpdatesSinceYield = 0;
    runtime.backgroundWorkStartedAt = performance.now();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private scheduleAdjacentSnapshotPreload(activeThread: Thread): void {
    if (!this.snapshotStore.enabled) return;
    if (this.snapshotPreloadTask) clearImmediate(this.snapshotPreloadTask);
    const candidates = listThreads()
      .filter(
        (thread) =>
          thread.id !== activeThread.id &&
          thread.project_id === activeThread.project_id &&
          (thread.worktree_path ?? null) === (activeThread.worktree_path ?? null) &&
          !this.sessions.has(thread.id),
      )
      .slice(0, 2);
    if (candidates.length === 0) return;
    this.snapshotPreloadTask = setImmediate(() => {
      this.snapshotPreloadTask = null;
      try {
        this.snapshotStore.preload(candidates);
      } catch (error) {
        console.warn("[thread-snapshot] adjacent preload failed:", error);
      }
    });
  }

  private mergePendingLocalEntries(
    runtime: ThreadSessionRuntime,
    slice: AcpSessionSlice,
  ): AcpSessionSlice {
    const pending = runtime.pendingLocalEntries ?? [];
    runtime.pendingLocalEntries = [];
    if (pending.length === 0) return applyTurnStop(slice);
    const settled = applyTurnStop(slice);
    return trimSessionSlice({
      ...settled,
      entries: [...settled.entries, ...pending],
      isStreaming: true,
    });
  }

  getPreferredAgentId(): string {
    return this.preferredAgentId;
  }

  setPreferredAgentId(agentId: string): void {
    const agent = getAgentDescriptor(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    if (agent.available === false) {
      throw new Error(
        agent.statusMessage ??
          `${agent.displayName} is not installed. ${agent.installHint ?? ""}`.trim(),
      );
    }
    this.preferredAgentId = agentId;
    persistPreferredAgentId(agentId);
  }

  /** Bridge-event output goes through RendererBroadcaster (see that module). */
  private emit(payload: AcpBridgeEvent): void {
    this.broadcaster.emit(payload);
  }

  /**
   * Catch the renderer up after a hidden period without replaying the delta
   * storm: one authoritative session-state for the displayed thread, plus any
   * tool-call records that drifted from their emission watermark (the same
   * reference-equality guard handleSessionUpdate uses per update).
   */
  private flushCoalescedStateToRenderer(): void {
    this.pushState(this.activeThreadId);
    for (const runtime of this.sessions.values()) {
      if (!this.sessions.has(runtime.threadId)) continue;
      if (runtime.slice.toolCalls === runtime.emittedToolCalls) continue;
      runtime.emittedToolCalls = runtime.slice.toolCalls;
      this.emit({
        type: "thread-tool-calls",
        threadId: runtime.threadId,
        toolCalls: runtime.slice.toolCalls,
      });
    }
  }

  private threadDisplayTitle(threadId: string | null | undefined): string | null {
    if (!threadId) return null;
    const runtime = this.sessions.get(threadId);
    if (runtime?.slice.title) return runtime.slice.title;
    return getThread(threadId)?.title ?? null;
  }

  private notifyIfHidden(notification: AgentOsNotification): void {
    this.broadcaster.notifyIfHidden(notification);
  }

  getState(): AcpSessionState {
    const threadId = this.activeThreadId;
    if (!threadId) {
      return {
        ...emptySessionState(),
        projectId: this.activeProjectId,
        agentId: this.lifecycle.active?.agentId ?? this.preferredAgentId,
        authRequiredMessage: this.authMessage(),
      };
    }
    return this.buildSessionState(threadId);
  }

  isThreadLoading(threadId: string): boolean {
    return this.loadingSessionThreads.has(threadId);
  }

  /**
   * The active thread's working directory — its bound worktree (validated), else
   * the project root. This is the app's single source of truth for "where am I",
   * so file listings and other cwd-relative surfaces follow a worktree switch
   * automatically (switching a worktree switches the active thread).
   */
  async getActiveCwd(): Promise<string | null> {
    const threadId = this.activeThreadId;
    if (!threadId) return null;
    const runtime = this.sessions.get(threadId);
    if (runtime) return runtime.cwd;
    const thread = getThread(threadId);
    if (!thread) return null;
    const project = getProject(thread.project_id);
    if (!project) return null;
    return this.resolveThreadCwd(thread.worktree_path, project.path);
  }

  /** Text-only transcript for the phone PWA: no tool calls, no streaming.
   * Returns accumulated agent_text + user_text so the phone can show the
   * entire final message at once when the turn ends. Falls back to the
   * persisted snapshot when the thread is not resident in memory. */
  /** The thread's model selector, for the phone. Null when the thread is not
   * loaded in memory or its agent exposes no model choice. */
  getThreadModel(threadId: string): {
    configId: string;
    current: string | null;
    options: Array<{ id: string; name: string }>;
  } | null {
    const runtime = this.sessions.get(threadId);
    if (!runtime) return null;
    const option = runtime.slice.configOptions.find(
      (o) => o.category === "model" || o.id === "model",
    );
    if (!option) return null;
    const options = modelOptionsFromConfig([option]).map((m) => ({ id: m.modelId, name: m.name }));
    if (!options.length) return null;
    const current = (option as { currentValue?: unknown }).currentValue;
    return {
      configId: option.id,
      current: typeof current === "string" ? current : null,
      options,
    };
  }

  getThreadTranscript(threadId: string): {
    finalText: string | null;
    messages: Array<{ role: "user" | "agent"; text: string }>;
  } {
    const runtime = this.sessions.get(threadId);
    const entries =
      runtime?.slice.entries ??
      (() => {
        try {
          const thread = getThread(threadId);
          if (!thread) return [];
          return this.snapshotStore.load(thread)?.slice.entries ?? [];
        } catch {
          return [];
        }
      })();
    const streaming = runtime?.slice.isStreaming ?? false;
    const messages: Array<{ role: "user" | "agent"; text: string }> = [];
    for (const e of entries) {
      if (e.type === "agent_text" && e.text.trim()) messages.push({ role: "agent", text: e.text });
      else if (e.type === "user_text" && e.text.trim())
        messages.push({ role: "user", text: e.text });
    }
    if (streaming) {
      // No-stream contract: agent text after the last user message belongs to
      // the in-progress turn — hold it back until the turn settles. Completed
      // turns (agent text followed by a later user message) still show.
      const lastUser = messages.map((m) => m.role).lastIndexOf("user");
      if (lastUser >= 0) {
        for (let i = messages.length - 1; i > lastUser; i--) {
          if (messages[i]?.role === "agent") messages.splice(i, 1);
        }
      } else {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === "agent") messages.splice(i, 1);
        }
      }
    }
    // Total character budget across messages (not just entry count — one
    // agent entry can hold a whole concatenated reply). Trim oldest first,
    // always keeping the tail so recent context survives.
    const MESSAGE_BUDGET = 16000;
    let total = messages.reduce((n, m) => n + m.text.length, 0);
    while (messages.length > 1 && total > MESSAGE_BUDGET) {
      total -= messages.shift()?.text.length ?? 0;
    }
    if (messages[0] && total > MESSAGE_BUDGET) {
      messages[0] = { ...messages[0], text: `…${messages[0].text.slice(-MESSAGE_BUDGET)}` };
    }
    const agentTexts = messages.filter((m) => m.role === "agent").map((m) => m.text);
    const joined = agentTexts.join("\n\n").trim();
    // Cap payload for the phone poll; desktop keeps full history.
    const finalText = joined ? joined.slice(-8000) : null;
    return { finalText, messages: messages.slice(-50) };
  }

  /** Clear the live view when the user closes the last open thread tab. */
  async clearActiveThread(): Promise<void> {
    this.activeThreadId = null;
    await updateLaunchSelection({ projectId: this.activeProjectId, threadId: null });
    this.pushState(null);
  }

  private authMessage(): string | null {
    // Only surfaced after a real `auth_required` failure from `session/new`.
    // An agent advertising `authMethods` at `initialize` is NOT a sign-in
    // signal — signed-in agents advertise them too — so we must not nag based
    // on that alone (that false positive is what made onboarding unreliable).
    return this.lifecycle.active?.authRequiredMessage ?? null;
  }

  /**
   * Record a genuine "not signed in" signal. Only an ACP `auth_required`
   * rejection proves it — advertising `authMethods` at `initialize` does not —
   * so every session phase records it the same way for `authMessage()` and the
   * renderer's persistent auth banner.
   */
  private recordAuthRequired(live: LiveConnection, error: unknown): void {
    if (!isAuthRequiredError(error)) return;
    const descriptor = getAgentDescriptor(live.agentId);
    live.authRequiredMessage =
      descriptor?.authHint ??
      `${descriptor?.displayName ?? live.agentId} requires authentication. Please sign in from your terminal first.`;
  }

  /**
   * A snapshot-restored Antigravity thread stays displayable when its agent
   * session cannot be established — a legacy `pipper-agy-` id the official
   * server cannot resume, a missing install, a sign-in failure. Removing the
   * runtime would blank the transcript the user opened the project for, so
   * keep it with `agentReady: false` (prompts reject via `waitForThreadReady`)
   * and drop any partial replay so a later retry does not append onto it.
   * Other agents keep the existing eviction: their fallback chain already
   * tried load → resume → new, so a failure there is a dead placeholder.
   */
  private preserveSnapshotRuntimeAfterFailure(
    threadId: string,
    runtime: ThreadSessionRuntime | undefined,
  ): boolean {
    if (!runtime || runtime.agentReady !== false || !runtime.snapshotRestored) return false;
    if (runtime.agentId !== "antigravity-acp") return false;
    // A prompt queued onto the in-flight load was appended optimistically; the
    // failed load never delivered it, so it must not be published as history.
    const pending = runtime.pendingLocalEntries ?? [];
    if (pending.length > 0) {
      const pendingIds = new Set(pending.map((entry) => entry.id));
      runtime.slice = {
        ...runtime.slice,
        entries: runtime.slice.entries.filter((entry) => !pendingIds.has(entry.id)),
        isStreaming: false,
      };
    }
    runtime.pendingLocalEntries = [];
    runtime.replaySlice = undefined;
    runtime.replayToolPayloads = undefined;
    this.endThreadLoad(threadId);
    this.pushState(threadId);
    return true;
  }

  private buildSessionState(threadId: string): AcpSessionState {
    const runtime = this.sessions.get(threadId);
    const thread = getThread(threadId);
    if (!runtime) {
      return {
        ...emptySessionState(),
        projectId: thread?.project_id ?? this.activeProjectId,
        threadId,
        agentId: thread?.agent_id ?? this.lifecycle.active?.agentId ?? null,
        agentSessionId: thread?.agent_session_id ?? null,
        title: thread?.title ?? null,
        authRequiredMessage: this.authMessage(),
      };
    }
    return {
      projectId: runtime.projectId,
      threadId: runtime.threadId,
      agentId: runtime.agentId,
      agentSessionId: runtime.agentSessionId,
      cwd: runtime.cwd,
      title: runtime.slice.title ?? thread?.title ?? null,
      configOptions: runtime.slice.configOptions,
      commands: runtime.slice.commands,
      entries: runtime.slice.entries,
      toolCalls: runtime.slice.toolCalls,
      plan: runtime.slice.plan,
      usage: runtime.slice.usage,
      currentModeId: runtime.slice.currentModeId,
      isStreaming: runtime.slice.isStreaming,
      isCompacting: false,
      editorText: runtime.editorText,
      authRequiredMessage: this.connectionForAgent(runtime.agentId)?.authRequiredMessage ?? null,
      switchingAgent: false,
    };
  }

  private pushState(threadId?: string | null): void {
    const id = threadId ?? this.activeThreadId;
    // Only the ACTIVE thread's state may become the renderer's snapshot. A
    // background thread's turn completing — or an abandoned session settling
    // after a switch — must not clobber the view the user is looking at
    // (snapshot cwd/thread drive the header workspace mirror and tab focus).
    // Its streaming flags still reach the tab strip via running-threads.
    if (id && id !== this.activeThreadId) {
      this.emitRunningThreads();
      return;
    }
    // Activation publishes one session-state. That snapshot already includes
    // toolCalls and the renderer copies them into threadToolCalls. Live
    // background watermarks still go through handleSessionUpdate's
    // thread-tool-calls event.
    if (!id) {
      this.emit({ type: "session-state", state: this.getState() });
    } else {
      this.emit({ type: "session-state", state: this.buildSessionState(id) });
      // The snapshot carries toolCalls and the renderer adopts them, so the
      // per-update thread-tool-calls guard can treat them as already sent.
      const runtime = this.sessions.get(id);
      if (runtime) runtime.emittedToolCalls = runtime.slice.toolCalls;
    }
    this.emitRunningThreads();
  }

  setMonitorObserver(observer: AgentMonitorObserver | null): void {
    this.monitorObserver = observer;
  }

  getMonitorProcessDescriptors(): MonitorProcessDescriptor[] {
    const running = new Set(this.getRunningThreadIds());
    const entries: MonitorProcessDescriptor[] = [];

    for (const live of this.lifecycle.all()) {
      const agentId = live.agentId;
      const pid = live.process.pid;
      if (!pid) continue;
      const threadIds = [...this.sessions.entries()]
        .filter(([, runtime]) => runtime.agentId === agentId)
        .map(([threadId]) => threadId);
      const primaryThreadId =
        threadIds.find((threadId) => threadId === this.activeThreadId) ?? threadIds[0];
      entries.push({
        pid,
        role: "acp-agent",
        label: live.agentInfoName || agentId,
        agentId,
        threadId: primaryThreadId,
        threadIds,
        streamingThreadIds: threadIds.filter((threadId) => running.has(threadId)),
        isStreaming: threadIds.some((threadId) => running.has(threadId)),
      });
    }

    for (const terminal of this.terminalManager.getActiveProcesses()) {
      entries.push({
        pid: terminal.pid,
        role: "terminal",
        label: `Agent shell ${terminal.terminalId.slice(0, 8)}`,
        sessionId: terminal.terminalId,
      });
    }

    return entries;
  }

  /** Thread IDs whose agent is currently streaming (across every open thread). */
  getRunningThreadIds(): string[] {
    const running: string[] = [];
    for (const [threadId, runtime] of this.sessions.entries()) {
      if (runtime.slice.isStreaming) running.push(threadId);
    }
    return running.sort();
  }

  /** Broadcast the running-thread set to the renderer when it changes. */
  private emitRunningThreads(): void {
    const running = this.getRunningThreadIds();
    const key = running.join(",");
    if (key === this.lastRunningThreadsKey) return;
    this.lastRunningThreadsKey = key;
    this.onRunningThreadsChanged?.(running);
    this.emit({ type: "running-threads", threadIds: running });
  }

  /**
   * Get (or spawn) a live connection for an agent WITHOUT making it the
   * active UI agent — used by subagent runs so an orchestrator spawning e.g.
   * Codex doesn't flip the composer over to Codex.
   */
  async acquireConnection(agentId: string): Promise<LiveConnection> {
    const descriptor = getAgentDescriptor(agentId);
    if (!descriptor) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    // Spawn dedup + registration + connect analytics live in ConnectionLifecycle.
    const live = await this.lifecycle.acquire(descriptor);
    this.providerLastBusyAt.set(live.agentId, Date.now());
    const advertised = live.modelState?.availableModels ?? [];
    if (advertised.length) {
      this.recordCatalog(
        live.agentId,
        advertised.map((model) => ({ modelId: model.modelId, name: model.name })),
      );
    }
    return live;
  }

  async authenticateAgent(agentId: string, methodId: string): Promise<void> {
    const live = await this.acquireConnection(agentId);
    const method = live.authMethods.find((candidate) => candidate.id === methodId);
    if (!method || ("type" in method && method.type === "terminal"))
      throw new Error("This authentication method cannot be started from Pipper.");
    await this.withProviderLease(agentId, () =>
      requestWithTimeout(
        live.agent.request(acp.methods.agent.authenticate, { methodId }),
        5 * 60_000,
        "agent/authenticate",
      ),
    );
    live.authRequiredMessage = null;
    // A thread whose restore failed with `auth_required` is still snapshot-only.
    // Now that credentials exist, re-establish its session in the background so
    // signing in unblocks the thread it was requested from. Not awaited: the
    // caller's button state must not hang on a slow re-activation. This is not
    // a selection request, so it cannot override a switch the user made since.
    const threadId = this.activeThreadId;
    const runtime = threadId ? this.sessions.get(threadId) : undefined;
    if (
      threadId &&
      runtime?.agentReady === false &&
      runtime.agentId === agentId &&
      !this.loadingSessionThreads.has(threadId)
    ) {
      void this.resolveThreadTarget(threadId)
        .then((target) => this.ensureThreadRuntime(target))
        .then(() => {
          if (this.activeThreadId === threadId) this.pushState(threadId);
        })
        .catch((error) => {
          console.warn(`[agent-auth] retry activation for ${threadId} failed:`, error);
        });
    }
  }

  async switchAgent(agentId: string): Promise<LiveConnection> {
    this.emit({
      type: "session-state",
      state: { ...this.getState(), switchingAgent: true },
    });

    const live = await this.acquireConnection(agentId);
    if (!this.activateConnection(live)) {
      // Already active: still confirm the connection so the picker settles.
      this.emit({
        type: "connection",
        agentId: live.agentId,
        agentCapabilities: live.agentCapabilities,
        authMethods: live.authMethods,
        authRequiredMessage: live.authRequiredMessage,
      });
    }
    this.pushState();
    return live;
  }

  private async closeConnection(): Promise<void> {
    this.lifecycle.setActive(null);
    this.permissions.cancelAll();
    this.prompts.abortAll();
    this.toolCallStarts.clear();
    for (const [threadId, runtime] of this.sessions.entries()) {
      this.endThreadLoad(threadId);
      this.monitorObserver?.onSessionCacheEvent?.({
        timestamp: Date.now(),
        action: "clear_all",
        threadId,
        agentSessionId: runtime.agentSessionId,
        agentId: runtime.agentId,
        trigger: "app_shutdown",
        cachedSessionCount: 0,
        openTabCount: 0,
        cachedThreadIds: [],
        reason: "Connection closed / app shutdown",
      });
    }
    this.sessions.clear();
    this.workspaceGuard.clear();
    this.terminalManager.killAll();
    await this.lifecycle.terminateAll();
  }

  private invalidateAgentSessions(agentId: string): void {
    let activeInvalidated = false;
    for (const [threadId, runtime] of this.sessions.entries()) {
      if (runtime.agentId === agentId) {
        activeInvalidated ||= this.activeThreadId === threadId;
        this.permissions.cancelForSession(runtime.agentSessionId);
        this.prompts.cancelInFlight(threadId, "agent connection closed");
        this.prompts.rejectQueued(threadId, "agent connection closed");
        this.clearToolCallTiming(runtime.agentSessionId);
        this.terminalManager.releaseSession(runtime.agentSessionId);
        this.releaseSessionMcp(runtime.agentSessionId);
        this.releaseWorkspaceRoot(runtime.agentSessionId);
        this.endThreadLoad(threadId);
        this.sessions.remove(threadId);
        this.monitorObserver?.onSessionCacheEvent?.({
          timestamp: Date.now(),
          action: "invalidate_agent",
          threadId,
          agentSessionId: runtime.agentSessionId,
          agentId,
          trigger: "process_exit",
          cachedSessionCount: this.sessions.size,
          openTabCount: 0,
          cachedThreadIds: [...this.sessions.keys()],
          reason: `Agent ${agentId} connection closed / process exited`,
        });
        this.emit({ type: "thread-closed", threadId });
      }
    }
    if (activeInvalidated) {
      this.activeThreadId = null;
      void updateLaunchSelection({ projectId: this.activeProjectId, threadId: null });
      this.pushState(null);
    } else {
      this.emitRunningThreads();
    }
  }

  private findThreadBySessionId(sessionId: string): string | null {
    return this.sessions.threadIdForSession(sessionId);
  }

  private connectionForAgent(agentId: string): LiveConnection | null {
    return this.lifecycle.connectionFor(agentId);
  }

  private async handleSessionUpdate(sessionId: string, update: SessionUpdate): Promise<void> {
    const startedAt = performance.now();
    // Headless subagent sessions accumulate into their run's slice; their
    // streaming must not leak into thread timelines or the renderer.
    if (this.subagents.handleSessionUpdate(sessionId, update)) return;

    const threadId = this.findThreadBySessionId(sessionId);
    let runtime: ThreadSessionRuntime | null = null;
    if (threadId && this.sessions.has(threadId)) {
      runtime = this.sessions.get(threadId)!;
    }

    if (!runtime) {
      // Still forward raw update
      this.emit({
        type: "session-update",
        sessionId,
        threadId: null,
        update,
      });
      return;
    }

    // A preserved snapshot runtime has no activation owning its session: a
    // failed or superseded session/load can keep streaming, and those updates
    // must not be written into the restored transcript as live content. Only a
    // new activation (which marks the thread loading) may receive them again.
    if (
      runtime.agentReady === false &&
      runtime.snapshotRestored &&
      !this.loadingSessionThreads.has(runtime.threadId)
    ) {
      return;
    }

    this.trackToolCallTiming(sessionId, runtime, update);

    // Running-threads emission depends solely on per-runtime isStreaming
    // flags, and this handler mutates exactly one runtime's slice — so emit
    // only when THIS runtime's flag flipped, not on every streamed chunk.
    const wasStreaming = runtime.slice.isStreaming;
    const loading = this.loadingSessionThreads.has(runtime.threadId);
    const replayingSnapshot = loading && runtime.replaySlice != null;
    const targetSlice = replayingSnapshot ? runtime.replaySlice! : runtime.slice;
    const updateToolCallId =
      update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
        ? update.toolCallId
        : null;
    const payloadAlreadyPersisted = Boolean(
      replayingSnapshot &&
      updateToolCallId &&
      runtime.snapshotPayloadSource?.slice.toolCalls[updateToolCallId],
    );
    const targetPayloads = replayingSnapshot
      ? payloadAlreadyPersisted
        ? null
        : (runtime.replayToolPayloads ??= new Map())
      : this.payloadsFor(runtime);
    // Capture the observer method once: the null/undefined check must survive
    // to the call below, and `this.monitorObserver` alone doesn't narrow.
    const acpObserver = this.monitorObserver?.onAcpUpdate;
    if (!acpObserver) {
      if (loading) {
        applySessionUpdateInPlace(targetSlice, update);
        if (targetPayloads) this.syncPayloadsFor(targetSlice, targetPayloads, update);
      } else {
        runtime.slice = applySessionUpdate(runtime.slice, update);
        this.syncToolPayloads(runtime, update);
      }
    } else {
      runtime.monitorUpdateCount += 1;
      const sampledRetention =
        runtime.monitorUpdateCount % 10 === 0 || update.sessionUpdate.startsWith("tool_");
      const tracker = this.retentionFor(runtime);
      let retained;
      if (loading) {
        const before = sampledRetention ? captureRetentionTail(targetSlice) : null;
        applySessionUpdateInPlace(targetSlice, update);
        if (targetPayloads) this.syncPayloadsFor(targetSlice, targetPayloads, update);
        retained = before
          ? tracker.observeAfterMutation(before, targetSlice, update)
          : {
              entryCount: targetSlice.entries.length,
              toolCallCount: tracker.snapshot(targetSlice).toolCallCount,
              textBytes: 0,
              thoughtBytes: 0,
              toolPayloadBytes: 0,
              largestToolPayloadBytes: 0,
              sessionSnapshotBytes: 0,
            };
      } else {
        const previousSlice = runtime.slice;
        runtime.slice = applySessionUpdate(runtime.slice, update);
        this.syncToolPayloads(runtime, update);
        retained = sampledRetention
          ? tracker.observe(previousSlice, runtime.slice, update)
          : {
              entryCount: runtime.slice.entries.length,
              toolCallCount: Object.keys(runtime.slice.toolCalls).length,
              textBytes: 0,
              thoughtBytes: 0,
              toolPayloadBytes: 0,
              largestToolPayloadBytes: 0,
              sessionSnapshotBytes: 0,
            };
      }
      acpObserver({
        timestamp: Date.now(),
        agentId: runtime.agentId,
        connectionId: this.connectionForAgent(runtime.agentId)?.connectionId ?? null,
        sessionId,
        threadId: runtime.threadId,
        threadRole: runtime.threadId === this.activeThreadId ? "active" : "background",
        turnId: runtime.activeTurnId,
        updateType: update.sessionUpdate,
        updateBytes: jsonBytes(update),
        handlerDurationMs: performance.now() - startedAt,
        isStreaming: targetSlice.isStreaming,
        ...retained,
      });
    }
    if (loading) {
      if (!replayingSnapshot || (updateToolCallId != null && !payloadAlreadyPersisted)) {
        runtime.snapshotDirty = true;
        if (payloadFromSessionUpdate(update)) {
          runtime.payloadRevision = (runtime.payloadRevision ?? 0) + 1;
        }
      }
      await this.yieldAfterBackgroundWork(runtime, true);
      return;
    }
    runtime.snapshotDirty = true;
    // `applySessionUpdate` sets isStreaming=true for every agent chunk/tool_call,
    // but only `applyTurnStop` (on the prompt request resolving) clears it. An
    // update that lands outside an active turn — a late flush after the response,
    // or an agent streaming background work out-of-band — would otherwise turn the
    // loader back on with nothing left to clear it. Clamp such updates to
    // non-streaming so the composer's stop button and the tab's working icon
    // reflect only genuine in-flight turns.
    if (
      this.sessions.has(runtime.threadId) &&
      !runtime.promptInFlight &&
      runtime.slice.isStreaming
    ) {
      runtime.slice = { ...runtime.slice, isStreaming: false };
    }
    // A background thread's streaming can flip via updates without a pushState; keep
    // tabs in sync — but only signal an actual streaming transition.
    if (wasStreaming !== runtime.slice.isStreaming) {
      if (runtime.threadId !== this.activeThreadId && !runtime.slice.isStreaming) {
        this.flushBackgroundToolCalls(runtime);
      }
      this.emitRunningThreads();
    }

    if (runtime.slice.titleChanged && runtime.slice.title && this.sessions.has(runtime.threadId)) {
      updateThreadTitle(runtime.threadId, runtime.slice.title);
      this.emit({
        type: "title",
        threadId: runtime.threadId,
        title: runtime.slice.title,
      });
      this.setWindowTitle(runtime.slice.title);
    }

    const event: AcpBridgeEvent = {
      type: "session-update",
      sessionId,
      threadId: runtime.threadId,
      update: stripToolPayloadFromSessionUpdate(update),
    };

    const isActiveThread = runtime.threadId === this.activeThreadId;
    // The renderer discards background session-update deltas. Do not pay IPC,
    // structured-clone, and store-dispatch cost for events it cannot use.
    if (isActiveThread) this.emit(event);
    // Message-chunk updates leave the tool-call record untouched; only
    // re-broadcast the full record when the reducer actually replaced it.
    // Resending it per chunk made live streaming O(total tool payload) per
    // update across IPC, structured clone, and renderer store spreads.
    if (runtime.slice.toolCalls !== runtime.emittedToolCalls) {
      if (isActiveThread) {
        runtime.emittedToolCalls = runtime.slice.toolCalls;
        const changedToolCall = updateToolCallId
          ? runtime.slice.toolCalls[updateToolCallId]
          : undefined;
        this.emit({
          type: "thread-tool-calls",
          threadId: runtime.threadId,
          toolCalls:
            changedToolCall && updateToolCallId
              ? { [updateToolCallId]: changedToolCall }
              : runtime.slice.toolCalls,
          replace: !changedToolCall,
        });
      } else {
        this.scheduleBackgroundToolCalls(runtime);
      }
    }
    // The renderer applies the same pure reducer to session-update. Sending a
    // full session-state snapshot for every chunk needlessly rebuilds the panel
    // projection and forces all snapshot subscribers to render again. The next
    // turn stop and activation still publish an authoritative snapshot.
    if (!runtime.promptInFlight && runtime.threadId === this.activeThreadId) {
      this.pushState(runtime.threadId);
    }
    await this.yieldAfterBackgroundWork(runtime, false);
  }

  private handlePermissionRequest(
    params: acp.RequestPermissionRequest,
    requestId?: string | number | null,
  ): Promise<acp.RequestPermissionResponse> {
    return this.permissions.handle(params, requestId ?? null);
  }

  getRemotePermissions(threadId: string) {
    return this.permissions.listForThread(threadId);
  }

  respondToRemotePermission(
    threadId: string,
    decisionId: string,
    optionId?: string,
    cancelled = false,
  ) {
    return this.permissions.respondForThread(threadId, decisionId, optionId, cancelled);
  }

  respondToPermission(response: {
    sessionId: string;
    requestId?: string | number;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<void> {
    return this.permissions.respond(response);
  }

  /**
   * Kept as the single seam for prompt dispatch so tests can stub it; the
   * queue/cancel/timeout mechanics live in PromptScheduler.
   */
  private requestPrompt(
    live: LiveConnection,
    runtime: ThreadSessionRuntime,
    blocks: ContentBlock[],
    streamingBehavior?: "followUp" | "steer",
  ): Promise<any> {
    return this.prompts.send(
      live.agent,
      { threadId: runtime.threadId, agentSessionId: runtime.agentSessionId },
      blocks,
      streamingBehavior,
    );
  }

  private drainPromptQueue(runtime: ThreadSessionRuntime, live: LiveConnection): void {
    if (runtime.promptInFlight) return;
    const prompt = this.prompts.dequeue(runtime.threadId);
    if (!prompt) return;

    runtime.promptInFlight = true;
    const turnStartedAt = Date.now();
    runtime.activeTurnId = `${runtime.threadId}:${turnStartedAt}:${++this.turnSequence}`;
    const toolCallsBefore = Object.keys(runtime.slice.toolCalls).length;
    const agentProps = this.agentProps(runtime.agentId);
    this.captureAnalytics?.("prompt_submitted", {
      ...agentProps,
      project_id: runtime.projectId,
      thread_id: runtime.threadId,
      has_images: prompt.blocks.some((block) => block.type === "image"),
      has_resources: prompt.blocks.some(
        (block) => block.type === "resource" || block.type === "resource_link",
      ),
    });

    void this.requestPrompt(live, runtime, prompt.blocks, prompt.streamingBehavior)
      .then((result) => {
        live.authRequiredMessage = null;
        this.settleRuntime(runtime);
        this.captureAnalytics?.("turn_completed", {
          ...agentProps,
          thread_id: runtime.threadId,
          stop_reason: result.stopReason,
          turn_duration_ms: Date.now() - turnStartedAt,
          tool_call_count: Math.max(
            0,
            Object.keys(runtime.slice.toolCalls).length - toolCallsBefore,
          ),
        });
        this.reportTokens(runtime, agentProps, runtime.threadId);
        this.emit({
          type: "stop",
          sessionId: runtime.agentSessionId,
          threadId: runtime.threadId,
          stopReason: result.stopReason,
        });
        // The user walked away: surface the settled turn at the OS level.
        this.notifyIfHidden({
          kind: "turn-completed",
          threadTitle: this.threadDisplayTitle(runtime.threadId),
          detail:
            result.stopReason && result.stopReason !== "end_turn"
              ? `stopped: ${result.stopReason}`
              : undefined,
        });
        prompt.resolve(result);
      })
      .catch((error) => {
        if (isAuthRequiredError(error)) {
          live.authRequiredMessage =
            getAgentDescriptor(live.agentId)?.authHint ?? "Sign in to your agent CLI, then retry.";
          this.prompts.rejectQueued(runtime.threadId, live.authRequiredMessage);
        }
        this.settleRuntime(runtime);
        this.captureAnalytics?.("turn_failed", {
          ...agentProps,
          thread_id: runtime.threadId,
          turn_duration_ms: Date.now() - turnStartedAt,
          error_type: error instanceof Error ? error.name : undefined,
        });
        if (error instanceof Error && /timed out/i.test(error.message)) {
          this.captureAnalytics?.("prompt_timeout", {
            ...agentProps,
            project_id: runtime.projectId,
            thread_id: runtime.threadId,
            turn_duration_ms: Date.now() - turnStartedAt,
            error_type: "session_prompt_timeout",
          });
        }
        // If ACP timed out or was cancelled, its underlying request may still
        // be alive. Do not start another prompt against the same session.
        if (error instanceof Error && /timed out|cancelled/i.test(error.message)) {
          this.prompts.rejectQueued(runtime.threadId, error.message);
        }
        this.notifyIfHidden({
          kind: "turn-failed",
          threadTitle: this.threadDisplayTitle(runtime.threadId),
          detail: error instanceof Error ? error.message.slice(0, 140) : undefined,
        });
        prompt.reject(error);
      })
      .finally(() => {
        runtime.promptInFlight = false;
        runtime.activeTurnId = null;
        this.clearToolCallTiming(runtime.agentSessionId);
        this.pushState(runtime.threadId);
        if (this.sessions.get(runtime.threadId) === runtime) {
          this.drainPromptQueue(runtime, live);
        }
      });
  }

  private async handleReadTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    this.workspaceGuard.assertWithin(params.sessionId, params.path);
    const content = await readFile(params.path, READ_FILE_OPTIONS);
    if (params.line != null || params.limit != null) {
      const lines = content.split("\n");
      const start = Math.max(0, (params.line ?? 1) - 1);
      const end = params.limit != null ? start + params.limit : lines.length;
      return { content: lines.slice(start, end).join("\n") };
    }
    return { content };
  }

  private async handleWriteTextFile(
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    this.workspaceGuard.assertWithin(params.sessionId, params.path);
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, WRITE_FILE_OPTIONS);
    return {};
  }

  private mcpServersForConnection(live: LiveConnection): Array<Record<string, unknown>> {
    const caps = live.agentCapabilities.mcpCapabilities;
    return toAcpMcpServers(listMcpServers(), caps);
  }

  /**
   * User-configured MCP servers plus the client-hosted subagent tool endpoint
   * (a fresh token per session so tool calls are attributable). The returned
   * bind() must be called with the established ACP session id.
   */
  private async sessionMcpServers(
    live: LiveConnection,
    cwd: string,
  ): Promise<{
    servers: Array<Record<string, unknown>>;
    bind: (sessionId: string) => void;
    release: () => void;
  }> {
    const base = this.mcpServersForConnection(live);
    const attached = await this.subagents.attachMcpServers(base, live.agentCapabilities, {
      cwd,
      depth: 0,
    });
    let browser: { servers: Array<Record<string, unknown>>; token: string | null } = {
      servers: attached.servers,
      token: null,
    };
    try {
      if (this.browser) {
        browser = await this.browser.attachMcpServers(attached.servers, live.agentCapabilities);
      }
    } catch (error) {
      // The browser is optional; a session must still start without it.
      console.warn("[browser] could not attach browser MCP endpoint", error);
    }
    return {
      servers: browser.servers,
      bind: (sessionId) => {
        if (attached.token) this.subagents.bindSession(attached.token, sessionId);
        if (browser.token) this.browser?.bindSession(browser.token, sessionId);
      },
      release: () => {
        if (attached.token) this.subagents.releaseTokenForSession(attached.token);
        if (browser.token) this.browser?.releaseTokenForSession(browser.token);
      },
    };
  }

  /** Release every client-hosted MCP endpoint owned by a closed ACP session. */
  private releaseSessionMcp(sessionId: string): void {
    this.subagents.releaseSessionMcp(sessionId);
    this.browser?.releaseSessionMcp(sessionId);
  }

  /**
   * Normalize and sanitize session config options. Some third-party ACP adapters
   * Some legacy adapters leak raw tab-separated output from CLI discovery (`id\tDisplay Name`).
   * Clean them so modelId matches what the CLI expects and UI renders clean names.
   */
  private sanitizeConfigOptions(
    rawOptions: SessionConfigOption[] | null | undefined,
  ): SessionConfigOption[] {
    return (rawOptions ?? []).map((opt) => {
      if (opt.id === "model" || opt.category === "model") {
        let currentValue = opt.currentValue;
        if (typeof currentValue === "string" && currentValue.includes("\t")) {
          const parts = currentValue.split("\t");
          currentValue = parts[1]?.trim() || parts[0]?.trim() || currentValue;
        }
        let choices = (opt as { options?: Record<string, unknown>[] }).options;
        if (Array.isArray(choices)) {
          choices = choices.map((item) => {
            if (item && typeof item === "object") {
              const rec = item as Record<string, unknown>;
              const rawVal = rec.value;
              const rawName = rec.name;
              if (typeof rawVal === "string" && rawVal.includes("\t")) {
                const parts = rawVal.split("\t");
                const cleanName = parts[1]?.trim() || parts[0]?.trim() || rawVal;
                return {
                  ...rec,
                  value: cleanName,
                  name:
                    typeof rawName === "string" && rawName.includes("\t")
                      ? cleanName
                      : (rawName ?? cleanName),
                };
              }
            }
            return item;
          });
        }
        return {
          ...opt,
          currentValue,
          options: choices,
        } as SessionConfigOption;
      }
      return opt;
    });
  }

  /**
   * Some agents (e.g. Grok) advertise their model catalog in the initialize
   * result's `_meta.modelState` rather than as a session config option. When the
   * agent returned no native "model" option, synthesize one from that catalog so
   * it flows through the standard model picker UI unchanged.
   */
  private withModelOption(
    live: LiveConnection,
    options: SessionConfigOption[],
  ): SessionConfigOption[] {
    const sanitized =
      live.agentId === "antigravity-acp" ? options : this.sanitizeConfigOptions(options);
    const ms = live.modelState;
    const models = ms?.availableModels ?? [];
    if (models.length === 0) return sanitized;
    if (sanitized.some((o) => o.category === "model" || o.id === "model")) return sanitized;
    const modelOption = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: ms?.currentModelId ?? models[0]?.modelId ?? null,
      options: models.map((m) => ({ value: m.modelId, name: m.name })),
    } as unknown as SessionConfigOption;
    return [modelOption, ...sanitized];
  }

  /**
   * The cwd a thread's session should run in: its bound worktree when that path
   * still resolves to a live worktree, else the project root. Validating on bind
   * keeps git the source of truth — an externally-removed worktree degrades to
   * the project root instead of failing `session/new` on a stale path.
   */
  private async resolveThreadCwd(
    worktreePath: string | null | undefined,
    projectPath: string,
  ): Promise<string> {
    if (worktreePath && (await isLiveWorktree(worktreePath, projectPath))) return worktreePath;
    return projectPath;
  }

  /** Seed the path guard for an ACP session with its (realpath'd) cwd root. */
  private registerWorkspaceRoot(agentSessionId: string, cwd: string): void {
    this.workspaceGuard.register(agentSessionId, cwd);
  }

  private releaseWorkspaceRoot(agentSessionId: string | null | undefined): void {
    this.workspaceGuard.release(agentSessionId);
  }

  private async sessionNew(
    live: LiveConnection,
    cwd: string,
  ): Promise<{ sessionId: string; configOptions: SessionConfigOption[] }> {
    const attached = await this.sessionMcpServers(live, cwd);
    const request = live.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: attached.servers as never,
    });
    let result: { sessionId: string; configOptions?: SessionConfigOption[] | null };
    try {
      result = await requestWithTimeout(request, ACP_SWITCH_PHASE_TIMEOUT_MS, "session/new");
    } catch (err) {
      // A genuine "not signed in" surfaces here as an ACP `auth_required`
      // error — the only reliable signal — so record it for `authMessage()`.
      this.recordAuthRequired(live, err);
      attached.release();
      this.closeLateSession(live, request);
      throw err;
    }
    live.authRequiredMessage = null;
    attached.bind(result.sessionId);

    const configOptions = this.withModelOption(
      live,
      (result.configOptions as SessionConfigOption[] | null | undefined) ?? [],
    );
    this.recordCatalog(live.agentId, modelOptionsFromConfig(configOptions));

    // Preserve the compatibility sync for other adapters that leak tab-separated
    // defaults. Official Antigravity ACP values remain opaque and are never rewritten.
    const rawModel = result.configOptions?.find(
      (option) => option.category === "model" || option.id === "model",
    );
    const cleanModel = configOptions.find(
      (option) => option.category === "model" || option.id === "model",
    );
    if (
      live.agentId !== "antigravity-acp" &&
      typeof rawModel?.currentValue === "string" &&
      rawModel.currentValue.includes("\t") &&
      cleanModel
    ) {
      try {
        await requestWithTimeout(
          live.agent.request(acp.methods.agent.session.setConfigOption, {
            sessionId: result.sessionId,
            configId: cleanModel.id,
            value: cleanModel.currentValue,
          }),
          ACP_SWITCH_PHASE_TIMEOUT_MS,
          "session/set_config_option",
        );
      } catch {
        /* compatibility sync is best effort */
      }
    }

    return {
      sessionId: result.sessionId,
      configOptions,
    };
  }

  private async sessionLoad(
    live: LiveConnection,
    cwd: string,
    sessionId: string,
  ): Promise<{ sessionId: string; configOptions: SessionConfigOption[] }> {
    const attached = await this.sessionMcpServers(live, cwd);
    const request = live.agent.request(acp.methods.agent.session.load, {
      cwd,
      sessionId,
      mcpServers: attached.servers as never,
    }) as Promise<{ sessionId?: string; configOptions?: SessionConfigOption[] | null }>;
    let result: { sessionId?: string; configOptions?: SessionConfigOption[] | null };
    try {
      result = await requestWithTimeout(request, ACP_SWITCH_PHASE_TIMEOUT_MS, "session/load");
    } catch (err) {
      // A restore that needs sign-in is the same persistent signal as a new
      // session: without this the renderer hides the transient switch error
      // and shows nothing lasting to act on.
      this.recordAuthRequired(live, err);
      attached.release();
      this.closeLateSession(live, request, sessionId);
      throw err;
    }
    live.authRequiredMessage = null;
    attached.bind(result?.sessionId ?? sessionId);
    const configOptions = this.withModelOption(live, result?.configOptions ?? []);
    this.recordCatalog(live.agentId, modelOptionsFromConfig(configOptions));
    return { sessionId: result?.sessionId ?? sessionId, configOptions };
  }

  private async sessionResume(
    live: LiveConnection,
    prevSessionId: string,
    cwd: string,
  ): Promise<{ sessionId: string; configOptions: SessionConfigOption[] }> {
    const attached = await this.sessionMcpServers(live, cwd);
    const request = live.agent.request(acp.methods.agent.session.resume, {
      sessionId: prevSessionId,
      cwd,
      mcpServers: attached.servers as never,
    } as never) as Promise<{ sessionId?: string; configOptions?: SessionConfigOption[] | null }>;
    let result: { sessionId?: string; configOptions?: SessionConfigOption[] | null };
    try {
      result = await requestWithTimeout(request, ACP_SWITCH_PHASE_TIMEOUT_MS, "session/resume");
    } catch (err) {
      this.recordAuthRequired(live, err);
      attached.release();
      this.closeLateSession(live, request, prevSessionId);
      throw err;
    }
    live.authRequiredMessage = null;
    attached.bind(result?.sessionId ?? prevSessionId);
    const configOptions = this.withModelOption(live, result?.configOptions ?? []);
    this.recordCatalog(live.agentId, modelOptionsFromConfig(configOptions));
    return { sessionId: result?.sessionId ?? prevSessionId, configOptions };
  }

  /**
   * A phase timeout only ends our wait: the provider may still establish the
   * session afterwards. Give that late session an owner. A runtime that has
   * since claimed the id keeps it; otherwise it is closed and its subagent
   * MCP endpoints are released, so the provider does not hold an orphan.
   * A rejected request established nothing and needs no cleanup.
   */
  private closeLateSession(
    live: LiveConnection,
    request: Promise<{ sessionId?: string } | null | undefined>,
    knownSessionId?: string,
  ): void {
    request.then(
      (late) => {
        const sessionId = late?.sessionId ?? knownSessionId;
        if (!sessionId || this.sessions.threadIdForSession(sessionId) != null) return;
        this.releaseSessionMcp(sessionId);
        void live.agent
          .request(acp.methods.agent.session.close, { sessionId })
          .catch(() => undefined);
      },
      () => undefined,
    );
  }

  /**
   * Run a mutation of one thread (close, delete) after any in-flight work on
   * that thread. Later requests must not join a preparation that started
   * before this mutation, so the shared preparation handle is dropped here.
   */
  private mutateThread<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    this.threadPreparations.delete(threadId);
    return this.threadMutations.run(threadId, task);
  }

  /** Look up a thread and validate the cwd its session should run in. */
  private async resolveThreadTarget(threadId: string): Promise<ThreadTarget> {
    const thread = getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const project = getProject(thread.project_id);
    if (!project) throw new Error(`Project not found: ${thread.project_id}`);
    // Bind the session to its worktree (validated), else the project root.
    const cwd = await this.resolveThreadCwd(thread.worktree_path, project.path);
    return { thread, project, cwd };
  }

  /**
   * Establish (or reuse) a thread's runtime without touching the active
   * selection. Concurrent requests for one thread share a single
   * preparation, and close/delete of that thread wait for it; other threads
   * are never blocked. A preparation is not abandoned when its caller is
   * superseded: the session it establishes is adopted by the runtime, which
   * stays resident like any visited thread.
   */
  private ensureThreadRuntime(target: ThreadTarget): Promise<PreparedThread> {
    const threadId = target.thread.id;
    const inFlight = this.threadPreparations.get(threadId);
    if (inFlight) return inFlight;
    const preparation = this.threadMutations.run(threadId, async () => {
      // The target was read before this task entered the per-thread queue; a
      // delete queued ahead of it may have removed the thread since. Never
      // restore a session for a thread whose row is gone.
      if (!getThread(threadId)) throw new Error(`Thread not found: ${threadId}`);
      return this.prepareThreadRuntime(target);
    });
    this.threadPreparations.set(threadId, preparation);
    const clear = () => {
      if (this.threadPreparations.get(threadId) === preparation) {
        this.threadPreparations.delete(threadId);
      }
    };
    preparation.then(clear, clear);
    return preparation;
  }

  /**
   * Get the provider for a thread without making it the UI's active agent. A
   * thread whose provider cannot start opens on the preferred provider
   * instead, except Antigravity, whose sessions belong to its own server.
   */
  private async acquireThreadConnection(thread: Thread): Promise<LiveConnection> {
    const targetId = thread.agent_id || this.preferredAgentId;
    try {
      return await this.acquireConnection(targetId);
    } catch (error) {
      if (
        !thread.agent_id ||
        thread.agent_id === "antigravity-acp" ||
        thread.agent_id === this.preferredAgentId
      ) {
        throw error;
      }
      return this.acquireConnection(this.preferredAgentId);
    }
  }

  private async prepareThreadRuntime(target: ThreadTarget): Promise<PreparedThread> {
    const restoreStartedAt = performance.now();
    const { thread, project, cwd } = target;
    const threadId = thread.id;
    let runtime = this.sessions.get(threadId);
    let phase: MonitorSwitchPhase = runtime ? "cache_hit" : "session_load";
    let openSource: PreparedThread["openSource"] =
      runtime && runtime.agentReady !== false ? "resident" : "replay";

    // Resident fast path: nothing to establish and nothing to wait for.
    if (runtime && runtime.agentReady !== false) {
      const owner = this.connectionForAgent(runtime.agentId);
      if (owner) {
        return { thread, project, runtime, live: owner, phase, openSource, restoreStartedAt };
      }
    }

    let restoredSnapshot: LoadedThreadSnapshot | null = null;
    // The display cache is intentionally restored before spawning or switching
    // an agent. Reading a thread must never wait for a CLI handshake.
    if (!runtime) {
      try {
        restoredSnapshot = this.snapshotStore.load(thread);
      } catch (error) {
        console.warn(`[thread-snapshot] restore failed for ${threadId}:`, error);
      }
      if (restoredSnapshot) {
        phase = "snapshot_restore";
        openSource = "snapshot";
        runtime = {
          threadId,
          agentSessionId: thread.agent_session_id,
          agentId: thread.agent_id,
          projectId: project.id,
          cwd,
          slice: restoredSnapshot.slice,
          editorText: "",
          promptInFlight: false,
          activeTurnId: null,
          monitorUpdateCount: 0,
          toolPayloads: new Map(),
          retention: new SessionRetentionTracker(),
          emittedToolCalls: null,
          agentReady: false,
          snapshotRestored: true,
          replaySlice: createEmptySessionSlice(),
          replayToolPayloads: new Map(),
          pendingLocalEntries: [],
          payloadsReady: true,
          snapshotPayloadSource: restoredSnapshot,
          snapshotDirty: false,
          payloadRevision: 0,
        };
        this.sessions.register(runtime);
        this.beginThreadLoad(threadId);
        this.monitorObserver?.onSessionCacheEvent?.({
          timestamp: Date.now(),
          action: "insert",
          threadId,
          agentSessionId: thread.agent_session_id,
          agentId: thread.agent_id,
          trigger: "switch_snapshot",
          cachedSessionCount: this.sessions.size,
          openTabCount: 0,
          cachedThreadIds: [...this.sessions.keys()],
        });
        // Publishes only when this thread is the active selection.
        this.pushState(threadId);
        void this.hydrateSnapshotImages(runtime, restoredSnapshot);
        this.snapshotFreshness.noteRestored(restoredSnapshot.writtenAt);
        this.captureAnalytics?.("thread_opened", {
          project_id: project.id,
          thread_id: threadId,
          agent_id: thread.agent_id,
          thread_open_source: "snapshot",
          restore_duration_ms: performance.now() - restoreStartedAt,
        });
        this.scheduleAdjacentSnapshotPreload(thread);
      }
    }

    // Agent restoration is the non-paint-critical phase. Cold spawns can take
    // seconds, but a snapshot-restored timeline above is already interactive.
    let live: LiveConnection;
    try {
      live = await this.withProviderLease(thread.agent_id || this.preferredAgentId, () =>
        this.acquireThreadConnection(thread),
      );
    } catch (error) {
      if (this.preserveSnapshotRuntimeAfterFailure(threadId, runtime)) throw error;
      if (runtime?.agentReady === false) {
        this.sessions.remove(threadId);
        this.endThreadLoad(threadId);
      }
      throw error;
    }
    if (runtime && runtime.agentReady !== false) {
      return { thread, project, runtime, live, phase, openSource, restoreStartedAt };
    }
    if (!restoredSnapshot) phase = "session_load";

    // Register the runtime BEFORE awaiting session/load: agents stream the
    // conversation replay as session/update notifications while the load
    // request is still in flight, and handleSessionUpdate can only route
    // them into this slice if the sessionId is already known here. Without
    // this, a reloaded thread renders with an empty timeline.
    if (!runtime) {
      runtime = {
        threadId,
        agentSessionId: thread.agent_session_id,
        agentId: live.agentId,
        projectId: project.id,
        cwd,
        slice: createEmptySessionSlice(),
        editorText: "",
        promptInFlight: false,
        activeTurnId: null,
        monitorUpdateCount: 0,
        toolPayloads: new Map(),
        retention: new SessionRetentionTracker(),
        emittedToolCalls: null,
        agentReady: false,
        snapshotRestored: false,
        payloadsReady: true,
        snapshotDirty: true,
        payloadRevision: 0,
      };
      this.sessions.register(runtime);
      this.beginThreadLoad(threadId);
      this.monitorObserver?.onSessionCacheEvent?.({
        timestamp: Date.now(),
        action: "insert",
        threadId,
        agentSessionId: thread.agent_session_id,
        agentId: live.agentId,
        trigger: "switch_load",
        cachedSessionCount: this.sessions.size,
        openTabCount: 0,
        cachedThreadIds: [...this.sessions.keys()],
      });
    } else if (!this.loadingSessionThreads.has(threadId)) {
      runtime.replaySlice = createEmptySessionSlice();
      runtime.replayToolPayloads = new Map();
      this.beginThreadLoad(threadId);
    }

    const placeholder = runtime;
    try {
      const established = await this.withProviderLease(live.agentId, () =>
        this.establishThreadSession(live, placeholder, thread, cwd, (next) => {
          phase = next;
        }),
      );
      // The runtime can lose its owner while the session is established (the
      // provider exited, or its account was removed). The late session must
      // not leak: close it instead of binding it to a removed runtime.
      if (this.sessions.get(threadId) !== placeholder) {
        if (this.sessions.threadIdForSession(established.sessionId) == null) {
          this.releaseSessionMcp(established.sessionId);
          void live.agent
            .request(acp.methods.agent.session.close, { sessionId: established.sessionId })
            .catch(() => undefined);
        }
        throw new Error("The thread's session was closed while it was being restored.");
      }

      // Merge instead of replacing the slice: the replay already populated
      // entries/toolCalls, only the session identity and config are new.
      // Rebind also updates the session-id index so streaming keeps routing
      // here under the session's NEW id.
      this.sessions.rebindSession(threadId, established.sessionId);
      this.registerWorkspaceRoot(established.sessionId, cwd);
      if (placeholder.replaySlice) {
        placeholder.slice = this.mergePendingLocalEntries(placeholder, placeholder.replaySlice);
        for (const [id, payload] of placeholder.replayToolPayloads ?? []) {
          this.payloadsFor(placeholder).set(id, payload);
        }
        placeholder.replaySlice = undefined;
        placeholder.replayToolPayloads = undefined;
        placeholder.snapshotRestored = false;
        placeholder.payloadsReady = true;
      } else {
        // Resume/new fallback may also have accumulated a prompt locally
        // while the agent was reconnecting. Preserve it across the swap.
        placeholder.slice = this.mergePendingLocalEntries(placeholder, placeholder.slice);
      }
      const { configOptions } = established;
      if (configOptions.length > 0 || placeholder.slice.configOptions.length === 0) {
        placeholder.slice = { ...placeholder.slice, configOptions };
      }
      // A session/load replay describes settled history, not a live turn.
      // Individual chunks set isStreaming while they are reduced; clear it
      // once the load request has delivered the complete replay. Trim was
      // deferred during replay so the cap still applies exactly once here.
      this.evictOrphanToolPayloads(placeholder);
      this.retentionFor(placeholder).recompute(placeholder.slice);
      placeholder.agentReady = true;
      if (!placeholder.slice.isStreaming) this.scheduleSnapshot(placeholder);
    } catch (err) {
      // A snapshot-restored Antigravity thread keeps its runtime: the
      // restored transcript is the user's only access to that history, and
      // evicting it here is what blanked the view. Everything else is a
      // placeholder with nothing to lose.
      if (
        this.sessions.get(threadId) === placeholder &&
        !this.preserveSnapshotRuntimeAfterFailure(threadId, placeholder)
      ) {
        // No session could be established — remove the placeholder so a
        // retry doesn't silently reuse a dead runtime.
        this.sessions.remove(threadId);
        this.monitorObserver?.onSessionCacheEvent?.({
          timestamp: Date.now(),
          action: "evict",
          threadId,
          agentSessionId: placeholder.agentSessionId,
          agentId: placeholder.agentId,
          trigger: "switch_load",
          cachedSessionCount: this.sessions.size,
          openTabCount: 0,
          cachedThreadIds: [...this.sessions.keys()],
          reason: "Session establishment failed",
        });
      }
      throw err;
    } finally {
      this.endThreadLoad(threadId);
    }
    return { thread, project, runtime: placeholder, live, phase, openSource, restoreStartedAt };
  }

  /** session/load, falling back to resume and then new when the provider lost the session. */
  private async establishThreadSession(
    live: LiveConnection,
    runtime: ThreadSessionRuntime,
    thread: Thread,
    cwd: string,
    onPhase: (phase: MonitorSwitchPhase) => void,
  ): Promise<{ sessionId: string; configOptions: SessionConfigOption[] }> {
    const threadId = thread.id;
    try {
      if (live.agentId === "antigravity-acp" && thread.agent_session_id?.startsWith("pipper-agy-"))
        throw new Error(
          "This Antigravity thread used Pipper's earlier CLI bridge. Its saved history is preserved, but the official ACP server cannot resume that CLI session. Start a new Antigravity thread to continue.",
        );
      return await this.sessionLoad(live, cwd, thread.agent_session_id);
    } catch (err) {
      // A phase timeout only settles the local request. The ACP request may
      // still complete later, so never cascade into resume/new and create a
      // second session while the timed-out load is alive.
      if (isPhaseTimeout(err)) throw err;
      // Antigravity session IDs belong to a specific implementation. A failed
      // restore must leave its snapshot and identity intact.
      if (live.agentId === "antigravity-acp") throw err;
      // Agent restarted — try resume. A failed load may have streamed a
      // partial replay before erroring; drop it so the fallback path
      // doesn't append onto half a timeline.
      runtime.slice = createEmptySessionSlice();
      runtime.snapshotRestored = false;
      runtime.snapshotPayloadSource = undefined;
      runtime.snapshotDirty = true;
      runtime.replaySlice = undefined;
      runtime.replayToolPayloads = undefined;
      this.retentionFor(runtime).reset();
      this.payloadsFor(runtime).clear();
      if (runtime.threadId === this.activeThreadId) this.pushState(runtime.threadId);
      try {
        const resumed = await this.sessionResume(live, thread.agent_session_id, cwd);
        onPhase("session_resume");
        updateThreadAgentSessionId(threadId, resumed.sessionId);
        return resumed;
      } catch (resumeError) {
        if (isPhaseTimeout(resumeError)) throw resumeError;
        const created = await this.sessionNew(live, cwd);
        onPhase("session_new");
        updateThreadAgentSessionId(threadId, created.sessionId);
        return created;
      }
    }
  }

  /**
   * Make `live` the composer's provider. Returns false when it already was.
   * Part of a selection commit, so only the newest selection calls it.
   */
  private activateConnection(live: LiveConnection): boolean {
    const previous = this.lifecycle.active;
    if (previous === live) return false;
    this.lifecycle.setActive(live);
    if (this.preferredAgentId !== live.agentId) {
      this.preferredAgentId = live.agentId;
      persistPreferredAgentId(live.agentId);
    }
    if (previous && previous.agentId !== live.agentId) {
      this.captureAnalytics?.("agent_switched", {
        from_agent_id: previous.agentId,
        to_agent_id: live.agentId,
        agent_name: getAgentDescriptor(live.agentId)?.name,
      });
    }
    this.emit({
      type: "connection",
      agentId: live.agentId,
      agentCapabilities: live.agentCapabilities,
      authMethods: live.authMethods,
      authRequiredMessage: live.authRequiredMessage,
    });
    return true;
  }

  /** Point the UI at a project/thread; part of a selection commit. */
  private selectThread(projectId: string, threadId: string | null): void {
    const projectChanged = this.activeProjectId !== projectId;
    this.activeProjectId = projectId;
    this.activeThreadId = threadId;
    setActiveProjectId(projectId);
    if (projectChanged) this.broadcastActiveProject?.(projectId);
  }

  async activateProject(projectId: string, preferredThreadId?: string | null): Promise<void> {
    return this.activateProjectInternal(projectId, preferredThreadId, this.selection.claim());
  }

  private async activateProjectInternal(
    projectId: string,
    preferredThreadId: string | null | undefined,
    ticket: SelectionTicket,
  ): Promise<void> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    this.activeProjectId = projectId;
    setActiveProjectId(projectId);
    this.broadcastActiveProject?.(projectId);

    const threads = listThreads().filter((t) => t.project_id === projectId);
    let thread: Thread | null = preferredThreadId ? getThread(preferredThreadId) : null;
    if (!thread) {
      // No explicit thread: enter the project's persisted workspace context —
      // its most-recently-used open tab there, else its most recent thread —
      // before falling back to any project thread.
      const state = await readLaunchState();
      const workspacePath = normalizeWorkspacePath(
        state.selectedWorktreePathByProject[projectId],
        project.path,
      );
      thread =
        pickWorkspaceThread({
          projectId,
          workspacePath,
          openThreadIds: state.openThreadIds,
          threadSwitchHistory: state.threadSwitchHistory,
          threads,
        }) ??
        threads[0] ??
        null;
    }
    this.selection.assertLatest(ticket);

    if (!thread) {
      this.activeThreadId = null;
      await updateLaunchSelection({ projectId, threadId: null });
      this.pushState(null);
      return;
    }

    // switchThread reconciles the persisted workspace to the activated
    // thread's cwd, so header/tabs/terminals agree after restart and after
    // project switches.
    try {
      await this.switchThreadInternal(thread.id, "restore", ticket);
    } catch (error) {
      // A newer activation superseded this one: the caller must not treat the
      // abandoned switch as a completed launch.
      if (isActivationSuperseded(error)) throw error;
      // A snapshot-restored thread must not block project launch: the user
      // needs the workspace open to read its saved history and start a
      // replacement thread (e.g. a legacy `pipper-agy-` id the official
      // Antigravity server cannot resume). The failure is still recorded on
      // the switch monitor and the transcript stays displayable.
      if (!this.sessions.get(thread.id)?.snapshotRestored) throw error;
      console.warn(`[thread-restore] opening ${thread.id} snapshot-only:`, error);
      // switchThreadCore's reconciliation never ran, so a snapshot-only launch
      // must still select the thread's workspace and give it an open tab.
      const workspaceCwd = await this.resolveThreadCwd(thread.worktree_path, project.path);
      this.selection.assertLatest(ticket);
      await commitThreadNavigation({
        projectId,
        threadId: thread.id,
        workspacePath: workspaceCwd,
      });
    }
    // Both paths committed project, thread and workspace in one write.
  }

  async switchThread(threadId: string): Promise<OpenTabsState> {
    return this.switchThreadInternal(threadId, "tab", this.selection.claim());
  }

  private async switchThreadInternal(
    threadId: string,
    source: MonitorSwitchRecord["source"],
    ticket: SelectionTicket,
  ): Promise<OpenTabsState> {
    const startedAt = Date.now();
    const previousThreadId = this.activeThreadId;
    const wasResidentInMemory = this.sessions.has(threadId);
    const cachedSessionCount = this.sessions.size;
    const agentIdBefore = this.lifecycle.active?.agentId ?? null;
    const workspaceCwdBefore = await this.getActiveCwd();
    let phase: MonitorSwitchPhase = wasResidentInMemory ? "cache_hit" : "session_load";
    let openTabCount = 0;
    const record = async (success: boolean, error?: string) => {
      const thread = getThread(threadId);
      const agentIdTarget = thread?.agent_id ?? null;
      const workspaceCwdTarget = await this.getActiveCwd().catch(() => null);
      this.monitorObserver?.onSwitchRecord?.({
        timestamp: Date.now(),
        threadId,
        agentId: this.lifecycle.active?.agentId ?? null,
        projectId: this.activeProjectId,
        source,
        phase,
        durationMs: Date.now() - startedAt,
        success,
        error,
        openTabCount,
        previousThreadId,
        cachedSessionCount,
        wasResidentInMemory,
        agentIdBefore,
        agentIdTarget,
        agentSwitched:
          agentIdBefore !== null && agentIdTarget !== null && agentIdBefore !== agentIdTarget,
        workspaceCwdBefore,
        workspaceCwdTarget,
        workspaceCwdChanged:
          workspaceCwdBefore !== null &&
          workspaceCwdTarget !== null &&
          workspaceCwdBefore !== workspaceCwdTarget,
      });
    };
    try {
      const state = await this.switchThreadCore(
        threadId,
        (nextPhase) => {
          phase = nextPhase;
        },
        ticket,
      );
      // The returned tabs state reflects the open-tab set after this
      // activation; capture it so records are comparable to tab events.
      openTabCount = state.openThreadIds.length;
      await record(true);
      return state;
    } catch (err) {
      try {
        openTabCount = (await readOpenTabsState()).openThreadIds.length;
      } catch {
        // best effort
      }
      await record(false, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Prepare the thread's runtime (concurrently with other threads), then
   * commit it as the active selection if no newer selection was requested.
   * A superseded caller rejects with ActivationSupersededError as soon as the
   * newer request arrives; its preparation still completes and is adopted.
   */
  private async switchThreadCore(
    threadId: string,
    onPhase: (phase: MonitorSwitchPhase) => void,
    ticket: SelectionTicket,
  ): Promise<OpenTabsState> {
    const target = await raceActivation(this.resolveThreadTarget(threadId), ticket.signal);
    const { thread, project, cwd } = target;
    // Validating the worktree awaited Git: a newer activation may have
    // superseded this one before any state below is touched.
    this.selection.assertLatest(ticket);
    this.selectThread(project.id, threadId);
    // A preparation already in flight (e.g. a superseded earlier click on this
    // thread) may have restored the snapshot while another thread was shown.
    const loading = this.sessions.get(threadId);
    if (loading && loading.agentReady === false && this.loadingSessionThreads.has(threadId)) {
      this.pushState(threadId);
    }

    const prepared = await raceActivation(this.ensureThreadRuntime(target), ticket.signal);
    onPhase(prepared.phase);

    // Commit: everything below up to the persistence writes is synchronous,
    // so no newer selection can interleave with it.
    this.selection.assertLatest(ticket);
    const { runtime, live } = prepared;
    if (this.sessions.get(threadId) !== runtime) {
      throw new Error("The agent session is not ready for this thread.");
    }
    this.selectThread(project.id, threadId);
    this.activateConnection(live);
    this.publishActiveAgentContext(live.agentId);
    touchThread(threadId);
    // Publish BEFORE persisting: the renderer paints the switched view without
    // waiting on disk. The writes still run (and are awaited before this
    // returns) and stay serialized in the launch-state / open-tabs queues;
    // only the newest selection reaches them, so the persisted selection
    // always matches the visible one.
    this.pushState(threadId);
    this.scheduleAdjacentSnapshotPreload(thread);
    if (prepared.openSource !== "snapshot") {
      this.captureAnalytics?.("thread_opened", {
        project_id: project.id,
        thread_id: threadId,
        agent_id: runtime.agentId,
        thread_open_source: prepared.openSource,
        restore_duration_ms: performance.now() - prepared.restoreStartedAt,
      });
    }
    // Every thread activation reconciles the persisted workspace to the
    // session's actual cwd — the main process is the single writer for the
    // canonical selection, and the renderer only mirrors it. This keeps
    // header, tab scoping, and terminals coherent for tab clicks, close
    // fallbacks, and orchestration switches alike.
    // Workspace, launch selection, open tab and MRU history land in one
    // atomic launch-state write; callers broadcast the returned tab state
    // without a second read-modify-write for the same switch.
    const { tabs } = await commitThreadNavigation({
      projectId: project.id,
      threadId,
      workspacePath: cwd,
    });
    return tabs;
  }

  async createThread(
    projectId: string,
    title: string | null,
    afterThreadId?: string | null,
    agentId?: string | null,
    worktreePath?: string | null,
    initialModelId?: string | null,
    opts?: { background?: boolean; requireWorktree?: boolean },
  ): Promise<Thread> {
    // A foreground create is a selection request; a background (phone) create
    // never touches the desktop selection, so it takes no ticket.
    const ticket = opts?.background ? null : this.selection.claim();
    return this.createThreadInternal(
      projectId,
      title,
      afterThreadId,
      agentId,
      worktreePath,
      initialModelId,
      opts,
      ticket,
    );
  }

  /**
   * Creation is durable: once requested it completes even when a newer
   * selection arrives meanwhile. It only skips selecting the new thread then,
   * so a slow provider start cannot pull the user away from where they went.
   */
  private async createThreadInternal(
    projectId: string,
    title: string | null,
    afterThreadId: string | null | undefined,
    agentId: string | null | undefined,
    worktreePath: string | null | undefined,
    initialModelId: string | null | undefined,
    opts: { background?: boolean; requireWorktree?: boolean } | undefined,
    ticket: SelectionTicket | null,
  ): Promise<Thread> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // Bind to the worktree when valid; store only what we actually bound to so a
    // stale/invalid path is never persisted as this thread's worktree.
    const cwd = await this.resolveThreadCwd(worktreePath, project.path);
    const boundWorktree = cwd === project.path ? null : cwd;
    if (opts?.requireWorktree && !boundWorktree) {
      throw new Error(
        "An isolated workspace is required. Restore the worktree on your Mac before retrying.",
      );
    }

    const targetAgentId = agentId ?? this.preferredAgentId;
    // Spawning never flips the composer's agent here; only the selection
    // commit below does, so background or superseded creates leave it alone.
    const { live, created } = await this.withProviderLease(targetAgentId, async () => {
      const connection = await this.acquireConnection(targetAgentId);
      if (opts?.requireWorktree && !(await isLiveWorktree(cwd, project.path))) {
        throw new Error("The isolated workspace is no longer available. No task was started.");
      }
      return { live: connection, created: await this.sessionNew(connection, cwd) };
    });
    this.registerWorkspaceRoot(created.sessionId, cwd);

    let sortOrder: number | undefined;
    if (afterThreadId) {
      const afterOrder = getThreadSortOrder(afterThreadId);
      if (afterOrder != null) sortOrder = afterOrder + 1;
    }

    const thread = createThreadRow(
      projectId,
      title,
      live.agentId,
      created.sessionId,
      sortOrder,
      boundWorktree,
    );

    this.sessions.register({
      threadId: thread.id,
      agentSessionId: created.sessionId,
      agentId: live.agentId,
      projectId,
      cwd,
      slice: createEmptySessionSlice({ configOptions: created.configOptions }),
      editorText: "",
      promptInFlight: false,
      activeTurnId: null,
      monitorUpdateCount: 0,
      toolPayloads: new Map(),
      retention: new SessionRetentionTracker(),
      emittedToolCalls: null,
      agentReady: true,
      snapshotRestored: false,
      payloadsReady: true,
    });
    this.monitorObserver?.onSessionCacheEvent?.({
      timestamp: Date.now(),
      action: "insert",
      threadId: thread.id,
      agentSessionId: created.sessionId,
      agentId: live.agentId,
      trigger: "thread_created",
      cachedSessionCount: this.sessions.size,
      openTabCount: 0,
      cachedThreadIds: [...this.sessions.keys()],
    });

    touchThread(thread.id);
    this.captureAnalytics?.("thread_created", {
      project_id: projectId,
      thread_id: thread.id,
      agent_id: live.agentId,
      agent_name: getAgentDescriptor(live.agentId)?.name,
      is_main: boundWorktree === null,
    } as AnalyticsProperties);

    // Background (phone) threads must never steal desktop focus, and neither
    // may a create that a newer selection superseded: skip the active-thread
    // switch, workspace mirror, and launch selection so the desktop keeps
    // showing whatever the user has open.
    if (ticket && this.selection.isLatest(ticket)) {
      // Creating a thread for another project (tab-bar dropdown) is a project
      // switch: selectThread broadcasts it, otherwise the renderer's project
      // store — and with it the header's project name, workspace, and branch —
      // keeps showing the previous project while the agent panel follows.
      this.selectThread(projectId, thread.id);
      this.activateConnection(live);
      this.publishActiveAgentContext(live.agentId);
      // Same publish-before-persist ordering as switches: the new thread's view
      // renders immediately while the durable selections settle below.
      this.pushState(thread.id);
      await commitNavigation({
        projectId,
        threadId: thread.id,
        workspace: { projectId, path: cwd },
      });
    } else {
      this.emitRunningThreads();
    }

    // Seed model after the session exists so the first prompt lands on the
    // user's chosen model. Best-effort: a failed seed still leaves a usable thread.
    // Thread-scoped, so a background (phone) seed never hits the desktop's thread.
    if (initialModelId) {
      try {
        const modelOpt = created.configOptions.find(
          (option) => option.id === "model" || option.category === "model",
        );
        await this.setThreadConfigOption(thread.id, modelOpt?.id ?? "model", initialModelId);
      } catch (err) {
        console.warn("[createThread] initial model seed failed:", err);
      }
    }

    return thread;
  }

  async deleteThread(threadId: string): Promise<void> {
    // Remember which selection was current: a selection requested after this
    // delete owns the UI, so the replacement switch below must not override it.
    const selectionAtRequest = this.selection.current;
    return this.mutateThread(threadId, () =>
      this.deleteThreadInternal(threadId, selectionAtRequest),
    );
  }

  private async deleteThreadInternal(threadId: string, selectionAtRequest: number): Promise<void> {
    const thread = getThread(threadId);
    if (!thread) return;

    const runtime = this.sessions.get(threadId);
    const sessionId = runtime?.agentSessionId ?? thread.agent_session_id;
    const owner = this.connectionForAgent(runtime?.agentId ?? thread.agent_id);
    this.permissions.cancelForSession(sessionId);
    this.prompts.cancelInFlight(threadId, "thread deleted");
    this.prompts.rejectQueued(threadId, "thread deleted");
    this.clearToolCallTiming(sessionId);
    this.terminalManager.releaseSession(sessionId);
    if (sessionId) this.releaseSessionMcp(sessionId);
    if (owner && sessionId) {
      try {
        await requestWithTimeout(
          owner.agent.request(acp.methods.agent.session.delete, { sessionId }),
          ACP_SWITCH_PHASE_TIMEOUT_MS,
          "session/delete",
        );
      } catch {
        // best effort
      }
    }
    this.releaseWorkspaceRoot(sessionId);
    this.endThreadLoad(threadId);
    await this.deletePersistedSnapshot(threadId);
    this.sessions.remove(threadId);
    this.abortGenerations.delete(threadId);
    this.monitorObserver?.onSessionCacheEvent?.({
      timestamp: Date.now(),
      action: "evict",
      threadId,
      agentSessionId: sessionId,
      agentId: runtime?.agentId ?? thread.agent_id,
      trigger: "tab_closed",
      cachedSessionCount: this.sessions.size,
      openTabCount: 0,
      cachedThreadIds: [...this.sessions.keys()],
      reason: "Thread deleted",
    });
    this.emit({ type: "thread-closed", threadId });
    removeThreadRow(threadId);

    if (this.activeThreadId !== threadId) return;
    this.activeThreadId = null;
    const remaining = listThreads().filter((t) => t.project_id === thread.project_id);
    // Stay in the deleted thread's workspace when it still has threads —
    // falling back to the project-wide MRU would yank the whole shell
    // (header, tabs, terminals) into another workspace.
    const state = await readLaunchState();
    const replacement =
      pickWorkspaceThread({
        projectId: thread.project_id,
        workspacePath: thread.worktree_path ?? null,
        openThreadIds: state.openThreadIds,
        threadSwitchHistory: state.threadSwitchHistory,
        threads: remaining,
      }) ??
      remaining[0] ??
      null;
    // A selection requested after the delete owns the UI and commits itself.
    if (this.selection.current !== selectionAtRequest) {
      if (this.activeThreadId === null) this.pushState(null);
      return;
    }
    if (replacement) {
      try {
        await this.switchThreadInternal(replacement.id, "delete", this.selection.claim());
      } catch (error) {
        if (!isActivationSuperseded(error)) throw error;
      }
    } else {
      await updateLaunchSelection({ projectId: thread.project_id, threadId: null });
      this.pushState(null);
    }
  }

  async closeThreadSession(threadId: string): Promise<void> {
    return this.mutateThread(threadId, () => this.closeThreadSessionInternal(threadId));
  }

  private async closeThreadSessionInternal(threadId: string): Promise<void> {
    const runtime = this.sessions.get(threadId);
    if (!runtime) return;
    const owner = this.connectionForAgent(runtime.agentId);
    this.permissions.cancelForSession(runtime.agentSessionId);
    this.prompts.cancelInFlight(threadId, "thread session closed");
    this.prompts.rejectQueued(threadId, "thread session closed");
    this.clearToolCallTiming(runtime.agentSessionId);
    this.terminalManager.releaseSession(runtime.agentSessionId);
    this.releaseSessionMcp(runtime.agentSessionId);
    if (owner) {
      try {
        await requestWithTimeout(
          owner.agent.request(acp.methods.agent.session.close, {
            sessionId: runtime.agentSessionId,
          }),
          ACP_SWITCH_PHASE_TIMEOUT_MS,
          "session/close",
        );
      } catch {
        // best effort
      }
    }
    this.releaseWorkspaceRoot(runtime.agentSessionId);
    await this.flushRuntimeSnapshot(runtime);
    this.endThreadLoad(threadId);
    this.sessions.remove(threadId);
    this.monitorObserver?.onSessionCacheEvent?.({
      timestamp: Date.now(),
      action: "close_session",
      threadId,
      agentSessionId: runtime.agentSessionId,
      agentId: runtime.agentId,
      trigger: "tab_closed",
      cachedSessionCount: this.sessions.size,
      openTabCount: 0,
      cachedThreadIds: [...this.sessions.keys()],
      reason: "Tab session closed",
    });
    this.emit({ type: "thread-closed", threadId });
  }

  async renameThread(threadId: string, title: string): Promise<Thread> {
    updateThreadTitle(threadId, title);
    const thread = getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const runtime = this.sessions.get(threadId);
    if (runtime) {
      runtime.slice = { ...runtime.slice, title, titleChanged: false };
    }
    this.pushState(threadId);
    return thread;
  }

  async sendPrompt(
    input: AcpPromptInput,
    opts?: { background?: boolean; requireWorktree?: boolean },
  ): Promise<void> {
    return this.sendPromptInternal(input, true, opts);
  }

  private async sendPromptInternal(
    input: AcpPromptInput,
    appendUserMessage: boolean,
    opts?: { background?: boolean; requireWorktree?: boolean },
  ): Promise<void> {
    const threadId = input.threadId ?? this.activeThreadId;
    if (!threadId) throw new Error("No active thread");
    const abortGeneration = this.abortGenerations.get(threadId) ?? 0;
    const assertIsolation = async () => {
      if ((this.abortGenerations.get(threadId) ?? 0) !== abortGeneration) {
        throw new Error("Task stopped before the agent was ready.");
      }
      if (!opts?.requireWorktree) return;
      const thread = getThread(threadId);
      const project = thread ? getProject(thread.project_id) : null;
      const runtime = this.sessions.get(threadId);
      if (
        !thread?.worktree_path ||
        !project ||
        !(await isLiveWorktree(thread.worktree_path, project.path)) ||
        (runtime && runtime.cwd !== thread.worktree_path)
      ) {
        throw new Error(
          "This thread has no live isolated workspace. Restore its worktree on your Mac before sending more work.",
        );
      }
    };
    await assertIsolation();
    if (!this.sessions.has(threadId)) {
      await this.restoreForPrompt(threadId, Boolean(opts?.background));
    }
    let runtime = this.sessions.get(threadId);
    if (!runtime) throw new Error("No session for thread");
    let appendedWhileLoading = false;
    if (runtime.agentReady === false || this.loadingSessionThreads.has(threadId)) {
      // Only append optimistically while a load is actually in progress. An
      // unready runtime with no load is a failed restore kept for its snapshot
      // (see preserveSnapshotRuntimeAfterFailure); it can never accept the
      // prompt, so reject before writing a phantom user turn into the restored
      // history or leaving isStreaming set.
      if (
        this.loadingSessionThreads.has(threadId) &&
        appendUserMessage &&
        (input.message || input.images?.length)
      ) {
        const nextSlice = appendLocalUserMessage(
          runtime.slice,
          input.message ?? "",
          undefined,
          input.images,
        );
        const localEntry = nextSlice.entries.at(-1);
        runtime.slice = nextSlice;
        if (localEntry) (runtime.pendingLocalEntries ??= []).push(localEntry);
        appendedWhileLoading = true;
        this.pushState(threadId);
      }
      await this.waitForThreadReady(threadId);
      runtime = this.sessions.get(threadId);
      if (!runtime) throw new Error("No session for thread");
    }
    // Validate isolation (an async Git read) before the in-flight check, so no
    // await separates that check from enqueueing the prompt below.
    await assertIsolation();
    runtime = this.sessions.get(threadId);
    if (!runtime) throw new Error("No session for thread");
    const live = this.connectionForAgent(runtime.agentId);
    if (!live || runtime.agentReady === false) throw new Error("No ready agent session for thread");

    if (runtime.promptInFlight && !input.streamingBehavior) {
      throw new Error("A prompt is already in flight; choose follow-up or steer to queue it.");
    }

    const caps = live.agentCapabilities.promptCapabilities;
    const blocks = assemblePromptBlocks({
      message: input.message,
      images: input.images,
      resources: input.resources,
      prompt: input.prompt,
      allowImage: caps?.image !== false,
      allowEmbeddedContext: Boolean(caps?.embeddedContext),
    });

    if (!appendedWhileLoading && appendUserMessage && (input.message || input.images?.length)) {
      runtime.slice = appendLocalUserMessage(
        runtime.slice,
        input.message ?? "",
        undefined,
        input.images,
      );
      this.pushState(threadId);
    }

    // New turn: drop prior plan so the popover only reappears when this turn
    // emits a plan update (applyTurnStop also clears; this covers image-only prompts).
    runtime.slice = { ...runtime.slice, isStreaming: true, plan: null };
    this.pushState(threadId);
    touchThread(threadId);

    const queued = this.prompts.enqueue(threadId, {
      blocks,
      streamingBehavior: input.streamingBehavior,
    });
    console.log(
      `[sendPrompt] thread=${threadId} project=${runtime.projectId} cwd=${runtime.cwd} session=${runtime.agentSessionId.slice(0, 8)} msgLen=${(input.message ?? "").length} images=${input.images?.length ?? 0}`,
    );
    this.drainPromptQueue(runtime, live);
    await queued;
  }

  /** Emit `tokens_reported` from the slice's usage snapshot at turn end (never per chunk). */
  private reportTokens(
    runtime: ThreadSessionRuntime,
    agentProps: AnalyticsProperties,
    threadId: string,
  ): void {
    const usage = runtime.slice.usage;
    if (!usage) return;
    this.captureAnalytics?.("tokens_reported", {
      ...agentProps,
      thread_id: threadId,
      tokens_used: usage.used,
      context_size: usage.size,
      cost_amount: usage.cost?.amount,
      cost_currency: usage.cost?.currency,
    });
  }

  /**
   * Make a non-resident thread's runtime available for a prompt. Background
   * senders (phone) only prepare it, never touching the desktop selection. A
   * foreground send selects the thread; if a newer selection supersedes that,
   * the prompt still belongs to its thread, so it waits for the preparation.
   */
  private async restoreForPrompt(threadId: string, background: boolean): Promise<void> {
    if (!background) {
      try {
        await this.switchThread(threadId);
        return;
      } catch (err) {
        if (!isActivationSuperseded(err)) throw err;
      }
    }
    await this.ensureThreadRuntime(await this.resolveThreadTarget(threadId));
  }

  async replacePrompt(input: AcpReplacePromptInput): Promise<void> {
    const threadId = input.threadId;
    if (!this.sessions.has(threadId)) await this.restoreForPrompt(threadId, false);
    const runtime = this.sessions.get(threadId);
    const live = runtime ? this.connectionForAgent(runtime.agentId) : null;
    if (!runtime || !live) throw new Error("No session for thread");

    runtime.promptInFlight = true;
    runtime.activeTurnId = `${runtime.threadId}:${Date.now()}:${++this.turnSequence}`;
    runtime.slice = appendLocalUserMessage(runtime.slice, input.message);
    runtime.slice = { ...runtime.slice, isStreaming: true };
    this.pushState(threadId);

    try {
      // Custom extension method
      await requestWithTimeout(
        live.agent.request("_pipper/replace_prompt", {
          sessionId: runtime.agentSessionId,
          promptId: input.targetUserEntryId,
          text: input.message,
        }),
        ACP_PROMPT_TIMEOUT_MS,
        "_pipper/replace_prompt",
        () => {
          void live.agent
            .notify(acp.methods.agent.session.cancel, { sessionId: runtime.agentSessionId })
            .catch(() => {});
        },
      );
      runtime.promptInFlight = false;
      runtime.activeTurnId = null;
      this.settleRuntime(runtime);
      this.pushState(threadId);
    } catch {
      runtime.promptInFlight = false;
      runtime.activeTurnId = null;
      // Fallback: regular prompt
      await this.sendPromptInternal(
        {
          threadId,
          message: input.message,
          images: input.images,
        },
        false,
      );
    }
  }

  async abort(): Promise<void> {
    return this.abortThread(this.activeThreadId);
  }

  async abortThread(threadId: string | null): Promise<void> {
    if (!threadId) return;
    this.abortGenerations.set(threadId, (this.abortGenerations.get(threadId) ?? 0) + 1);
    const runtime = this.sessions.get(threadId);
    const owner = runtime ? this.connectionForAgent(runtime.agentId) : null;
    if (!runtime || !owner) return;
    this.prompts.cancelInFlight(threadId, "user abort");
    this.prompts.rejectQueued(threadId, "agent prompt cancelled");
    this.clearToolCallTiming(runtime.agentSessionId);
    await owner.agent
      .notify(acp.methods.agent.session.cancel, { sessionId: runtime.agentSessionId })
      .catch(() => {});
    this.permissions.cancelForSession(runtime.agentSessionId);
    // Cascade cancel to subagent runs this session spawned.
    this.subagents.cancelRunsForParent(runtime.agentSessionId);
    // Cascade cancel to ACP agent terminals (session/cancel → terminal/kill).
    // Kill keeps terminalIds valid for final output queries; release is agent-owned.
    this.terminalManager.killRunning(runtime.agentSessionId);
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<SessionConfigOption[]> {
    const threadId = this.activeThreadId;
    if (!threadId) return [];
    return this.setThreadConfigOption(threadId, configId, value);
  }

  /** Thread-scoped config change, so background (phone) threads can switch
   * models without touching whatever the desktop has open. */
  async setThreadConfigOption(
    threadId: string,
    configId: string,
    value: string | boolean,
  ): Promise<SessionConfigOption[]> {
    const runtime = this.sessions.get(threadId);
    const owner = runtime ? this.connectionForAgent(runtime.agentId) : null;
    if (!runtime || !owner) return [];
    let targetValue = value;
    if (configId === "model" && typeof targetValue === "string" && targetValue.includes("\t")) {
      const parts = targetValue.split("\t");
      targetValue = parts[1]?.trim() || parts[0]?.trim() || targetValue;
    }

    // Grok exposes its models via initialize `_meta.modelState` and switches them
    // with a custom `session/set_model` method — it doesn't implement the standard
    // `session/set_config_option`. Route the synthesized "model" option there and
    // update the local option optimistically (the agent acks via `_meta.model.Ok`).
    if (configId === "model" && owner.modelState) {
      await requestWithTimeout(
        owner.agent.request(
          "session/set_model" as never,
          {
            sessionId: runtime.agentSessionId,
            modelId: targetValue,
          } as never,
        ),
        ACP_SWITCH_PHASE_TIMEOUT_MS,
        "session/set_model",
      );
      const options = runtime.slice.configOptions.map((o) =>
        o.id === "model" || o.category === "model"
          ? ({ ...o, currentValue: targetValue } as SessionConfigOption)
          : o,
      );
      runtime.slice = { ...runtime.slice, configOptions: options };
      this.pushState(threadId);
      return options;
    }
    const result = await requestWithTimeout(
      owner.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: runtime.agentSessionId,
        configId,
        value: targetValue as never,
      }),
      ACP_SWITCH_PHASE_TIMEOUT_MS,
      "session/set_config_option",
    );
    const rawResultOptions =
      (result.configOptions as SessionConfigOption[] | null | undefined) ??
      runtime.slice.configOptions;
    const options =
      owner.agentId === "antigravity-acp"
        ? rawResultOptions
        : this.sanitizeConfigOptions(rawResultOptions);
    runtime.slice = { ...runtime.slice, configOptions: options };
    this.pushState(threadId);
    return options;
  }

  getCommands() {
    return this.getState().commands;
  }

  getConfigOptions() {
    return this.getState().configOptions;
  }

  getCapabilities(): AgentCapabilities | null {
    return this.lifecycle.active?.agentCapabilities ?? null;
  }

  /** Promote the given agent onto the analytics base context (name resolved from the registry). */
  private publishActiveAgentContext(agentId: string): void {
    this.setAgentContext?.({ agentId, agentName: getAgentDescriptor(agentId)?.name ?? null });
  }

  /** Build the standard agent-identity properties for an event from an agent id. */
  private agentProps(agentId: string): AnalyticsProperties {
    return { agent_id: agentId, agent_name: getAgentDescriptor(agentId)?.name };
  }

  /**
   * Bracket tool-call start/finish and emit `tool_call_finished` with duration
   * when a call reaches a terminal status. `tool_kind` lets us answer "which
   * agent spends the most time on which tool kind."
   */
  private trackToolCallTiming(
    sessionId: string,
    runtime: ThreadSessionRuntime,
    update: SessionUpdate,
  ): void {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    const toolCallId = (update as { toolCallId?: string }).toolCallId;
    if (!toolCallId) return;
    const key = `${sessionId}:${toolCallId}`;
    const status = (update as { status?: string }).status;
    const kind = (update as { kind?: string }).kind;

    if (!this.toolCallStarts.has(key)) {
      this.toolCallStarts.set(key, { startedAt: Date.now(), kind });
    } else if (kind) {
      // A later update may be the first to carry the kind; keep it.
      const entry = this.toolCallStarts.get(key)!;
      if (!entry.kind) entry.kind = kind;
    }

    if (status === "completed" || status === "failed") {
      const entry = this.toolCallStarts.get(key);
      if (!entry) return;
      this.toolCallStarts.delete(key);
      this.captureAnalytics?.("tool_call_finished", {
        ...this.agentProps(runtime.agentId),
        thread_id: runtime.threadId,
        tool_kind: entry.kind ?? kind,
        tool_duration_ms: Date.now() - entry.startedAt,
        success: status === "completed",
      });
    }
  }

  private clearToolCallTiming(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.toolCallStarts.keys()) {
      if (key.startsWith(prefix)) this.toolCallStarts.delete(key);
    }
  }

  getStats() {
    const usage = this.getState().usage;
    if (!usage) return null;
    return {
      used: usage.used,
      size: usage.size,
      cost: usage.cost,
    };
  }

  async setEditorText(text: string): Promise<void> {
    this.currentEditorText = text;
    const active = this.activeThreadId ? this.sessions.get(this.activeThreadId) : null;
    if (active) active.editorText = text;
    this.emit({ type: "editor-text", text });
  }

  async pasteToEditor(text: string): Promise<void> {
    await this.setEditorText(this.currentEditorText + text);
  }

  getEditorText(): string {
    return this.currentEditorText;
  }

  reportEditorText(text: string): void {
    this.currentEditorText = text;
  }

  async activateFromLaunchState(): Promise<void> {
    const state = await readLaunchState();
    if (!state.projectId) return;
    await this.activateProject(state.projectId, state.threadId);
  }

  /**
   * Shutdown: persist what can be persisted within `snapshotFlushMs`, then
   * close every connection and terminate every provider process. Always
   * reaches the provider teardown, even when a snapshot write never settles.
   */
  dispose(options: { snapshotFlushMs?: number } = {}): Promise<void> {
    if (!this.disposed) {
      this.disposing = true;
      this.disposed = this.runDispose(options.snapshotFlushMs ?? DISPOSE_SNAPSHOT_FLUSH_MS);
    }
    return this.disposed;
  }

  private async runDispose(snapshotFlushMs: number): Promise<void> {
    if (this.idleSweepTimer) clearInterval(this.idleSweepTimer);
    this.idleSweepTimer = null;
    this.terminalManager.killAll();
    this.subagents.dispose();
    this.browser?.dispose();
    const flushed = await waitBounded(
      Promise.all([this.flushAllSnapshots(), this.catalogs.flush()]),
      snapshotFlushMs,
    );
    if (flushed.status === "timeout") {
      console.warn(
        `[thread-snapshot] shutdown flush did not finish within ${snapshotFlushMs} ms; ` +
          "unfinished writes keep their previous snapshot",
      );
    } else if (flushed.status === "error") {
      console.warn("[thread-snapshot] shutdown flush failed:", flushed.error);
    }
    for (const timer of this.snapshotTimers.values()) clearTimeout(timer);
    this.snapshotTimers.clear();
    await this.closeConnection();
  }

  /**
   * Sizes of every per-thread/per-session lifecycle map. Diagnostics and tests
   * use it to check that create/delete/reconnect/cancel cycles return to a
   * baseline instead of accumulating entries.
   */
  getLifecycleResourceCounts(): Record<string, number> {
    return {
      sessions: this.sessions.size,
      loadingThreads: this.loadingSessionThreads.size,
      sessionReadyWaiters: this.sessionReadyWaiters.size,
      threadPreparations: this.threadPreparations.size,
      threadMutations: this.threadMutations.size,
      workspaceRoots: this.workspaceGuard.size,
      toolCallStarts: this.toolCallStarts.size,
      abortGenerations: this.abortGenerations.size,
      subagentMcpEndpoints: this.subagents.endpointCount(),
      browserMcpEndpoints: this.browser?.endpointCount() ?? 0,
      browserPages: this.browser?.pageCount() ?? 0,
      snapshotTimers: this.snapshotTimers.size,
      backgroundToolCallTimers: this.backgroundToolCallTimers.size,
      providerLeases: this.providerLeases.size,
    };
  }

  /** @deprecated Compact is agent-owned; no-op. */
  async compact(_customInstructions?: string): Promise<void> {
    // Dropped explicit UI compact — agent decides when to compact.
  }
}

/** Back-compat alias used by main.ts during migration. */
export { AgentConnectionManager as AgentManager };
