/**
 * Shared ACP / Pipper agent bridge types for main ↔ renderer IPC.
 * Protocol types come from @agentclientprotocol/sdk; this file holds
 * app-level envelopes and store shapes.
 */

import type {
  AgentCapabilities,
  AuthMethod,
  AvailableCommand,
  ContentBlock,
  PlanEntry,
  SessionConfigOption,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  ToolKind,
  ToolCallStatus,
  ToolCallContent,
} from "@agentclientprotocol/sdk";

export type {
  AgentCapabilities,
  AuthMethod,
  AvailableCommand,
  ContentBlock,
  PlanEntry,
  SessionConfigOption,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  ToolKind,
  ToolCallStatus,
  ToolCallContent,
};

/** How the agent is expected to be available on the machine. */
export type AcpAgentInstallKind = "binary" | "npx" | "mock";

/** Registry entry describing an ACP agent Pipper can spawn. */
export interface AcpAgentDescriptor {
  id: string;
  /**
   * The underlying provider/driver this descriptor belongs to. For a plain
   * driver descriptor this is omitted and `id` is the driver id; for a
   * materialized account instance (`AcpAgentInstance`) `id` is the instance id
   * and this points back at the driver for display/analytics/install metadata.
   */
  driverId?: string;
  name: string;
  /** Display name shown in the UI. */
  displayName: string;
  version?: string;
  /** Spawn command (e.g. `agent`, `npx`, `codex-acp`). */
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * Names to delete from the child's environment before spawn. Used to drop
   * ambient provider credentials (e.g. OPENAI_API_KEY) for an isolated account
   * so its process cannot silently authenticate as the machine's default
   * account.
   */
  unsetEnv?: string[];
  /** Optional icon key for tab indicators. */
  icon?: string;
  /** Short description for onboarding. */
  description?: string;
  /** Docs / install page URL. */
  docsUrl?: string;
  /** External auth instructions for an agent-specific authentication failure. */
  authHint?: string;
  /** Human install command shown when the agent is not detected. */
  installHint?: string;
  installKind?: AcpAgentInstallKind;
  /** Commands probed on PATH to decide if the agent is installed. */
  detectCommands?: string[];
  /** npm package for npx-backed agents. */
  npmPackage?: string;
  /** True when a matching binary was found (or npx can fetch the package). */
  available?: boolean;
  /** Resolved absolute path of the detected binary, when known. */
  resolvedCommand?: string | null;
  /** Reason the agent is unavailable / needs setup. */
  statusMessage?: string | null;
}

/**
 * Outcome of actually spawning an agent and attempting an ACP `initialize`
 * handshake, as opposed to `AcpAgentDescriptor.available` which only checks
 * whether a binary/npx fetch path exists.
 */
export type AgentProbeStatus = "probing" | "ready" | "needs-install" | "needs-auth" | "error";

export interface AgentProbeResult {
  agentId: string;
  status: AgentProbeStatus;
  /** Human-readable reason, shown alongside install/auth/error states. */
  message?: string | null;
  /** Auth methods associated with a detected authentication requirement, when available. */
  authMethods?: AuthMethod[];
}

/**
 * A single environment variable supplied to a provider instance's child
 * process. Values never leave the main process in cleartext: a `sensitive`
 * value is redacted before an instance is sent to the renderer.
 */
export interface AcpAgentInstanceEnvVar {
  name: string;
  value: string;
  /** When true, the value is redacted in renderer-facing copies. */
  sensitive?: boolean;
}

/**
 * One named account/configuration of a provider driver. Pipper keeps a
 * separate child process, environment, and credential root per instance so
 * two accounts of the same driver (e.g. personal + work Codex) can coexist and
 * run side by side. An instance with `id === driverId` is the legacy/default
 * configuration that uses the ambient CLI login.
 */
export interface AcpAgentInstance {
  /** Routing key passed to {@link AcpAgentDescriptor.id} when spawning. */
  id: string;
  /** The provider driver this instance is a configuration of. */
  driverId: string;
  /** User-facing label, e.g. "Codex — Work". */
  displayName: string;
  enabled: boolean;
  /** Per-instance environment overrides, merged over the driver defaults. */
  env?: AcpAgentInstanceEnvVar[];
  /** Driver-specific, opaque configuration (e.g. a profile directory). */
  config?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}

