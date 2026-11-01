/**
 * Connectors an agent asked for with the `add_connector` MCP tool, so the
 * transcript can show the card to connect it where the agent asked.
 *
 * Two signals, as for widgets (see `inline-widgets.ts`): the tool returns
 * JSON with `request_id` first, which survives into the output preview of
 * adapters that forward MCP results. Adapters that don't (Gemini via
 * Antigravity) keep only the call's input, so main finds the thread's request
 * for the same connector instead.
 */

import type { ConnectorRequestRef } from "../../contracts/connectors.ts";

/** "add_connector", "pipper-agents_add_connector", "mcp__pipper-agents__add_connector", "Running add_connector". */
const CONNECTOR_TOOL_NAME = /(?:^|[^a-z])add_connector$/i;
const REQUEST_ID =
  /"request_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

export function connectorRequestFromToolPart(
  part: unknown,
  threadId: string | null = null,
): ConnectorRequestRef | null {
  if (!part || typeof part !== "object") return null;
  const tool = part as {
    type?: unknown;
    name?: unknown;
    status?: unknown;
    outputPreview?: unknown;
    args?: unknown;
  };
  if (tool.type !== "toolCall" || tool.status !== "completed") return null;
  if (typeof tool.name !== "string" || !CONNECTOR_TOOL_NAME.test(tool.name.trim())) return null;
  const id =
    typeof tool.outputPreview === "string" ? REQUEST_ID.exec(tool.outputPreview)?.[1] : undefined;
  if (id) return { id };
  const input = connectorInput(tool.args);
  return input && threadId ? { threadId, input } : null;
}

/** The connector an add_connector call named, flat or nested under `arguments`. */
function connectorInput(
  args: unknown,
): Extract<ConnectorRequestRef, { input: unknown }>["input"] | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const candidate of [record, record.arguments, record.input]) {
    if (!candidate || typeof candidate !== "object") continue;
    const { catalog, url, command, args: commandArgs } = candidate as Record<string, unknown>;
    const text = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const input = {
      catalog: text(catalog),
      url: text(url),
      command: text(command),
      args: Array.isArray(commandArgs)
        ? commandArgs.filter((arg): arg is string => typeof arg === "string")
        : undefined,
    };
    if (input.catalog || input.url || input.command) return input;
  }
  return null;
}

/** Stable key for a ref: one card per request, or per connector asked for in a thread. */
export function connectorRequestKey(ref: ConnectorRequestRef): string {
  if ("id" in ref) return `connector:${ref.id}`;
  const { catalog, url, command, args } = ref.input;
  return `connector:${ref.threadId}:${catalog ?? url ?? [command, ...(args ?? [])].join(" ")}`;
}
