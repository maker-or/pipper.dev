import { create } from "zustand";
import type {
  AcpBridgeEvent,
  AcpChatMessage,
  AcpEntry,
  AcpPermissionRequest,
  AcpPromptInput,
  AcpReplacePromptInput,
  AcpSessionState,
  AcpToolCallState,
  AgentCapabilities,
  AuthMethod,
  AvailableCommand,
  SessionConfigOption,
  SubagentRunSnapshot,
} from "../../contracts/acp.ts";
import {
  createChatProjector,
  projectToolResultMessages,
  type AcpToolResultMessage,
  type ChatProjection,
} from "../lib/acp-entries";
import type { OpenTabsState, Thread, ThreadPage } from "../../contracts/threads.ts";
import {
  applySessionUpdate,
  applyTurnStop,
  appendLocalUserMessage,
  createEmptySessionSlice,
  type AcpSessionSlice,
} from "../lib/acp-session-reducer";
import { useAgentTerminalStore } from "./agent-terminal-store";
import { useModelCatalogStore } from "./model-catalog-store";
import { toast } from "../components/ui/toast";
import { Warning, Info } from "@phosphor-icons/react";
import React from "react";
import { queryClient } from "../lib/query-client";
import { OPEN_TABS_QUERY_KEY } from "../lib/thread-queries";
import { useThreadStore } from "./thread-store";
import { recordRendererEvent } from "../lib/monitor-runtime-observer";
import { estimateJsonBytes } from "../lib/session-retention";
import {
  forgetThreadToolPayloads,
  rememberHydratedToolCalls,
  rememberToolPayloadFromUpdate,
  setActiveToolPayloadThread,
  syncToolPayloadIds,
} from "./tool-payload-store";
import { toLeanToolCall } from "../lib/tool-call-payload";

/**
 * An agent naming a session ("title" bridge event) is the source of truth
 * for a thread's title, but the tab strip reads from the open-tabs query and
 * the thread store, neither of which this store owns. Patch both caches in
 * place — cheaper than a refetch and keeps the tab label in sync the moment
 * the agent names the session.
 */
function applyThreadTitleUpdate(threadId: string, title: string): void {
  queryClient.setQueryData<(OpenTabsState & { openThreads: Thread[] }) | undefined>(
    OPEN_TABS_QUERY_KEY,
    (current) =>
      current
        ? {
            ...current,
            openThreads: current.openThreads.map((thread) =>
              thread.id === threadId ? { ...thread, title } : thread,
            ),
          }
        : current,
  );

  queryClient.setQueriesData<ThreadPage | undefined>({ queryKey: ["project-threads"] }, (current) =>
    current
      ? {
          ...current,
          threads: current.threads.map((thread) =>
            thread.id === threadId ? { ...thread, title } : thread,
          ),
        }
      : current,
  );

  useThreadStore.setState((state) => ({
    threads: state.threads.map((thread) =>
      thread.id === threadId ? { ...thread, title } : thread,
    ),
  }));
}

/** A question surfaced to the user, mapped from an ACP permission request. */
export interface UiRequest {
  id: string;
  requestId?: string | number;
  kind: "select" | "confirm";
  title: string;
  message?: string;
  options?: string[];
  timeoutMs?: number;
  sessionId: string;
  /** Thread that raised the question; drives inline-vs-dock routing in the UI.
   *  Null when the owning session isn't bound to a thread. */
  threadId: string | null;
  optionIds?: string[];
}

interface AgentState {
  state: AcpSessionState | null;
  /** @deprecated Prefer `state`; panel compatibility view model. */
  snapshot: AgentPanelSnapshot | null;
  /** Incremental slice for the active session (mirrors main; applied optimistically). */
  slice: AcpSessionSlice;
  agentCapabilities: AgentCapabilities | null;
  /** Sign-in methods the active connection advertises (ACP `authMethods`). */
  authMethods: AuthMethod[];
  /** Thread IDs whose agent is currently streaming, across all open threads. */
  runningThreadIds: string[];
  /** Latest tool-call map for every known thread, including background threads. */
  threadToolCalls: Record<string, Record<string, AcpToolCallState>>;
  /** Renderer-visible switch target; null once main has authoritatively settled. */
  pendingThreadTarget: string | null;
  /** Subagent runs spawned via the client-hosted spawn_subagent tool. */
  subagentRuns: SubagentRunSnapshot[];
  permissionRequest: AcpPermissionRequest | null;
  /** Pending questions from agents (mapped from ACP request_permission),
   *  in arrival order. Multiple background threads can each raise a question;
   *  they queue here instead of overwriting one another and are answered one
   *  by one. `uiRequest` mirrors the head for back-compat. */
  uiRequestQueue: UiRequest[];
  /** Head of `uiRequestQueue` (or null). Kept for existing call sites. */
  uiRequest: UiRequest | null;
  isConnecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  refresh: () => Promise<void>;
  hydrateToolCalls: (threadId: string, toolCallIds: string[]) => Promise<void>;
  respondToPermission: (response: {
    sessionId: string;
    requestId?: string | number;
    optionId?: string;
    cancelled?: boolean;
  }) => Promise<void>;
  sendPrompt: (input: AcpPromptInput) => Promise<void>;
  replacePrompt: (input: AcpReplacePromptInput) => Promise<void>;
  abort: () => Promise<void>;
  switchThread: (threadId: string) => Promise<void>;
  createThread: (
    projectId: string,
    title: string | null,
    afterThreadId?: string | null,
    agentId?: string | null,
    worktreePath?: string | null,
    initialModelId?: string | null,
  ) => Promise<Thread>;
  setConfigOption: (configId: string, value: string | boolean) => Promise<void>;
  setModel: (model: { provider?: string; modelId: string }) => Promise<boolean>;
  cycleThinkingLevel: () => Promise<string | null>;
  respondToUiRequest: (response: {
    requestId: string;
    value: string | boolean | undefined;
  }) => Promise<void>;
  compact: (customInstructions?: string) => Promise<void>;
  listAgents: () => Promise<
    Array<{ id: string; name: string; displayName: string; version?: string }>
  >;
  switchAgent: (agentId: string) => Promise<void>;
  setEditorText: (text: string) => Promise<void>;
  pasteToEditor: (text: string) => Promise<void>;
  reportEditorText: (text: string) => void;
  getState: () => AcpSessionState | null;
  getCommands: () => AvailableCommand[];
  getConfigOptions: () => SessionConfigOption[];
  getUsage: () => AcpSessionState["usage"];
  /** Capability helpers for UI gates. */
  canAttachImage: () => boolean;
  canEmbeddedContext: () => boolean;
  canAttachAudio: () => boolean;
}

