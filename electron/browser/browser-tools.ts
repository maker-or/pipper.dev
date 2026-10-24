import type { McpToolDefinition } from "../mcp/mcp-http-server.ts";

/**
 * MCP tool definitions for the agent browser. Descriptions are written for
 * the model: they say when to use each tool and what comes back.
 */

const pageId = {
  type: "string",
  description: "Page to act on, e.g. p2. Defaults to the page you used last.",
};
const ref = {
  type: "string",
  description: "Element ref from the latest browser_snapshot, e.g. e12.",
};

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
  };
}

/**
 * What the model reads about this server as a whole: when to use widgets
 * versus files, the order of the widget tools, and what the browser is for.
 * Written as rules, not suggestions, so every model reads them the same way.
 */
export const BROWSER_SERVER_INSTRUCTIONS = [
  "This client (Pipper) shows inline visual widgets in the user's thread and gives you a headless browser.",
  "",
  "Widgets:",
  "- When the user asks for anything visual (a chart, graph, diagram, dashboard, visual report, comparison table or interactive explainer), answer with a widget. Also use one when numbers, structure or a process are clearer as a picture.",
  "- Steps: call widget_guide once per conversation, draft the widget, call preview_widget until it reports clean, then call show_widget. The widget appears in the thread at the point in your reply where you call show_widget.",
  "- show_widget is the only way to put a visual in front of the user. Do not write an HTML file, Markdown report or other artifact for the same content, and do not link one instead of showing the widget, unless the user explicitly asks for a file.",
  "- Keep explanations in your reply text, not inside the widget. After show_widget, don't describe what the widget shows; add only what the visual can't say.",
  "- To change a widget you showed, call update_widget with its id instead of showing a new one.",
  "- Most replies need no widget: answer short questions, plain lists and code in text.",
  "",
  "Browser:",
  "- Use browser_open, browser_snapshot, browser_click, browser_type and browser_screenshot to read web pages, check a local dev server (localhost works) or test a web app. Each session has its own private pages.",
].join("\n");

export const BROWSER_TOOLS: McpToolDefinition[] = [
  tool(
    "browser_open",
    "Open a URL in a headless browser page that belongs to this session. Use it to read docs, " +
      "check a deployed or local dev server (localhost works), or test a web app. Reuses your " +
      "current page unless new_page is true. Returns the page id, final URL, title and HTTP " +
      "status; call browser_snapshot next to read the page.",
    {
      url: { type: "string", description: "URL or bare host, e.g. localhost:3000." },
      new_page: { type: "boolean", description: "Open in a new page instead of the current one." },
    },
    ["url"],
  ),
  tool(
    "browser_snapshot",
    "Read the current page as a compact accessibility tree. Each element you can act on has a " +
      "ref like [ref=e4] for browser_click, browser_type, browser_scroll and browser_screenshot. " +
      "Refs expire when the page navigates; take a new snapshot after navigation.",
    {
      page_id: pageId,
      interactive_only: {
        type: "boolean",
        description: "List only links, buttons and form controls.",
      },
    },
  ),
  tool(
    "browser_click",
    "Click an element by ref. Waits for any navigation the click starts.",
    { ref, page_id: pageId },
    ["ref"],
  ),
  tool(
    "browser_type",
    "Type text into a text field by ref, replacing what's there unless clear is false. Set " +
      "submit to press Enter afterwards.",
    {
      ref,
      text: { type: "string" },
      submit: { type: "boolean", description: "Press Enter after typing." },
      clear: { type: "boolean", description: "Replace existing text (default true)." },
      page_id: pageId,
    },
    ["ref", "text"],
  ),
  tool(
    "browser_press",
    'Press a key or chord on the focused element, e.g. "Enter", "Escape", "ArrowDown", ' +
      '"Control+A".',
    { key: { type: "string" }, page_id: pageId },
    ["key"],
  ),
  tool(
    "browser_scroll",
    "Scroll the page by x/y pixels, or scroll an element into view by ref. Returns the new " +
      "scroll position.",
    {
      x: { type: "number", description: "Horizontal pixels (default 0)." },
      y: { type: "number", description: "Vertical pixels; positive scrolls down (default 600)." },
      ref,
      page_id: pageId,
    },
  ),
  tool(
    "browser_screenshot",
    "Capture the page as an image: the viewport by default, the whole page with full_page, or " +
      "one element by ref. Use it to check layout and visuals; use browser_snapshot to read text.",
    {
      full_page: { type: "boolean" },
      ref,
      page_id: pageId,
    },
  ),
  tool("browser_console", "Console messages logged since your last call, oldest first.", {
    level: {
      type: "string",
      enum: ["error", "warning", "all"],
      description: "Minimum level to include (default all).",
    },
    page_id: pageId,
  }),
  tool(
    "browser_network",
    "Network requests made since your last call, with method, status and failures.",
    {
      failed_only: { type: "boolean", description: "Only failed or 4xx/5xx requests." },
      page_id: pageId,
    },
  ),
  tool(
    "browser_eval",
    "Evaluate a JavaScript expression in the page and return its JSON value (truncated to " +
      "8 KB). Promises are awaited. Prefer snapshot and click for interaction.",
    { expression: { type: "string" }, page_id: pageId },
    ["expression"],
  ),
  tool("browser_back", "Go back in the page's history.", { page_id: pageId }),
  tool("browser_forward", "Go forward in the page's history.", { page_id: pageId }),
  tool("browser_reload", "Reload the page.", { page_id: pageId }),
  tool("browser_pages", "List this session's open pages with their URLs and titles."),
  tool("browser_close", "Close a page when you're done with it.", { page_id: pageId }),
];

