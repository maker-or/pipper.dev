import type { AgentStartFailureReason } from "./agents/start-failure.ts";
import type { StartRecoveryAction } from "./agents/start-recovery.ts";

export type AnalyticsWindowType = "launch" | "main" | "background";

export type AnalyticsSource =
  | "launch"
  | "agent_panel"
  | "agent_runtime"
  | "chat_prompt"
  | "unknown";

export type IntentCategory =
  | "ui_customization"
  | "workflow_change"
  | "new_feature"
  | "integration"
  | "automation"
  | "performance_improvement"
  | "bug_fix"
  | "unknown";

export type AnalyticsEventName =
  | "app_opened"
  | "project_created"
  | "project_git_initialized"
  | "worktree_created"
  | "workspace_switched"
  // advanced workspace git panel
  | "workspace_committed"
  | "workspace_pushed"
  | "workspace_pr_created"
  | "workspace_pr_merged"
  | "workspace_merged"
  | "workspace_continued"
  | "thread_created"
  | "thread_opened"
  | "agent_run_completed"
  // v2 — usage & duration
  | "app_closed"
  | "app_heartbeat"
  // v2 — agents
  | "prompt_submitted"
  | "turn_completed"
  | "turn_failed"
  | "prompt_timeout"
  | "tokens_reported"
  | "tool_call_finished"
  | "agent_task_settled"
  | "agent_connected"
  | "agent_connection_failed"
  | "agent_switched"
  | "onboarding_step"
  // An agent failed to start and Pipper tried a repair (agents/start-recovery.ts).
  | "agent_start_recovery";

export interface AnalyticsBaseProperties {
  app_version: string;
  session_id: string;
  window_type: AnalyticsWindowType;
  platform: NodeJS.Platform;
}

export interface AnalyticsProperties {
  project_id?: string;
  /** workspace_pr_created: whether the PR was opened as a draft. */
  draft?: boolean;
  thread_id?: string;
  model_id?: string;
  model_provider?: string;
  intent_category?: IntentCategory;
  source?: AnalyticsSource;
  thread_open_source?: "resident" | "snapshot" | "replay";
  icon?: string;
  execution_duration_ms?: number;
  files_changed_count?: number;
  error_type?: string;
  error_code?: string;
  /** agent_connection_failed: why the agent didn't start (see agents/start-failure.ts). */
  failure_reason?: AgentStartFailureReason;
  /** agent_connection_failed: the agent process's exit code, when it exited. */
  exit_code?: number;
  /**
   * agent_connected / agent_connection_failed: the first launch failed with
   * this reason and `recovery_action` was tried (agents/start-recovery.ts).
   * On agent_connected the retry worked; on agent_connection_failed it didn't.
   */
  recovered_from?: AgentStartFailureReason;
  recovery_action?: StartRecoveryAction;
  /** onboarding_step agent_pick_completed: driver ids the user picked. */
  selected_agents?: string[];
  selected_agent_count?: number;
  /** Whether the agent ran on the driver's default account or an added one. */
  agent_account?: "default" | "additional";
  /** agent_start_recovery: whether the repair got the agent started. */
  recovery_outcome?: "recovered" | "failed";
  /** agent_start_recovery: false when the repair found nothing to change. */
  recovery_retried?: boolean;
  /** agent_start_recovery: why the retry failed too (outcome "failed"). */
  final_failure_reason?: AgentStartFailureReason;
  /** agent_start_recovery: a chat connection, or a readiness check. */
  start_context?: "connection" | "readiness_check";
  success?: boolean;

  // v2 — agent identity (also promoted onto base properties when available)
  agent_id?: string;
  agent_name?: string;
  active_agent_id?: string;
  from_agent_id?: string;
  to_agent_id?: string;

  // v2 — enum/string dimensions
  stop_reason?: string;
  tool_kind?: string;
  install_kind?: string;
  failure_code?: string;
  phase?: string;
  step?: string;
  status?: string;
  task_category?: IntentCategory;
  cost_currency?: string;

  // v2 — numeric measures (clamped >= 0, rounded by the sanitizer)
  turn_duration_ms?: number;
  tokens_used?: number;
  context_size?: number;
  cost_amount?: number;
  session_duration_ms?: number;
  tool_call_count?: number;
  tool_duration_ms?: number;
  connect_duration_ms?: number;
  build_duration_ms?: number;
  download_duration_ms?: number;
  total_duration_ms?: number;
  restore_duration_ms?: number;
  iterations?: number;
  depth?: number;
  heartbeat_seconds?: number;

  // v2 — boolean flags
  /** Workspace context: true when the event happened on the project root ("main"). */
  is_main?: boolean;
  healthy?: boolean;
  has_images?: boolean;
  has_resources?: boolean;
}

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  windowType?: AnalyticsWindowType;
  properties?: AnalyticsProperties;
}