let unsubscribeBridge: (() => void) | null = null;
let latestThreadSwitchId = 0;
let pendingThreadTarget: string | null = null;
let latestRefreshId = 0;
// Main activation can spend up to 10s on initialize plus three 10s session
// phases (load, resume, new), and Antigravity's first-use install alone waits
// up to 180s for its download. Keep the renderer pending until that whole
// budget has elapsed so a late session-state cannot surprise the user after a
// false error.
// Read lazily: Node tests import this module without a preload `window.omni`.
const DEFAULT_THREAD_SWITCH_TIMEOUT_MS = 240_000;

function threadSwitchTimeoutMs(): number {
  const benchmark = typeof window === "undefined" ? undefined : window.omni?.benchmark;
  return benchmark?.enabled ? benchmark.switchTimeoutMs : DEFAULT_THREAD_SWITCH_TIMEOUT_MS;
}

/**
 * The runtime's authoritative session snapshots currently contain user text
 * but not the image blocks that were attached to the prompt. Preserve those
 * renderer-only image parts when a snapshot replaces an optimistic slice.
 */
function preserveOptimisticUserImages(
  previousEntries: AcpEntry[],
  nextEntries: AcpEntry[],
): AcpEntry[] {
  const imagesByText = new Map<string, Array<{ data: string; mimeType: string }>>();
  for (const entry of previousEntries) {
    if (entry.type !== "user_text" || !entry.images?.length) continue;
    const queued = imagesByText.get(entry.text) ?? [];
    queued.push(...entry.images);
    imagesByText.set(entry.text, queued);
  }

  if (imagesByText.size === 0) return nextEntries;

  return nextEntries.map((entry) => {
    if (entry.type !== "user_text" || entry.images?.length) return entry;
    const queued = imagesByText.get(entry.text);
    if (!queued?.length) return entry;
    imagesByText.set(entry.text, []);
    return { ...entry, images: queued };
  });
}

function preserveOptimisticState(
  previousState: AcpSessionState | null,
  nextState: AcpSessionState,
): AcpSessionState {
  if (!previousState?.entries.length) return nextState;
  const entries = preserveOptimisticUserImages(previousState.entries, nextState.entries);
  return entries === nextState.entries ? nextState : { ...nextState, entries };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
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

function selectConfigOption(
  options: SessionConfigOption[],
  category: string,
): SessionConfigOption | undefined {
  return (
    options.find((o) => o.category === category) ??
    options.find((o) => o.id === category) ??
    options.find((o) => o.id.includes(category))
  );
}

function currentSelectValue(option: SessionConfigOption | undefined): string | null {
  if (!option || option.type !== "select") return null;
  return (option as { currentValue?: string }).currentValue ?? null;
}

function selectOptionsList(
  option: SessionConfigOption | undefined,
): Array<{ value: string; name: string; provider?: string }> {
  if (!option || option.type !== "select") return [];
  const raw = (option as { options?: unknown }).options;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ value: string; name: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    if ("value" in item && "name" in item) {
      out.push({
        value: String((item as any).value),
        name: String((item as any).name),
        provider: typeof (item as any).provider === "string" ? (item as any).provider : undefined,
      });
    } else if ("options" in item && Array.isArray((item as any).options)) {
      const provider =
        typeof (item as any).name === "string" ? String((item as any).name) : undefined;
      for (const nested of (item as any).options) {
        if (nested && typeof nested === "object" && "value" in nested) {
          out.push({
            value: String(nested.value),
            name: String(nested.name ?? nested.value),
            provider: typeof nested.provider === "string" ? nested.provider : provider,
          });
        }
      }
    }
  }
  return out;
}