/** Create/update payload for a provider instance. */
export interface AcpAgentInstanceInput {
  driverId: string;
  displayName: string;
  /** Optional explicit id; generated from driver + label when omitted. */
  id?: string;
  enabled?: boolean;
  env?: AcpAgentInstanceEnvVar[];
  config?: Record<string, unknown>;
}

/** Per-driver account-creation capabilities, surfaced to the settings UI. */
export interface AgentAccountSchema {
  driverId: string;
  displayName: string;
  icon?: string;
  /** Env var that points the CLI at an isolated credential root, if any. */
  profileEnvVar: string | null;
  /** Env var that carries an explicit credential value, if any. */
  authEnvVar: string | null;
  /** True when a driver beyond the ambient default can be configured. */
  supportsMultipleAccounts: boolean;
  /** True when the driver has an interactive sign-in command to launch. */
  supportsLogin: boolean;
}

/**
 * Account-level subscription rate limit for a session, when the agent reports
 * one. Distinct from `used`/`size` (per-turn context window): this describes the
 * plan's rolling usage window (e.g. Claude's 5-hour / weekly limits). Today only
 * the Claude ACP adapter surfaces this — it rides a `usage_update` whose
 * `_meta["_claude/rateLimit"]` carries the SDK's `rate_limit_info`. Other agents
 * leave it null, so the UI simply omits the section for them.
 */
export interface AcpRateLimitInfo {
  /** Gate state for the account's subscription limits. */
  status: "allowed" | "allowed_warning" | "rejected" | (string & {});
  /** Which limit window this describes, e.g. `five_hour` | `seven_day`. */
  rateLimitType?: string;
  /**
   * Percent of the window consumed, 0–100. Normalized to this scale at the
   * reducer boundary from whatever native scale the source reports (Claude
   * emits a 0–1 fraction), so consumers can use it directly without guessing.
   */
  utilization?: number;
  /** Unix epoch seconds when the window resets. */
  resetsAt?: number;
}

export interface AcpUsageState {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
  /** Subscription rate limit, when the agent reports one; null otherwise. */
  rateLimit?: AcpRateLimitInfo | null;
}

export interface AcpToolCallState {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  /**
   * Full tool bodies stay out of the session slice. They are parked in a
   * side map and only copied back onto a hydrated tool call for diff/trace
   * expand. Live session state over IPC carries the lean fields below.
   */
  content?: ToolCallContent[];
  locations?: Array<{ path: string; line?: number | null }>;
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Title-sized preview of content/rawOutput for the closed trace deck. */
  outputPreview?: string;
  hasPayload?: boolean;
  hasDiff?: boolean;
  terminalIds?: string[];
}

/**
 * One item in a session's ordered timeline. Mirrors ACP's flat stream of
 * `session/update` notifications: text/thought segments and tool calls are
 * siblings, and render order is arrival order. Consecutive chunks of the same
 * kind accumulate into the tail entry; a tool call between text chunks starts
 * a new segment, so interleaving is preserved. Tool call details live in
 * `AcpSessionState.toolCalls` keyed by `toolCallId`; `tool_call_update`
 * touches only that record, never the entry list.
 */
export type AcpEntry =
  | {
      type: "user_text";
      id: string;
      messageId: string | null;
      text: string;
      /**
       * Images attached to the user message. A restored display snapshot may
       * carry a placeholder (`data: ""` with `ref`) until main loads the
       * stored content; `ref` then stays set on the loaded image.
       */
      images?: Array<{ data: string; mimeType: string; ref?: string }>;
    }
  | { type: "agent_text"; id: string; messageId: string | null; text: string }
  | { type: "agent_thought"; id: string; messageId: string | null; text: string }
  | { type: "tool_call"; id: string; toolCallId: string };

