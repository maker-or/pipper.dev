import type { AnalyticsProperties, IntentCategory } from "./analytics-schema.ts";
import type { AgentStartFailureReason } from "./agents/start-failure.ts";
import type { StartRecoveryAction } from "./agents/start-recovery.ts";

const INTENT_PATTERNS: Array<[IntentCategory, RegExp]> = [
  ["bug_fix", /\b(bug|fix|broken|error|crash|issue|regression|not working)\b/i],
  ["ui_customization", /\b(ui|style|design|color|layout|spacing|button|modal|screen|visual)\b/i],
  ["workflow_change", /\b(flow|workflow|onboarding|step|state|navigation|shortcut)\b/i],
  ["new_feature", /\b(add|create|new feature|implement|build|support|enable)\b/i],
  ["integration", /\b(api|webhook|oauth|clerk|posthog|stripe|github|integration)\b/i],
  ["automation", /\b(automate|schedule|reminder|monitor|background|cron)\b/i],
  ["performance_improvement", /\b(performance|speed|slow|latency|optimi[sz]e|cache)\b/i],
];

const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,128}$/;

export function categorizeIntent(input: string | null | undefined): IntentCategory {
  if (!input) return "unknown";
  for (const [category, pattern] of INTENT_PATTERNS) {
    if (pattern.test(input)) return category;
  }
  return "unknown";
}

export function sanitizeIdentifier(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) return undefined;
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return undefined;
  }
  return SAFE_IDENTIFIER.test(trimmed) ? trimmed : undefined;
}

/**
 * An agent id safe for analytics: the driver id only. Account ids are
 * `<driver>:<label>` with a label the user typed (often a person's name).
 */
export function sanitizeAgentId(value: string | null | undefined): string | undefined {
  return sanitizeIdentifier(value?.split(":")[0]);
}

/** Agent identity for an event: driver id, display name, and which account kind. */
export function agentAnalyticsIdentity(
  agentId: string,
  agentName?: string | null,
): Pick<AnalyticsProperties, "agent_id" | "agent_name" | "agent_account"> {
  return {
    agent_id: sanitizeAgentId(agentId),
    agent_name: sanitizeIdentifier(agentName),
    agent_account: agentId.includes(":") ? "additional" : "default",
  };
}

const FAILURE_REASONS = new Set<AgentStartFailureReason>([
  "not_installed",
  "package_install_failed",
  "auth_required",
  "timeout",
  "exited_early",
  "protocol_error",
  "unknown",
]);
const RECOVERY_ACTIONS = new Set<StartRecoveryAction>([
  "refresh_path",
  "purge_npx_cache",
  "wait_and_retry",
  "retry_longer",
  "retry",
]);

function oneOf<T extends string>(values: ReadonlySet<T>, value: unknown): T | undefined {
  return typeof value === "string" && values.has(value as T) ? (value as T) : undefined;
}

/** An integer (exit codes can be negative on Windows); drop non-finite values. */
function sanitizeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

export function sanitizeErrorType(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error && error.name) return sanitizeIdentifier(error.name);
  return sanitizeIdentifier(typeof error);
}

/** Clamp to a non-negative integer; drop non-finite values. */
function sanitizeCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value));
}

/** Clamp to a non-negative number, preserving fractional precision (e.g. cost in USD). */
function sanitizeAmount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
}