/** Panel-facing view model kept close to the old snapshot shape for UI continuity. */
export interface AgentPanelSnapshot {
  projectId: string | null;
  threadId: string | null;
  agentId: string | null;
  agentSessionId: string | null;
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  model: { provider: string; modelId: string; name: string } | null;
  thinkingLevel: string | null;
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  messages: Array<{
    id: string;
    role: string;
    content: string | Array<Record<string, unknown>>;
    thought?: string;
    toolCallIds?: string[];
    streaming?: boolean;
    toolCallId?: string;
    isError?: boolean;
    terminalIds?: string[];
  }>;
  /** Aligned with `messages` indices; null for non-user rows. */
  messageEntryRefs: Array<{ entryId: string; parentId: string | null } | null>;
  streamingMessage: {
    id: string;
    role: string;
    content: string | Array<Record<string, unknown>>;
    thought?: string;
  } | null;
  queue: { steering: string[]; followUp: string[] };
  commands: AvailableCommand[];
  models: Array<{ provider: string; modelId: string; name: string }>;
  configOptions: SessionConfigOption[];
  plan: AcpSessionState["plan"];
  usage: AcpSessionState["usage"];
  toolCalls: AcpSessionState["toolCalls"];
  stats: { used: number; size: number; cost?: { amount: number; currency: string } } | null;
  status: Record<string, string | undefined>;
  workingMessage: string | null;
  workingVisible: boolean;
  hiddenThinkingLabel: string | null;
  editorText: string;
  authRequiredMessage: string | null;
  switchingAgent: boolean;
}

/**
 * Memoized projection of the entry timeline into panel messages.
 * Reused wholesale when entries/toolCalls/isStreaming are referentially
 * unchanged (e.g. usage/plan/config updates), so the panel's message array
 * identity — and therefore memoized rows — survive unrelated bridge events.
 * While only the streaming tail changes, `messages` and `messageEntryRefs`
 * keep their identity too: the chat projector is incremental and tool results
 * are only re-derived when `toolCalls` changes.
 */
let lastPanelProjection: {
  entries: AcpSessionState["entries"];
  toolCalls: AcpSessionState["toolCalls"];
  isStreaming: boolean;
  chat: ChatProjection;
  toolResults: AcpToolResultMessage[];
  streamingChat: AcpChatMessage | null;
  messages: AgentPanelSnapshot["messages"];
  messageEntryRefs: AgentPanelSnapshot["messageEntryRefs"];
} | null = null;

const projectChat = createChatProjector();

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function projectPanelMessages(state: AcpSessionState): NonNullable<typeof lastPanelProjection> {
  const previous = lastPanelProjection;
  if (
    previous &&
    previous.entries === state.entries &&
    previous.toolCalls === state.toolCalls &&
    previous.isStreaming === state.isStreaming
  ) {
    return previous;
  }
  const chat = projectChat(state.entries, state.toolCalls, state.isStreaming);
  let toolResults = previous?.toolResults ?? [];
  if (!previous || previous.toolCalls !== state.toolCalls) {
    const next = projectToolResultMessages(state.toolCalls);
    if (!sameItems(next, toolResults)) toolResults = next;
  }
  let messages = previous?.messages;
  let messageEntryRefs = previous?.messageEntryRefs;
  if (
    !previous ||
    !messages ||
    !messageEntryRefs ||
    previous.chat.settled !== chat.settled ||
    previous.toolResults !== toolResults
  ) {
    // Keep the streaming assistant only in streamingMessage (legacy panel grouping path).
    messages = [...chat.settled, ...toolResults] as AgentPanelSnapshot["messages"];
    // Aligned with `messages` indices; non-user slots are null.
    messageEntryRefs = messages.map((m) =>
      m.role === "user" ? { entryId: m.id, parentId: null } : null,
    );
  }
  lastPanelProjection = {
    entries: state.entries,
    toolCalls: state.toolCalls,
    isStreaming: state.isStreaming,
    chat,
    toolResults,
    streamingChat: chat.streaming,
    messages,
    messageEntryRefs,
  };
  return lastPanelProjection;
}

export function toPanelSnapshot(state: AcpSessionState | null): AgentPanelSnapshot | null {
  if (!state) return null;
  const modelOpt = selectConfigOption(state.configOptions, "model");
  const thoughtOpt = selectConfigOption(state.configOptions, "thought_level");
  const modelValue = currentSelectValue(modelOpt);
  const modelName =
    selectOptionsList(modelOpt).find((o) => o.value === modelValue)?.name ?? modelValue;
  const models = selectOptionsList(modelOpt).map((o) => ({
    provider: o.provider ?? state.agentId ?? "agent",
    modelId: o.value,
    name: o.name,
  }));
  const { streamingChat, messages, messageEntryRefs } = projectPanelMessages(state);
  return {
    projectId: state.projectId,
    threadId: state.threadId,
    agentId: state.agentId,
    agentSessionId: state.agentSessionId,
    sessionId: state.agentSessionId,
    cwd: state.cwd,
    title: state.title,
    model: modelValue
      ? {
          provider: state.agentId ?? "agent",
          modelId: modelValue,
          name: modelName ?? modelValue,
        }
      : null,
    thinkingLevel: currentSelectValue(thoughtOpt),
    isStreaming: state.isStreaming,
    isCompacting: state.isCompacting,
    isRetrying: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    messages,
    messageEntryRefs,
    streamingMessage: streamingChat
      ? {
          id: streamingChat.id,
          role: streamingChat.role,
          content: streamingChat.content,
          thought: streamingChat.thought,
        }
      : null,
    queue: { steering: [], followUp: [] },
    commands: state.commands,
    models,
    configOptions: state.configOptions,
    plan: state.plan,
    usage: state.usage,
    toolCalls: state.toolCalls,
    stats: state.usage
      ? { used: state.usage.used, size: state.usage.size, cost: state.usage.cost }
      : null,
    status: {},
    workingMessage: null,
    workingVisible: false,
    hiddenThinkingLabel: null,
    editorText: state.editorText,
    authRequiredMessage: state.authRequiredMessage,
    switchingAgent: state.switchingAgent,
  };
}

