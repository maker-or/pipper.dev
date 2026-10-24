import type { InlineWidgetRef } from "../../contracts/acp.ts";

/**
 * Finds the widgets an agent showed with the `show_widget` MCP tool.
 *
 * Two signals, because ACP adapters report MCP calls differently:
 * - The tool result starts with `pipper-widget:<id>` (see
 *   `electron/browser/browser-service.ts`). Adapters that forward MCP results
 *   carry it into the tool call's output preview.
 * - Some adapters (Gemini via Antigravity) never forward MCP results; the
 *   output preview is the model's own label. Every adapter keeps the call's
 *   input, so a completed call is matched by its title and code instead, and
 *   main looks the widget up by that input.
 */

const WIDGET_MARKER = /^pipper-widget:(wdg_[a-f0-9]{32})\b/;
/** "show_widget", "pipper-browser_show_widget", "mcp__pipper-browser__show_widget", "Running show_widget". */
const SHOW_WIDGET_NAME = /(?:^|[^a-z])show_widget$/i;

interface ToolPartLike {
  type?: unknown;
  name?: unknown;
  status?: unknown;
  outputPreview?: unknown;
  args?: unknown;
}

export function widgetRefFromToolPart(
  part: unknown,
  threadId: string | null,
): InlineWidgetRef | null {
  if (!part || typeof part !== "object") return null;
  const tool = part as ToolPartLike;
  if (tool.type !== "toolCall") return null;
  if (typeof tool.outputPreview === "string") {
    const id = WIDGET_MARKER.exec(tool.outputPreview.trim())?.[1];
    if (id) return { id };
  }
  if (tool.status !== "completed") return null;
  if (typeof tool.name !== "string" || !SHOW_WIDGET_NAME.test(tool.name.trim())) return null;
  const input = showWidgetInput(tool.args);
  return input ? { threadId, ...input } : null;
}

/** Title and code from a show_widget call, flat or nested under `arguments`. */
function showWidgetInput(args: unknown): { title: string; code: string } | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const candidate of [record, record.arguments, record.input]) {
    if (!candidate || typeof candidate !== "object") continue;
    const { title, widget_code: code } = candidate as Record<string, unknown>;
    if (typeof title === "string" && typeof code === "string" && code.trim()) {
      return { title, code };
    }
  }
  return null;
}

/** Stable key for a ref, used to show each widget once and as a React key. */
export function widgetRefKey(ref: InlineWidgetRef): string {
  if ("id" in ref) return ref.id;
  let hash = 0;
  for (let i = 0; i < ref.code.length; i++)
    hash = (Math.imul(hash, 31) + ref.code.charCodeAt(i)) | 0;
  return `input:${ref.title}:${ref.code.length}:${hash >>> 0}`;
}

export type MessageBodyBlock =
  | { kind: "text"; text: string }
  | { kind: "widget"; ref: InlineWidgetRef; key: string };

/**
 * An assistant turn's visible body in timeline order: text segments with
 * widgets between them, where the agent showed them. Consecutive text joins
 * into one block, and a widget shown twice appears once.
 */
export function buildMessageBodyBlocks(
  parts: unknown[],
  threadId: string | null = null,
): MessageBodyBlock[] {
  const blocks: MessageBodyBlock[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string" && typed.text.trim()) {
      const last = blocks.at(-1);
      if (last?.kind === "text") last.text = `${last.text}\n\n${typed.text}`;
      else blocks.push({ kind: "text", text: typed.text });
      continue;
    }
    const ref = widgetRefFromToolPart(part, threadId);
    if (!ref) continue;
    const key = widgetRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({ kind: "widget", ref, key });
  }
  return blocks;
}