export function sanitizeAnalyticsProperties(properties: AnalyticsProperties): AnalyticsProperties {
  const sanitized: AnalyticsProperties = {};
  if (properties.project_id) sanitized.project_id = sanitizeIdentifier(properties.project_id);
  if (properties.thread_id) sanitized.thread_id = sanitizeIdentifier(properties.thread_id);
  if (properties.model_id) sanitized.model_id = sanitizeIdentifier(properties.model_id);
  if (properties.model_provider) {
    sanitized.model_provider = sanitizeIdentifier(properties.model_provider);
  }
  if (properties.intent_category) sanitized.intent_category = properties.intent_category;
  if (properties.source) sanitized.source = properties.source;
  if (properties.thread_open_source) {
    sanitized.thread_open_source = properties.thread_open_source;
  }
  if (properties.icon) sanitized.icon = sanitizeIdentifier(properties.icon);
  if (typeof properties.success === "boolean") sanitized.success = properties.success;
  if (typeof properties.execution_duration_ms === "number") {
    sanitized.execution_duration_ms = Math.max(0, Math.round(properties.execution_duration_ms));
  }
  if (typeof properties.files_changed_count === "number") {
    sanitized.files_changed_count = Math.max(0, Math.round(properties.files_changed_count));
  }
  if (properties.error_type) sanitized.error_type = sanitizeIdentifier(properties.error_type);
  if (properties.error_code) sanitized.error_code = sanitizeIdentifier(properties.error_code);

  // ─── v2: agent identity ──────────────────────────────────────────────────
  if (properties.agent_id) sanitized.agent_id = sanitizeAgentId(properties.agent_id);
  if (properties.agent_name) sanitized.agent_name = sanitizeIdentifier(properties.agent_name);
  if (properties.active_agent_id) {
    sanitized.active_agent_id = sanitizeAgentId(properties.active_agent_id);
  }
  if (properties.from_agent_id) {
    sanitized.from_agent_id = sanitizeAgentId(properties.from_agent_id);
  }
  if (properties.to_agent_id) sanitized.to_agent_id = sanitizeAgentId(properties.to_agent_id);
  if (properties.agent_account === "default" || properties.agent_account === "additional") {
    sanitized.agent_account = properties.agent_account;
  }

  // ─── agent start failures and their repairs ──────────────────────────────
  sanitized.failure_reason = oneOf(FAILURE_REASONS, properties.failure_reason);
  sanitized.final_failure_reason = oneOf(FAILURE_REASONS, properties.final_failure_reason);
  sanitized.recovered_from = oneOf(FAILURE_REASONS, properties.recovered_from);
  sanitized.recovery_action = oneOf(RECOVERY_ACTIONS, properties.recovery_action);
  if (properties.recovery_outcome === "recovered" || properties.recovery_outcome === "failed") {
    sanitized.recovery_outcome = properties.recovery_outcome;
  }
  if (typeof properties.recovery_retried === "boolean") {
    sanitized.recovery_retried = properties.recovery_retried;
  }
  if (properties.start_context === "connection" || properties.start_context === "readiness_check") {
    sanitized.start_context = properties.start_context;
  }
  sanitized.exit_code = sanitizeInteger(properties.exit_code);
  if (Array.isArray(properties.selected_agents)) {
    sanitized.selected_agents = [
      ...new Set(
        properties.selected_agents
          .map((id) => sanitizeAgentId(id))
          .filter((id): id is string => Boolean(id)),
      ),
    ].slice(0, 32);
  }
  sanitized.selected_agent_count = sanitizeCount(properties.selected_agent_count);

  // ─── v2: enum/string dimensions ──────────────────────────────────────────
  if (properties.stop_reason) sanitized.stop_reason = sanitizeIdentifier(properties.stop_reason);
  if (properties.tool_kind) sanitized.tool_kind = sanitizeIdentifier(properties.tool_kind);
  if (properties.install_kind) sanitized.install_kind = sanitizeIdentifier(properties.install_kind);
  if (properties.failure_code) sanitized.failure_code = sanitizeIdentifier(properties.failure_code);
  if (properties.phase) sanitized.phase = sanitizeIdentifier(properties.phase);
  if (properties.step) sanitized.step = sanitizeIdentifier(properties.step);
  if (properties.status) sanitized.status = sanitizeIdentifier(properties.status);
  if (properties.task_category) sanitized.task_category = properties.task_category;
  if (properties.cost_currency) {
    sanitized.cost_currency = sanitizeIdentifier(properties.cost_currency);
  }

  // ─── v2: numeric measures ────────────────────────────────────────────────
  sanitized.turn_duration_ms = sanitizeCount(properties.turn_duration_ms);
  sanitized.tokens_used = sanitizeCount(properties.tokens_used);
  sanitized.context_size = sanitizeCount(properties.context_size);
  sanitized.cost_amount = sanitizeAmount(properties.cost_amount);
  sanitized.session_duration_ms = sanitizeCount(properties.session_duration_ms);
  sanitized.tool_call_count = sanitizeCount(properties.tool_call_count);
  sanitized.tool_duration_ms = sanitizeCount(properties.tool_duration_ms);
  sanitized.connect_duration_ms = sanitizeCount(properties.connect_duration_ms);
  sanitized.build_duration_ms = sanitizeCount(properties.build_duration_ms);
  sanitized.download_duration_ms = sanitizeCount(properties.download_duration_ms);
  sanitized.total_duration_ms = sanitizeCount(properties.total_duration_ms);
  sanitized.restore_duration_ms = sanitizeCount(properties.restore_duration_ms);
  sanitized.iterations = sanitizeCount(properties.iterations);
  sanitized.depth = sanitizeCount(properties.depth);
  sanitized.heartbeat_seconds = sanitizeCount(properties.heartbeat_seconds);

  // ─── v2: boolean flags ───────────────────────────────────────────────────
  if (typeof properties.is_main === "boolean") sanitized.is_main = properties.is_main;
  if (typeof properties.healthy === "boolean") sanitized.healthy = properties.healthy;
  if (typeof properties.has_images === "boolean") sanitized.has_images = properties.has_images;
  if (typeof properties.has_resources === "boolean") {
    sanitized.has_resources = properties.has_resources;
  }

  // Drop keys the helpers resolved to `undefined` so they never reach PostHog.
  for (const key of Object.keys(sanitized) as Array<keyof AnalyticsProperties>) {
    if (sanitized[key] === undefined) delete sanitized[key];
  }
  return sanitized;
}