function emptyState(): AcpSessionState {
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

function applyBridgeEvent(
  state: Pick<
    AgentState,
    | "state"
    | "slice"
    | "permissionRequest"
    | "uiRequestQueue"
    | "error"
    | "agentCapabilities"
    | "authMethods"
    | "threadToolCalls"
  >,
  payload: AcpBridgeEvent,
): Partial<AgentState> {
  if (payload.type === "running-threads") {
    return { runningThreadIds: payload.threadIds };
  }

  if (payload.type === "thread-tool-calls") {
    const toolCalls =
      payload.replace === false
        ? {
            ...state.threadToolCalls[payload.threadId],
            ...payload.toolCalls,
          }
        : payload.toolCalls;
    const threadToolCalls = {
      ...state.threadToolCalls,
      [payload.threadId]: toolCalls,
    };
    if (state.state?.threadId !== payload.threadId) return { threadToolCalls };
    return {
      threadToolCalls,
      slice: { ...state.slice, toolCalls },
      state: { ...state.state, toolCalls },
    };
  }

  if (payload.type === "thread-closed") {
    forgetThreadToolPayloads(payload.threadId);
    const threadToolCalls = { ...state.threadToolCalls };
    delete threadToolCalls[payload.threadId];
    return { threadToolCalls };
  }

  // Subagent activity is global (not per-thread); apply regardless of which
  // thread is displayed or being switched into.
  if (payload.type === "subagent-runs") {
    return { subagentRuns: payload.runs };
  }

  // Catalogs live in the model-catalog store (applied by the bridge listener).
  if (payload.type === "model-catalogs") return {};

  if (
    pendingThreadTarget &&
    payload.type !== "session-state" &&
    payload.type !== "session-update" &&
    payload.type !== "stop" &&
    payload.type !== "permission-request" &&
    payload.type !== "permission-resolved" &&
    payload.type !== "connection"
  ) {
    return {};
  }

  switch (payload.type) {
    case "session-state": {
      // Do not let an old session-state settle a newer user-requested switch.
      // During session/load the previous thread remains the renderer's
      // authoritative state until the target session is complete.
      if (pendingThreadTarget && payload.state.threadId !== pendingThreadTarget) {
        return {};
      }
      pendingThreadTarget = null;
      // A session-state for a different thread than the displayed one is a
      // MAIN-INITIATED activation (workspace switch, delete replacement,
      // launch restore) and must re-target the view. Background threads can
      // no longer clobber this: the main process only emits session-state
      // for its active thread (see AgentConnectionManager.pushState); their
      // streaming flags arrive via "running-threads" instead.
      const nextState = preserveOptimisticState(state.state, payload.state);
      if (nextState.threadId) {
        syncToolPayloadIds(nextState.threadId, nextState.toolCalls);
      }
      return {
        state: nextState,
        threadToolCalls: nextState.threadId
          ? { ...state.threadToolCalls, [nextState.threadId]: nextState.toolCalls }
          : state.threadToolCalls,
        slice: createEmptySessionSlice({
          entries: nextState.entries,
          toolCalls: nextState.toolCalls,
          plan: nextState.plan,
          usage: nextState.usage,
          configOptions: nextState.configOptions,
          commands: nextState.commands,
          currentModeId: nextState.currentModeId,
          isStreaming: nextState.isStreaming,
          title: nextState.title,
        }),
        error: null,
        pendingThreadTarget: null,
      };
    }
    case "session-update": {
      // Replay updates for a target thread can arrive before its authoritative
      // session-state. Applying them to the current slice mixes target
      // messages with the previous thread's identity. Wait for the complete
      // session-state instead.
      if (pendingThreadTarget) return {};
      const displayedThreadId = state.state?.threadId ?? null;
      if (payload.threadId !== displayedThreadId) {
        return {};
      }
      rememberToolPayloadFromUpdate(payload.threadId, payload.update);
      const nextSlice = applySessionUpdate(state.slice, payload.update);
      // Tool ids only disappear when the tool-call map is replaced (trimming);
      // text chunks keep the same map and skip the walk.
      if (nextSlice.toolCalls !== state.slice.toolCalls) {
        syncToolPayloadIds(payload.threadId, nextSlice.toolCalls);
      }
      const base = state.state ?? emptyState();
      return {
        slice: nextSlice,
        state: {
          ...base,
          entries: nextSlice.entries,
          toolCalls: nextSlice.toolCalls,
          plan: nextSlice.plan,
          usage: nextSlice.usage,
          configOptions: nextSlice.configOptions,
          commands: nextSlice.commands,
          currentModeId: nextSlice.currentModeId,
          isStreaming: nextSlice.isStreaming,
          title: nextSlice.titleChanged ? nextSlice.title : base.title,
        },
      };
    }
    case "stop": {
      // Same reasoning as "session-update": a background thread finishing its
      // turn must not stop (or fail to stop) the streaming indicator for the
      // thread the user is actually looking at.
      if (pendingThreadTarget) return {};
      const displayedThreadId = state.state?.threadId ?? null;
      if (payload.threadId !== displayedThreadId) {
        return {};
      }
      // applyTurnStop clears plan (turn-scoped); keep state + slice aligned so a
      // later session-state cannot rehydrate the prior plan into the next turn.
      const nextSlice = applyTurnStop(state.slice);
      const base = state.state ?? emptyState();
      return {
        slice: nextSlice,
        state: {
          ...base,
          entries: nextSlice.entries,
          isStreaming: false,
          plan: null,
        },
      };
    }
    case "permission-request": {
      const options = payload.request.options ?? [];
      const next: UiRequest = {
        id:
          payload.request.requestId == null
            ? payload.request.sessionId
            : `${payload.request.sessionId}:${String(payload.request.requestId)}`,
        requestId: payload.request.requestId,
        kind: "select",
        title: "Permission required",
        message: (payload.request.toolCall as { title?: string })?.title ?? "Allow this tool call?",
        options: options.map((o) => o.name),
        sessionId: payload.request.sessionId,
        threadId: payload.request.threadId ?? null,
        optionIds: options.map((o) => o.optionId),
      };
      // Enqueue rather than overwrite, so concurrent requests from one session
      // remain answerable. A repeated JSON-RPC id is the only safe dedupe key.
      const withoutDup = state.uiRequestQueue.filter((r) => r.id !== next.id);
      const uiRequestQueue = [...withoutDup, next];
      return {
        permissionRequest: payload.request,
        uiRequestQueue,
        uiRequest: uiRequestQueue[0] ?? null,
      };
    }
    case "permission-resolved": {
      const uiRequestQueue = state.uiRequestQueue.filter(
        (r) =>
          r.sessionId !== payload.sessionId ||
          (payload.requestId != null && r.requestId !== payload.requestId),
      );
      return {
        permissionRequest:
          state.permissionRequest?.sessionId === payload.sessionId &&
          (payload.requestId == null || state.permissionRequest.requestId === payload.requestId)
            ? null
            : state.permissionRequest,
        uiRequestQueue,
        uiRequest: uiRequestQueue[0] ?? null,
      };
    }
    case "connection":
      return {
        agentCapabilities: payload.agentCapabilities,
        authMethods: payload.authMethods ?? [],
        state: state.state
          ? {
              ...state.state,
              agentId: payload.agentId,
              authRequiredMessage: payload.authRequiredMessage ?? null,
            }
          : state.state,
      };
    case "title": {
      if (!state.state || state.state.threadId !== payload.threadId) return {};
      return {
        state: { ...state.state, title: payload.title },
        slice: { ...state.slice, title: payload.title, titleChanged: false },
      };
    }
    case "editor-text": {
      if (!state.state) return {};
      return { state: { ...state.state, editorText: payload.text } };
    }
    case "notification":
      return {};
    case "terminal-output":
      // Handled by agent-terminal-store via connect() bridge
      return {};
    default:
      return {};
  }
}

function rememberModelsFromState(state: AcpSessionState | null | undefined): void {
  if (!state?.agentId) return;
  const modelOpt = selectConfigOption(state.configOptions ?? [], "model");
  const models = selectOptionsList(modelOpt).map((o) => ({
    modelId: o.value,
    name: o.name,
    provider: o.provider,
  }));
  if (models.length === 0) return;
  useModelCatalogStore.getState().remember(state.agentId, models);
}

function withSnapshot(
  partial: Partial<AgentState> & { state?: AcpSessionState | null },
): Partial<AgentState> {
  if ("state" in partial) {
    const nextState = partial.state ?? null;
    rememberModelsFromState(nextState);
    // The displayed thread's tool bodies are pinned in the payload cache.
    setActiveToolPayloadThread(nextState?.threadId ?? null);
    return { ...partial, snapshot: toPanelSnapshot(nextState) };
  }
  return partial;
}

type SessionUpdateEvent = Extract<AcpBridgeEvent, { type: "session-update" }>;

/**
 * Streamed text arrives as one bridge event per delta, and every set()
 * notifies every subscriber (the panel subscribes to the whole store), so
 * applying each delta on its own re-renders the panel per token burst. Text
 * deltas for the displayed thread are buffered and applied in order with a
 * single set() on the next frame, or after STREAM_FLUSH_MS when frames are
 * throttled (occluded window). Anything else that touches this store flushes
 * the buffer first, so ordering against tool calls, permissions, stops,
 * snapshots and optimistic prompts is unchanged. `getState()` readers can see
 * text up to one frame old; nothing else is deferred.
 */
const STREAM_FLUSH_MS = 16;
let streamBuffer: SessionUpdateEvent[] = [];
let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
let streamFlushFrame: number | null = null;

function isBufferedStreamDelta(
  state: Pick<AgentState, "state">,
  payload: AcpBridgeEvent,
): payload is SessionUpdateEvent {
  if (payload.type !== "session-update" || pendingThreadTarget) return false;
  const kind = payload.update.sessionUpdate;
  if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return false;
  return payload.threadId === (state.state?.threadId ?? null);
}

/** Events this store ignores whatever the buffer holds; flushing for them would only add renders. */
function cannotObserveStreamBuffer(state: Pick<AgentState, "state">, payload: AcpBridgeEvent) {
  if (payload.type === "terminal-output") return true;
  return payload.type === "session-update" && payload.threadId !== (state.state?.threadId ?? null);
}

function cancelStreamFlush(): void {
  if (streamFlushTimer !== null) clearTimeout(streamFlushTimer);
  if (streamFlushFrame !== null) cancelAnimationFrame(streamFlushFrame);
  streamFlushTimer = null;
  streamFlushFrame = null;
}

function scheduleStreamFlush(): void {
  if (streamFlushTimer !== null) return;
  streamFlushTimer = setTimeout(flushStreamDeltas, STREAM_FLUSH_MS);
  if (typeof requestAnimationFrame === "function") {
    streamFlushFrame = requestAnimationFrame(() => flushStreamDeltas());
  }
}

/** Snapshots read from main already contain every delta received before them. */
function discardStreamDeltas(): void {
  cancelStreamFlush();
  streamBuffer = [];
}

/** Applies buffered text deltas in arrival order with one notification. */
function flushStreamDeltas(): void {
  cancelStreamFlush();
  if (streamBuffer.length === 0) return;
  const pending = streamBuffer;
  streamBuffer = [];
  let view = useAgentStore.getState();
  let patch: Partial<AgentState> = {};
  for (const payload of pending) {
    const next = applyBridgeEvent(view, payload);
    if (Object.keys(next).length === 0) continue;
    patch = { ...patch, ...next };
    view = { ...view, ...next };
  }
  if (Object.keys(patch).length > 0) useAgentStore.setState(withSnapshot(patch));
}

export const useAgentStore = create<AgentState>((set, get) => ({
  state: null,
  snapshot: null,
  slice: createEmptySessionSlice(),
  agentCapabilities: null,
  authMethods: [],
  runningThreadIds: [],
  threadToolCalls: {},
  pendingThreadTarget: null,
  subagentRuns: [],
  permissionRequest: null,
  uiRequestQueue: [],
  uiRequest: null,
  isConnecting: false,
  error: null,

  connect: async () => {
    if (!window.omni?.agent) return;
    flushStreamDeltas();
    set({ isConnecting: true, error: null });
    try {
      if (unsubscribeBridge) {
        try {
          unsubscribeBridge();
        } catch (err) {
          console.error("Failed to unsubscribe previous bridge listener:", err);
        }
        unsubscribeBridge = null;
        // Terminals belong to the previous connection's agent processes; their
        // ids can never receive output again, so drop them to bound the
        // outputs record's key count across reconnects.
        useAgentTerminalStore.getState().reset();
      }
      // Single writer for ACP terminal-output (no second onEvent subscription).
      const rawCleanup = window.omni.agent.onEvent((payload: AcpBridgeEvent) => {
        const eventStartedAt = performance.now();
        // Approximate wire size without serializing: JSON.stringify plus a
        // TextEncoder pass on every bridge event duplicated the IPC
        // structured clone on the renderer main thread and was quadratic
        // once tool payloads accumulate. estimateJsonBytes walks the payload
        // with O(1) string lengths and allocates nothing.
        const payloadBytes = estimateJsonBytes(payload);
        const activeThreadId = get().state?.threadId ?? null;
        const eventThreadId =
          "threadId" in payload && typeof payload.threadId === "string" ? payload.threadId : null;
        const isActive = eventThreadId === null || eventThreadId === activeThreadId;
        if (isBufferedStreamDelta(get(), payload)) {
          streamBuffer.push(payload);
          scheduleStreamFlush();
          recordRendererEvent({
            eventType: payload.type,
            bytes: payloadBytes,
            isActive,
            applyMs: performance.now() - eventStartedAt,
            buffered: true,
          });
          return;
        }
        if (!cannotObserveStreamBuffer(get(), payload)) flushStreamDeltas();
        let ignored = false;
        if (payload.type === "terminal-output") {
          useAgentTerminalStore
            .getState()
            .applyTerminalOutput(payload.terminalId, payload.output, payload.append);
        }
        if (payload.type === "title") {
          applyThreadTitleUpdate(payload.threadId, payload.title);
        }
        if (payload.type === "model-catalogs") {
          const remember = useModelCatalogStore.getState().remember;
          for (const [agentId, models] of Object.entries(payload.catalogs)) {
            remember(agentId, models);
          }
        }
        if (payload.type === "notification") {
          let icon = React.createElement(Info, { className: "size-5 text-blue-500" });
          if (payload.level === "error") {
            icon = React.createElement(Warning, { className: "size-5 text-red-500" });
          } else if (payload.level === "warning") {
            icon = React.createElement(Warning, { className: "size-5 text-yellow-500" });
          }
          toast({
            icon,
            title: payload.level.toUpperCase(),
            description: payload.message,
          });
        }
        // Zustand notifies every subscriber on any set(), even an empty patch;
        // events that change nothing here (terminal output, background
        // threads) must not wake the panel.
        const patch = applyBridgeEvent(get(), payload) as Partial<AgentState>;
        ignored = Object.keys(patch).length === 0;
        if (!ignored) set(withSnapshot(patch) as Partial<AgentState>);
        recordRendererEvent({
          eventType: payload.type,
          bytes: payloadBytes,
          isActive,
          applyMs: performance.now() - eventStartedAt,
          ignored,
        });
      });
      unsubscribeBridge = () => {
        rawCleanup();
        unsubscribeBridge = null;
      };
      const state = preserveOptimisticState(get().state, await window.omni.agent.getState());
      discardStreamDeltas();
      set(
        withSnapshot({
          state,
          slice: createEmptySessionSlice({
            entries: state.entries,
            toolCalls: state.toolCalls,
            plan: state.plan,
            usage: state.usage,
            configOptions: state.configOptions,
            commands: state.commands,
            currentModeId: state.currentModeId,
            isStreaming: state.isStreaming,
            title: state.title,
          }),
          threadToolCalls: { [state.threadId ?? "__none__"]: state.toolCalls },
          pendingThreadTarget: null,
          isConnecting: false,
        }) as Partial<AgentState>,
      );
      // Load capabilities if API exposes them
      if (window.omni.agent.getCapabilities) {
        const caps = await window.omni.agent.getCapabilities();
        if (caps) set({ agentCapabilities: caps });
      }
      // Sync running-thread set so tabs reflect in-flight background runs after a reconnect.
      if (window.omni.agent.getRunningThreads) {
        const runningThreadIds = await window.omni.agent.getRunningThreads();
        set({ runningThreadIds });
      }
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to connect to agent runtime",
        isConnecting: false,
      });
    }
  },

  refresh: async () => {
    flushStreamDeltas();
    const refreshId = ++latestRefreshId;
    try {
      const state = preserveOptimisticState(get().state, await window.omni.agent.getState());
      set(() => {
        if (refreshId !== latestRefreshId) return {};
        discardStreamDeltas();
        pendingThreadTarget = null;
        return withSnapshot({
          state,
          slice: createEmptySessionSlice({
            entries: state.entries,
            toolCalls: state.toolCalls,
            plan: state.plan,
            usage: state.usage,
            configOptions: state.configOptions,
            commands: state.commands,
            currentModeId: state.currentModeId,
            isStreaming: state.isStreaming,
            title: state.title,
          }),
          threadToolCalls: { [state.threadId ?? "__none__"]: state.toolCalls },
          pendingThreadTarget: null,
        });
      });
    } catch (err) {
      if (refreshId === latestRefreshId) {
        set({
          error: err instanceof Error ? err.message : "Failed to refresh agent state",
        });
      }
    }
  },

  hydrateToolCalls: async (threadId, toolCallIds) => {
    if (toolCallIds.length === 0 || !window.omni?.agent?.getToolCalls) return;
    flushStreamDeltas();
    const remote = await window.omni.agent.getToolCalls(threadId, toolCallIds);
    if (Object.keys(remote).length === 0) return;
    rememberHydratedToolCalls(threadId, remote);
    flushStreamDeltas();
    set((current) => {
      // The watermark only needs lean records; bodies stay in the bounded
      // payload cache (and in the displayed state below while it is shown).
      const leanRemote: Record<string, AcpToolCallState> = {};
      for (const [id, toolCall] of Object.entries(remote))
        leanRemote[id] = toLeanToolCall(toolCall);
      const threadToolCalls = {
        ...current.threadToolCalls,
        [threadId]: {
          ...current.threadToolCalls[threadId],
          ...leanRemote,
        },
      };
      if (current.state?.threadId !== threadId) return { threadToolCalls };
      const toolCalls = { ...current.state.toolCalls, ...remote };
      const nextState = { ...current.state, toolCalls };
      return withSnapshot({
        state: nextState,
        slice: { ...current.slice, toolCalls },
        threadToolCalls,
      });
    });
  },

  respondToPermission: async (response) => {
    flushStreamDeltas();
    await window.omni.agent.respondToPermission(response);
    set((s) => {
      const uiRequestQueue = s.uiRequestQueue.filter(
        (r) =>
          r.sessionId !== response.sessionId ||
          (response.requestId != null && r.requestId !== response.requestId),
      );
      return {
        permissionRequest:
          s.permissionRequest?.sessionId === response.sessionId &&
          (response.requestId == null || s.permissionRequest.requestId === response.requestId)
            ? null
            : s.permissionRequest,
        uiRequestQueue,
        uiRequest: uiRequestQueue[0] ?? null,
      };
    });
  },

  respondToUiRequest: async (response) => {
    // Answer a specific queued request by id (its sessionId). Falls back to the
    // head so existing single-request call sites keep working.
    const queue = get().uiRequestQueue;
    const ui = queue.find((r) => r.id === response.requestId) ?? queue[0];
    if (!ui) return;
    const optionId =
      typeof response.value === "string" && ui.optionIds && ui.options
        ? (ui.optionIds[ui.options.indexOf(response.value)] ?? ui.optionIds[0])
        : ui.optionIds?.[0];
    await get().respondToPermission({
      sessionId: ui.sessionId,
      requestId: ui.requestId,
      optionId: response.value === false || response.value === undefined ? undefined : optionId,
      cancelled: response.value === false || response.value === undefined,
    });
  },

  setModel: async (model) => {
    const opts = get().getConfigOptions();
    const modelOpt = selectConfigOption(opts, "model");
    if (!modelOpt) return false;
    await get().setConfigOption(modelOpt.id, model.modelId);
    return true;
  },

  cycleThinkingLevel: async () => {
    const opts = get().getConfigOptions();
    const thoughtOpt = selectConfigOption(opts, "thought_level");
    if (!thoughtOpt || thoughtOpt.type !== "select") return null;
    const values = selectOptionsList(thoughtOpt);
    if (values.length === 0) return null;
    const current = currentSelectValue(thoughtOpt);
    const idx = Math.max(
      0,
      values.findIndex((v) => v.value === current),
    );
    const next = values[(idx + 1) % values.length]!;
    await get().setConfigOption(thoughtOpt.id, next.value);
    return next.value;
  },

  compact: async (_customInstructions?: string) => {
    // Explicit compact UI dropped — agent-owned compaction.
  },

  sendPrompt: async (input) => {
    // The previous turn's tail must land before the optimistic echo.
    flushStreamDeltas();
    // Optimistic local user message
    if (input.message || input.images?.length) {
      set((s) => {
        const nextSlice = appendLocalUserMessage(
          s.slice,
          input.message ?? "",
          undefined,
          input.images,
        );
        const base = s.state ?? emptyState();
        return withSnapshot({
          slice: nextSlice,
          state: {
            ...base,
            entries: nextSlice.entries,
            isStreaming: true,
            // Match slice: prior-turn plan must not flash open during the new turn.
            plan: nextSlice.plan,
          },
        });
      });
    }
    await window.omni.agent.sendPrompt(input);
  },

  replacePrompt: async (input) => {
    flushStreamDeltas();
    await window.omni.agent.replacePrompt(input);
  },

  abort: async () => {
    flushStreamDeltas();
    const sessionId = get().state?.agentSessionId;
    await window.omni.agent.abort();
    if (sessionId) {
      await get()
        .respondToPermission({ sessionId, cancelled: true })
        .catch(() => {});
    }
  },

  switchThread: async (threadId) => {
    flushStreamDeltas();
    if (get().state?.threadId === threadId && pendingThreadTarget == null) return;

    const switchId = ++latestThreadSwitchId;
    pendingThreadTarget = threadId;
    set({ error: null, pendingThreadTarget: threadId });

    // Send every click to main at once. Main supersedes the older activation
    // when a newer one arrives (see electron/activation.ts), so a slow thread
    // never holds later clicks back; superseded calls settle quietly here.
    try {
      await withTimeout(
        window.omni.agent.switchThread(threadId),
        threadSwitchTimeoutMs(),
        `Switch to ${threadId}`,
      );
    } catch (err) {
      if (switchId !== latestThreadSwitchId) return;
      if (pendingThreadTarget === threadId) pendingThreadTarget = null;
      set({
        pendingThreadTarget: null,
        error: err instanceof Error ? err.message : "Failed to switch thread",
      });
      throw err;
    }
    // A new click can arrive after this thread's snapshot paints but before
    // its IPC promise settles. Only the latest switch may settle the pending
    // target or read a fallback snapshot.
    if (switchId !== latestThreadSwitchId) return;
    // `agent:switchThread` emits the complete target snapshot before its IPC
    // promise resolves. Avoid a second renderer→main→renderer trip. Keep
    // fallback for older ACP bridges that do not emit that snapshot.
    if (get().state?.threadId !== threadId) {
      const state = preserveOptimisticState(get().state, await window.omni.agent.getState());
      set(() => {
        if (switchId !== latestThreadSwitchId || state.threadId !== threadId) return {};
        discardStreamDeltas();
        pendingThreadTarget = null;
        return withSnapshot({
          state,
          threadToolCalls: {
            ...get().threadToolCalls,
            [state.threadId ?? "__none__"]: state.toolCalls,
          },
          slice: createEmptySessionSlice({
            entries: state.entries,
            toolCalls: state.toolCalls,
            plan: state.plan,
            usage: state.usage,
            configOptions: state.configOptions,
            commands: state.commands,
            currentModeId: state.currentModeId,
            isStreaming: state.isStreaming,
            title: state.title,
          }),
          pendingThreadTarget: null,
          error: null,
        });
      });
    } else {
      pendingThreadTarget = null;
      set({ error: null, pendingThreadTarget: null });
    }
  },

  createThread: async (projectId, title, afterThreadId, agentId, worktreePath, initialModelId) => {
    flushStreamDeltas();
    const thread = await window.omni.agent.createThread(
      projectId,
      title ?? null,
      afterThreadId ?? null,
      agentId ?? null,
      worktreePath ?? null,
      initialModelId ?? null,
    );
    await get().refresh();
    return thread;
  },

  setConfigOption: async (configId, value) => {
    flushStreamDeltas();
    await window.omni.agent.setConfigOption(configId, value);
    await get().refresh();
  },

  listAgents: async () => {
    if (!window.omni.agent.listAgents) return [];
    return window.omni.agent.listAgents();
  },

  switchAgent: async (agentId) => {
    if (!window.omni.agent.switchAgent) return;
    flushStreamDeltas();
    set((s) => ({
      state: s.state ? { ...s.state, switchingAgent: true } : s.state,
    }));
    await window.omni.agent.switchAgent(agentId);
    await get().refresh();
  },

  setEditorText: async (text) => {
    await window.omni.agent.setEditorText(text);
  },
  pasteToEditor: async (text) => {
    await window.omni.agent.pasteToEditor(text);
  },
  reportEditorText: (text) => {
    window.omni.agent.reportEditorText(text);
  },

  getState: () => get().state,
  getCommands: () => get().state?.commands ?? get().slice.commands,
  getConfigOptions: () => get().state?.configOptions ?? get().slice.configOptions,
  getUsage: () => get().state?.usage ?? get().slice.usage,
  canAttachImage: () => Boolean(get().agentCapabilities?.promptCapabilities?.image),
  canEmbeddedContext: () => Boolean(get().agentCapabilities?.promptCapabilities?.embeddedContext),
  canAttachAudio: () => Boolean(get().agentCapabilities?.promptCapabilities?.audio),
}));

// Legacy alias helpers for gradual UI migration
export type { AcpSessionState as AgentRuntimeSnapshot };
