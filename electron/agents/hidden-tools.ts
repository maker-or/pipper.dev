/**
 * Claude Code built-in tools Pipper hides from Claude sessions, because Pipper
 * covers the job itself or the tool works against it. The first four are sent
 * with their full schema on every request, about 4,000 tokens together even
 * with tool search on; the rest are deferred and hidden for behavior.
 */
export const HIDDEN_CLAUDE_TOOLS = [
  // /workflow scripts. Pipper's subthreads run multi-agent work.
  "Workflow",
  // /loop pacing itself.
  "ScheduleWakeup",
  // Code-review findings for a host UI to draw; Pipper draws none, so the
  // review falls back to text.
  "ReportFindings",
  // Claude agent teams. Pipper's threads talk through message_thread.
  "ListAgents",
  "SendMessage",
  "TaskStop",
  // Pipper owns worktrees: a session that switches into its own would drop
  // out of Pipper's diff and workspace views.
  "EnterWorktree",
  "ExitWorktree",
  // A terminal notification. Pipper notifies when a thread needs the user.
  "PushNotification",
] as const;

/**
 * `_meta` for session/new, session/load and session/resume. claude-agent-acp
 * merges `options.disallowedTools` into the SDK's own list; other agents get
 * nothing.
 */
export function sessionMeta(driverId: string): { _meta?: Record<string, unknown> } {
  if (driverId !== "claude-agent-acp") return {};
  return { _meta: { claudeCode: { options: { disallowedTools: [...HIDDEN_CLAUDE_TOOLS] } } } };
}
