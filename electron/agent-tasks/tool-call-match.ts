import type { AcpToolCallState } from "../../contracts/acp.ts";

/** A session sharing an MCP endpoint, with the tool calls its agent reported. */
export interface ToolCallCandidate {
  sessionId: string;
  toolCalls: AcpToolCallState[];
}

/**
 * Drivers that keep MCP servers per working directory rather than per ACP
 * session. OpenCode registers `session/new`'s servers on the directory's
 * instance under their name, so a second session's server replaces the first.
 */
const MCP_PER_DIRECTORY_DRIVERS = new Set(["opencode-acp"]);

export function sharesMcpServersPerDirectory(driverId: string): boolean {
  return MCP_PER_DIRECTORY_DRIVERS.has(driverId);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Harnesses title MCP calls with the tool name, often prefixed by the server's. */
function namesTool(title: string, toolName: string): boolean {
  const escaped = toolName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(title.toLowerCase());
}

/**
 * The session whose agent is making this MCP call: an open tool call with the
 * same arguments, or failing that the same tool name. Null while it's
 * ambiguous or not reported yet; `claimed` holds `sessionId:toolCallId` keys
 * already matched to an earlier call.
 */
export function pickCallingSession(
  candidates: ToolCallCandidate[],
  toolName: string,
  args: Record<string, unknown>,
  claimed: ReadonlySet<string>,
): { sessionId: string; toolCallId: string } | null {
  const wanted = stableJson(args);
  let best: { sessionId: string; toolCallId: string; score: number } | null = null;
  let tied = false;
  for (const candidate of candidates) {
    let top: { toolCallId: string; score: number } | null = null;
    for (const call of candidate.toolCalls) {
      if (call.status === "completed" || call.status === "failed") continue;
      if (claimed.has(`${candidate.sessionId}:${call.toolCallId}`)) continue;
      const named = namesTool(call.title, toolName);
      const sameArgs = call.rawInput !== undefined && stableJson(call.rawInput) === wanted;
      const score = (sameArgs ? 2 : 0) + (named ? 1 : 0);
      if (score > 0 && (!top || score > top.score)) top = { toolCallId: call.toolCallId, score };
    }
    if (!top) continue;
    if (!best || top.score > best.score) {
      best = { sessionId: candidate.sessionId, ...top };
      tied = false;
    } else if (top.score === best.score) {
      tied = true;
    }
  }
  return best && !tied ? { sessionId: best.sessionId, toolCallId: best.toolCallId } : null;
}