/** Content part of a derived chat message; order matches the entry timeline. */
export type AcpMessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      kind?: ToolKind;
      status?: ToolCallStatus;
      arguments: Record<string, unknown>;
      args: Record<string, unknown>;
      content?: ToolCallContent[];
      rawOutput?: unknown;
      outputPreview?: string;
      hasPayload?: boolean;
      hasDiff?: boolean;
      terminalIds?: string[];
    };

/**
 * Chat message view derived from the entry timeline by the renderer
 * projection (`src/lib/acp-entries.ts`). Not sent over IPC.
 */
export interface AcpChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Concatenated visible text segments (no thought/tool content). */
  text: string;
  /** Concatenated thought segments. */
  thought: string;
  /** Parts in timeline order (thinking / toolCall / text interleaved). */
  content: AcpMessagePart[];
  toolCallIds: string[];
  /** True while the assistant message is still streaming. */
  streaming: boolean;
}

export interface AcpPermissionRequest {
  sessionId: string;
  /** JSON-RPC request id. Session ids are not unique while an agent is running. */
  requestId?: string | number;
  /** Thread that owns the session this permission belongs to, resolved in the
   *  main process from `sessionId`. Lets the renderer route the question to the
   *  right surface (inline composer vs. bottom-right dock). Null when the
   *  session isn't bound to a thread yet. */
  threadId?: string | null;
  toolCall: ToolCallUpdate | ToolCall;
  options: Array<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
  }>;
}

export interface AcpPermissionResponse {
  sessionId: string;
  /** Identifies which concurrent permission request is being answered. */
  requestId?: string | number;
  optionId?: string;
  /** When true, respond with cancelled outcome (e.g. after session/cancel). */
  cancelled?: boolean;
}

export interface AcpPromptInput {
  threadId?: string | null;
  /** Pre-assembled content blocks. If omitted, `message` + `images` are used. */
  prompt?: ContentBlock[];
  message?: string;
  images?: Array<{ data: string; mimeType: string }>;
  resources?: Array<{
    uri: string;
    name?: string;
    mimeType?: string;
    text?: string;
  }>;
  /**
   * Steer or follow-up behavior when a prompt is submitted while the agent is
   * mid-turn. Omitted for a normal (non-streaming) submit.
   */
  streamingBehavior?: "followUp" | "steer";
}

