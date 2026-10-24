/**
 * Finds the widgets an agent showed with the `show_widget` MCP tool. The tool
 * result starts with `pipper-widget:<id>` (see
 * `electron/browser/browser-service.ts`), and that text survives into the
 * tool call's output preview for any agent, so matching it there works no
 * matter how an agent names or titles MCP tools.
 */

const WIDGET_MARKER = /^pipper-widget:(wdg_[a-f0-9]{32})\b/;

export function widgetIdFromToolPart(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const record = part as { type?: unknown; outputPreview?: unknown };
  if (record.type !== "toolCall" || typeof record.outputPreview !== "string") return null;
  return WIDGET_MARKER.exec(record.outputPreview.trim())?.[1] ?? null;
}

export type MessageBodyBlock =
  | { kind: "text"; text: string }
  | { kind: "widget"; widgetId: string };

/**
 * An assistant turn's visible body in timeline order: text segments with
 * widgets between them, where the agent showed them. Consecutive text joins
 * into one block, and a widget shown twice appears once.
 */
export function buildMessageBodyBlocks(parts: unknown[]): MessageBodyBlock[] {
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
    const widgetId = widgetIdFromToolPart(part);
    if (widgetId && !seen.has(widgetId)) {
      seen.add(widgetId);
      blocks.push({ kind: "widget", widgetId });
    }
  }
  return blocks;
}
