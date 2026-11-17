/**
 * Claude Code sends tool schemas behind ToolSearch, names only until the model
 * asks for one, but by default only once the schemas would fill a large share
 * of the context. Below that threshold it sends every schema on every request.
 * Through the Agent SDK that is 25 built-in tools plus every MCP tool (Pipper's
 * own 34), about 2.5x the request the terminal CLI sends for the same "hi".
 *
 * Turn tool search on for Claude sessions so every request carries names
 * instead. A value the user set wins: an ENABLE_TOOL_SEARCH already in the
 * environment is kept, and Claude Code applies settings.json `env` after the
 * process environment.
 */
export function applyToolSearchEnv(driverId: string, env: Record<string, string>): void {
  if (driverId !== "claude-agent-acp") return;
  env.ENABLE_TOOL_SEARCH ??= "true";
}
