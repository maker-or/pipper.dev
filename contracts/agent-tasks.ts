import type { NextStep } from "./next-step.ts";

/**
 * Agent tasks: other agents a thread starts through the client-hosted
 * `pipper-agents` MCP server. Each task is a real thread nested under the
 * thread that started it (docs/agent-tasks/design.md).
 */

/** User preferences, persisted as `agent-tasks.json` in userData. */
export interface AgentTaskConfig {
  enabled: boolean;
  /** Agent ids that may be started as tasks, or "all" installed (non-mock) agents. */
  allowedAgents: string[] | "all";
  /** Running tasks one parent thread may have at once. */
  maxRunningPerThread: number;
  /** Running tasks across the app. */
  maxRunningTotal: number;
  /** Deepest task allowed; a user thread is depth 0. */
  maxDepth: number;
  /** "ask": the user approves each start in the parent thread. */
  startApproval: "ask" | "allow";
  /** "workspace": a child's reads and edits inside its own workspace need no prompt. */
  childPermissions: "ask" | "workspace";
  /** Wall-clock budget for one task turn before Pipper cancels it. */
  turnTimeoutMs: number;
  /** Queue a note into the parent thread when a task's turn settles. */
  notifyParent: boolean;
  /** Parent turns started by notes in a row before notes pause for the user. */
  maxAutomatedTurns: number;
}

export type AgentTaskStatus =
  | "starting"
  | "running"
  | "idle"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

/** What the child declared in its final `STATUS:` line. */
export type AgentTaskOutcome = "done" | "blocked" | "needs_input";

export type AgentTaskWorkspaceMode = "shared" | "new" | "path";

/** Renderer-facing view of one task. */
export interface AgentTaskSnapshot {
  taskId: string;
  parentThreadId: string;
  childThreadId: string | null;
  projectId: string;
  agentId: string;
  title: string;
  status: AgentTaskStatus;
  outcome: AgentTaskOutcome | null;
  /** Live: the child is waiting on a permission prompt. */
  waitingForPermission: boolean;
  workspaceMode: AgentTaskWorkspaceMode;
  workspacePath: string | null;
  branch: string | null;
  depth: number;
  turns: number;
  createdAt: number;
  updatedAt: number;
  /** The last wrap_up recap, else a short tail of the report, for status chips. */
  reportPreview: string | null;
  /** The last settled turn's wrap_up, if it called one. */
  nextStep: NextStep | null;
  error: string | null;
}
