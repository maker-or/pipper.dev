/**
 * Threads an agent started with the `create_thread` MCP tool, so the
 * transcript can link to them where the agent started them. Subthreads
 * (`start_subthread`) get no link here: the session panel lists them.
 *
 * The tool returns JSON with `thread_id` near the start, which survives into
 * the tool call's output preview. Adapters that never forward MCP results get
 * no link; the tab bar still has the thread.
 */

export interface ThreadLink {
  threadId: string;
}

/** "create_thread", "pipper-agents_create_thread", "mcp__pipper-agents__create_thread". */
const CREATE_THREAD_TOOL = /(?:^|[^a-z])create_thread$/i;
const THREAD_ID =
  /"thread_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

interface ToolPartLike {
  type?: unknown;
  name?: unknown;
  status?: unknown;
  outputPreview?: unknown;
}

const PROPOSAL_ID =
  /"proposal_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

/** A completed create_thread call's output preview. */
function createThreadOutput(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const tool = part as ToolPartLike;
  if (tool.type !== "toolCall" || tool.status !== "completed") return null;
  if (typeof tool.name !== "string" || typeof tool.outputPreview !== "string") return null;
  return CREATE_THREAD_TOOL.test(tool.name.trim()) ? tool.outputPreview : null;
}

export function threadLinkFromToolPart(part: unknown): ThreadLink | null {
  const output = createThreadOutput(part);
  const threadId = output && THREAD_ID.exec(output)?.[1];
  return threadId ? { threadId } : null;
}

/** The proposal id from a `create_thread` call with initiation "propose". */
export function threadProposalFromToolPart(part: unknown): string | null {
  const output = createThreadOutput(part);
  return (output && PROPOSAL_ID.exec(output)?.[1]) ?? null;
}
