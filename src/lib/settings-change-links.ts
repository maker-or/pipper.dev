/**
 * Settings changes an agent made with the `update_settings` MCP tool, so the
 * transcript can show the change, with an undo, where the agent made it. The
 * tool returns JSON with `change_id` first, which survives into the tool
 * call's output preview.
 */

/** "update_settings", "pipper-agents_update_settings", "mcp__pipper-agents__update_settings". */
const SETTINGS_TOOL_NAME = /(?:^|[^a-z])update_settings$/i;
const CHANGE_ID =
  /"change_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

export function settingsChangeFromToolPart(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const tool = part as {
    type?: unknown;
    name?: unknown;
    status?: unknown;
    outputPreview?: unknown;
  };
  if (tool.type !== "toolCall" || tool.status !== "completed") return null;
  if (typeof tool.name !== "string" || typeof tool.outputPreview !== "string") return null;
  if (!SETTINGS_TOOL_NAME.test(tool.name.trim())) return null;
  return CHANGE_ID.exec(tool.outputPreview)?.[1] ?? null;
}
