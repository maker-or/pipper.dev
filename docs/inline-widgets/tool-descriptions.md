# Inline widget tools

Draft descriptions and schemas for the MCP tools that let an agent render inline
widgets in a Pipper thread. The descriptions are written for the model: they are
what it reads when deciding whether and how to call each tool.

Flow: `widget_guide` → draft → `preview_widget` (repeat until clean) →
`show_widget` → optionally `update_widget`.

## Server instructions

Sent once as the MCP server's `instructions`, which most ACP clients add to the
system prompt.

```text
This client renders inline visual widgets in the thread. When a chart, diagram,
comparison table or small interactive tool would explain something better than
prose, draw one: call widget_guide first, preview it with preview_widget, then
show it with show_widget. Keep explanations in your reply text, not in the
widget. Most replies need no widget.
```

## `widget_guide`

```text
Returns Pipper's design rules for inline widgets: colour and surface tokens,
type, spacing, icons, motion, the .ff-* component classes, the runtime API and
what is not allowed. Call it before your first show_widget or preview_widget in
a conversation, and again if you need a module you have not loaded. Pass only
the modules this visual needs; "core" is always included.

Do not mention this call to the user. Go straight to the visual.
```

```json
{
  "type": "object",
  "properties": {
    "modules": {
      "type": "array",
      "items": { "enum": ["chart", "diagram", "table", "interactive"] },
      "description": "Extra rule modules to load alongside core."
    }
  }
}
```

## `preview_widget`

```text
Renders widget code in a headless copy of the Pipper widget frame and returns a
screenshot in light and dark themes, the measured content size, console errors,
blocked or missing resources, and design-lint warnings (hardcoded colours,
content wider than the frame, text under 11px, low contrast, internal scrolling).

Call it after drafting and before show_widget. Fix every error and warning,
then preview again. When the result is clean, call show_widget with the same
code. The user does not see previews.
```

```json
{
  "type": "object",
  "required": ["widget_code"],
  "properties": {
    "widget_code": {
      "type": "string",
      "description": "HTML fragment or a single <svg>. Same value you will pass to show_widget."
    },
    "width": {
      "type": "number",
      "description": "Frame width to test, in px. Defaults to the thread's current width. Use 360 to check narrow layouts."
    }
  }
}
```

Result shape:

```json
{
  "screenshots": { "light": "<image>", "dark": "<image>" },
  "size": { "width": 680, "height": 312 },
  "console": [{ "level": "error", "message": "...", "line": 14 }],
  "blocked": ["https://example.com/lib.js"],
  "lint": [{ "rule": "hardcoded-color", "message": "#333 on line 8; use --foreground" }]
}
```

## `show_widget`

```text
Shows a visual widget inline in the thread: charts, diagrams, data tables,
comparisons, stat summaries, and small interactive explainers or calculators.

Use it when a picture is clearer than text: numbers to compare, a process or
architecture to see, data to sort or filter, a mechanism to play with.
Do not use it for short answers, plain lists, prose, or code the user will copy;
answer those in text.

Pass an HTML fragment or a single <svg>, written to the rules from widget_guide.
Don't set a height or width; the frame sizes itself to the content. Put any
explanation in your reply text, before or after the call, never inside the
widget.

Returns a widget id. The user already sees the widget, so don't describe or
repeat its contents in text. To change it later, call update_widget with that
id instead of showing a new one.
```

```json
{
  "type": "object",
  "required": ["title", "widget_code", "summary"],
  "properties": {
    "title": {
      "type": "string",
      "pattern": "^[a-z0-9_]{3,60}$",
      "description": "Specific snake_case name, e.g. q3_latency_by_region. Used as the widget's label and download name."
    },
    "widget_code": {
      "type": "string",
      "description": "HTML fragment or a single <svg>. No doctype, html, head or body."
    },
    "summary": {
      "type": "string",
      "maxLength": 280,
      "description": "One or two plain sentences saying what the widget shows. Used for screen readers, notifications, exports and clients that cannot render widgets."
    },
    "loading_messages": {
      "type": "array",
      "items": { "type": "string" },
      "maxItems": 3,
      "description": "Short status lines shown while the widget streams in."
    }
  }
}
```

Result:

```json
{ "widget_id": "wdg_01J…", "status": "shown" }
```

## `update_widget`

```text
Replaces the code of a widget you already showed in this thread, keeping its
place in the timeline. Use it to fix or extend a widget after user feedback
instead of showing a near-duplicate. Preview the new code first.
```

```json
{
  "type": "object",
  "required": ["widget_id", "widget_code"],
  "properties": {
    "widget_id": { "type": "string" },
    "widget_code": { "type": "string" },
    "summary": { "type": "string", "maxLength": 280 }
  }
}
```

## Host-side notes

- `preview_widget` runs on the shared headless browser described in
  `browser-service.md`, which also exposes general `browser_*` tools to agents.

- The timeline creates a widget item when a `show_widget` tool call completes,
  keyed by the tool name. It never parses HTML out of streamed text.
- Store `widget_code` as a thread-scoped attachment; the tool result returned to
  the model holds only the id, so the transcript doesn't carry the markup twice.
- Lint rules in `preview_widget` and the rules in `design-guide.md` must stay in
  sync. When a token or `.ff-*` class changes, update both.