export interface AcpReplacePromptInput {
  threadId: string;
  /** Timeline entry id of the user message being replaced. */
  targetUserEntryId: string;
  message: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export interface AcpSessionState {
  projectId: string | null;
  threadId: string | null;
  agentId: string | null;
  agentSessionId: string | null;
  cwd: string | null;
  title: string | null;
  configOptions: SessionConfigOption[];
  commands: AvailableCommand[];
  /** Ordered session timeline; see {@link AcpEntry}. */
  entries: AcpEntry[];
  toolCalls: Record<string, AcpToolCallState>;
  plan: PlanEntry[] | null;
  usage: AcpUsageState | null;
  currentModeId: string | null;
  isStreaming: boolean;
  isCompacting: boolean;
  editorText: string;
  authRequiredMessage: string | null;
  switchingAgent: boolean;
}

export type AcpBridgeEvent =
  | { type: "session-state"; state: AcpSessionState }
  | { type: "session-update"; sessionId: string; threadId: string | null; update: SessionUpdate }
  /** Live/background tool-call watermark. Activation uses session-state only. */
  | {
      type: "thread-tool-calls";
      threadId: string;
      toolCalls: Record<string, AcpToolCallState>;
      /** False when this event carries only changed tool-call records. Defaults to full replace. */
      replace?: boolean;
    }
  | { type: "permission-request"; request: AcpPermissionRequest }
  | { type: "permission-resolved"; sessionId: string; requestId?: string | number }
  | { type: "thread-closed"; threadId: string }
  | {
      type: "connection";
      agentId: string | null;
      agentCapabilities: AgentCapabilities | null;
      authMethods: AuthMethod[];
      authRequiredMessage?: string | null;
    }
  | { type: "notification"; message: string; level: "info" | "warning" | "error" }
  | { type: "title"; threadId: string; title: string }
  | { type: "terminal-output"; terminalId: string; output: string; append: boolean }
  | { type: "editor-text"; text: string }
  | { type: "stop"; sessionId: string; threadId: string | null; stopReason: string }
  /** Thread IDs whose agent is currently streaming, across all open threads. */
  | { type: "running-threads"; threadIds: string[] }
  /** A widget's code changed (update_widget); frames showing it reload. */
  | { type: "widget-updated"; widgetId: string; threadId: string | null }
  /** Snapshot of all subagent runs whenever any run changes state. */
  | { type: "subagent-runs"; runs: SubagentRunSnapshot[] }
  /** Provider model catalogs that changed (cached in main; see getModelCatalogs). */
  | {
      type: "model-catalogs";
      catalogs: Record<string, Array<{ modelId: string; name: string; provider?: string }>>;
    };

/** A visual an agent showed in a thread with the `show_widget` tool. */
export interface InlineWidgetRecord {
  /** `wdg_…`; referenced from the tool result as `pipper-widget:<id>`. */
  id: string;
  threadId: string | null;
  sessionId: string | null;
  /** snake_case name chosen by the agent; also the download name. */
  title: string;
  /** Plain-text fallback for screen readers, exports and failed renders. */
  summary: string;
  /** HTML fragment or single <svg>. */
  code: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * How the thread asks for a widget: by id when the agent forwarded the
 * show_widget result, otherwise by the call's input.
 */
export type InlineWidgetRef =
  | { id: string }
  | { threadId: string | null; title: string; code: string };

/** What the renderer loads to display a widget: its sandboxed document. */
export interface InlineWidgetDocument {
  id: string;
  title: string;
  summary: string;
  updatedAt: number;
  /** Complete HTML document for the widget's sandboxed frame. */
  document: string;
}

/**
 * User preferences for the agent browser (headless pages agents drive over
 * MCP). Persisted as `browser.json` in the app's userData directory.
 */
export interface BrowserConfig {
  /** Offer browser tools to new agent sessions. Off also closes open pages. */
  enabled: boolean;
  /** Pages one session may have open at once. */
  pagesPerSession: number;
  /** Close a page after this many minutes without a tool call. */
  idleMinutes: number;
  /** "ask" prompts in the thread before a page may download a file. */
  downloads: "ask" | "block";
}

/**
 * User preferences for the client-hosted subagent tool. Persisted as
 * `subagents.json` in the app's userData directory so each user can pick
 * which of their installed ACP agents may be spawned as subagents.
 */
export interface SubagentConfig {
  enabled: boolean;
  /** Agent ids offered as subagents, or "all" installed (non-mock) agents. */
  allowedAgents: string[] | "all";
  /** Max subagent runs executing at once across the app; extra calls queue. */
  maxConcurrent: number;
  /**
   * How deep subagent chains may go. Depth 0 is a user-facing session; a
   * spawn at depth d creates a session at depth d+1, which only receives the
   * subagent tool while d+1 < maxDepth.
   */
  maxDepth: number;
  /** Auto-approve permission requests raised by headless subagent sessions. */
  autoApprovePermissions: boolean;
  /** Wall-clock budget per subagent run before the client cancels it. */
  runTimeoutMs: number;
}

export type SubagentRunStatus = "queued" | "running" | "finished" | "failed" | "cancelled";

/** Renderer-facing snapshot of one subagent run, for activity UI. */
export interface SubagentRunSnapshot {
  runId: string;
  /** ACP session id of the orchestrator that spawned this run, when known. */
  parentSessionId: string | null;
  /** ACP session id of the subagent's own session, once created. */
  sessionId: string | null;
  agentId: string;
  /** Truncated task text for display. */
  task: string;
  status: SubagentRunStatus;
  depth: number;
  startedAt: number;
  finishedAt: number | null;
  /** Truncated tail of the subagent's final text, once finished. */
  resultPreview: string | null;
}

export interface McpServerRecord {
  id: string;
  name: string;
  transport_type: "http" | "sse" | "stdio";
  url: string | null;
  command: string | null;
  args: string | null;
  env: string | null;
  created_at: number;
  updated_at: number;
}

export interface McpServerInput {
  name: string;
  transport_type: "http" | "sse" | "stdio";
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
}