export const WIDGET_TOOLS: McpToolDefinition[] = [
  tool(
    "widget_guide",
    "Returns Pipper's design rules for inline widgets: colour and surface tokens, type, " +
      "spacing, icons, motion, the .ff-* component classes, the runtime API and what is not " +
      "allowed. Call it before your first preview_widget in a conversation, and again for a " +
      'module you have not loaded. Pass only the modules this visual needs; "core" is always ' +
      "included. Do not mention this call to the user.",
    {
      modules: {
        type: "array",
        items: { type: "string", enum: ["chart", "diagram", "table", "interactive"] },
        description: "Extra rule modules to load alongside core.",
      },
    },
  ),
  tool(
    "preview_widget",
    "Renders widget code in a headless copy of Pipper's widget frame and returns screenshots " +
      "in light and dark themes, the measured size, script errors, blocked or missing " +
      "resources, and design checks (hardcoded colours, content wider than the frame, text " +
      "under 11px, low contrast, internal scrolling). Fix every error and check, then preview " +
      "again. The user does not see previews.",
    {
      widget_code: {
        type: "string",
        description: "HTML fragment or a single <svg>, written to the rules from widget_guide.",
      },
      width: {
        type: "number",
        description: "Frame width to test in px (default 680). Use 360 to check narrow layouts.",
      },
    },
    ["widget_code"],
  ),
];

WIDGET_TOOLS.push(
  tool(
    "show_widget",
    "Shows a visual widget inline in the user's thread: charts, diagrams, dashboards, visual " +
      "reports, data tables, comparisons, stat summaries and small interactive explainers. This " +
      "is the only way to show the user a visual; use it instead of writing an HTML or Markdown " +
      "report file unless the user asks for a file. Use it when a picture is clearer than text; " +
      "don't use it for short answers, plain lists, prose, or code the user will copy. " +
      "Pass an HTML fragment or a single <svg> written to widget_guide's rules, and preview it " +
      "with preview_widget first. Don't set a height or width; the frame sizes itself. Put " +
      "explanations in your reply text, never inside the widget. Returns a widget id; the user " +
      "already sees the widget, so don't describe its contents in text. To change it later, " +
      "call update_widget instead of showing a new one.",
    {
      title: {
        type: "string",
        pattern: "^[a-z0-9_]{3,60}$",
        description: "Specific snake_case name, e.g. q3_latency_by_region.",
      },
      widget_code: {
        type: "string",
        description: "HTML fragment or a single <svg>. No doctype, html, head or body.",
      },
      summary: {
        type: "string",
        maxLength: 280,
        description:
          "One or two plain sentences saying what the widget shows, for screen readers and " +
          "places that can't render it.",
      },
    },
    ["title", "widget_code", "summary"],
  ),
  tool(
    "update_widget",
    "Replaces the code of a widget you already showed in this thread, keeping its place in " +
      "the conversation. Use it to fix or extend a widget instead of showing a near-duplicate. " +
      "Preview the new code first.",
    {
      widget_id: { type: "string", description: "Id returned by show_widget." },
      widget_code: { type: "string" },
      summary: { type: "string", maxLength: 280 },
    },
    ["widget_id", "widget_code"],
  ),
);

export class ToolArgumentError extends Error {}

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolArgumentError(`"${key}" must be a non-empty string`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolArgumentError(`"${key}" must be a string`);
  return value;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ToolArgumentError(`"${key}" must be true or false`);
  return value;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolArgumentError(`"${key}" must be a number`);
  }
  return value;
}
