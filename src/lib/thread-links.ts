/**
 * Threads an agent started with the `create_thread` or `start_subthread` MCP
 * tools, so the transcript can link to them where the agent started them.
 *
 * Both tools return JSON with `thread_id` near the start, which survives into
 * the tool call's output preview. Adapters that never forward MCP results get
 * no link; the tab bar still has the thread.
 */

export type ThreadLinkKind = "thread" | "subthread";

export interface ThreadLink {
  threadId: string;
  kind: ThreadLinkKind;
}

/** "create_thread", "pipper-agents_create_thread", "mcp__pipper-agents__start_subthread". */
const THREAD_TOOL_NAME = /(?:^|[^a-z])(create_thread|start_subthread)$/i;
const THREAD_ID =
  /"thread_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

interface ToolPartLike {
  type?: unknown;
  name?: unknown;
  status?: unknown;
  outputPreview?: unknown;
}

export function threadLinkFromToolPart(part: unknown): ThreadLink | null {
  if (!part || typeof part !== "object") return null;
  const tool = part as ToolPartLike;
  if (tool.type !== "toolCall" || tool.status !== "completed") return null;
  if (typeof tool.name !== "string" || typeof tool.outputPreview !== "string") return null;
  const name = THREAD_TOOL_NAME.exec(tool.name.trim())?.[1]?.toLowerCase();
  if (!name) return null;
  const threadId = THREAD_ID.exec(tool.outputPreview)?.[1];
  if (!threadId) return null;
  return { threadId, kind: name === "create_thread" ? "thread" : "subthread" };
}
