import type { InlineWidgetDocument, InlineWidgetRef } from "../../contracts/acp.ts";
import { buildWidgetDocument } from "./widget-frame.ts";
import type { WidgetStore } from "./widget-store.ts";

const WIDGET_ID = /^wdg_[a-f0-9]{32}$/;
const MAX_INPUT_CODE_CHARS = 512 * 1024;

/**
 * Resolves what the thread asks for, by id (from the `pipper-widget:` marker)
 * or by the show_widget call's input (for agents that drop MCP results), into
 * the widget's sandboxed document. Anything malformed resolves to null.
 */
export function resolveWidgetDocument(
  store: WidgetStore,
  ref: unknown,
  theme: unknown,
): InlineWidgetDocument | null {
  const widget = lookUp(store, ref);
  if (!widget) return null;
  return {
    id: widget.id,
    title: widget.title,
    summary: widget.summary,
    updatedAt: widget.updatedAt,
    document: buildWidgetDocument(widget.code, theme === "dark" ? "dark" : "light"),
  };
}

function lookUp(store: WidgetStore, ref: unknown) {
  if (!ref || typeof ref !== "object") return null;
  const candidate = ref as Partial<Record<keyof InlineWidgetRef, unknown>> & { id?: unknown };
  if (typeof candidate.id === "string") {
    return WIDGET_ID.test(candidate.id) ? store.get(candidate.id) : null;
  }
  const { threadId, title, code } = candidate as Record<string, unknown>;
  if (typeof title !== "string" || typeof code !== "string") return null;
  if (code.length > MAX_INPUT_CODE_CHARS || title.length > 60) return null;
  return store.findByInput(typeof threadId === "string" ? threadId : null, title, code);
}
