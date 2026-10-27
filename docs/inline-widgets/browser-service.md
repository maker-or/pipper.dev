# Browser service

A headless browser that Pipper hosts in its main process and exposes to agents
over MCP. It backs `preview_widget` and also gives any ACP agent a general
browser: open a page, read it, click, type, screenshot, inspect console and
network.

Status: implemented in `electron/browser/` and `electron/widgets/`. See
"Implementation notes" at the end for where the code differs from this design.

## Goals

- One engine for widget previews and agent browsing, so a preview renders with
  the same Chromium, fonts and sandbox rules as the real widget frame.
- No extra install: use Electron's bundled Chromium. No separate Chrome, Rust
  binary or long-lived daemon.
- Every page belongs to one ACP session and is torn down with it.
- Compact, text-first output that keeps agent context small.
- Bounded resource use under load.

## Non-goals

- Driving the user's own browser or reusing their sign-ins.
- A remote debugging port. The service never calls
  `app.commandLine.appendSwitch("remote-debugging-port")`; an open port would let
  any local process control every Pipper window.
- Visible browsing UI. A browser pane can come later and reuse this service.

## Where it lives

The subagent tool already solves the hard part: a client-hosted MCP endpoint
per ACP session. Follow the same pattern rather than adding a second server.

| Piece                                      | Existing precedent                         | Browser service                                        |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------ |
| HTTP MCP server on `127.0.0.1:0`           | `electron/subagents/mcp-http-server.ts`    | Same server class, generalized (see below)             |
| Per-session token at `/mcp/<token>`        | `SubagentManager.attachMcpServers`         | `BrowserService.attachMcpServers`                      |
| stdio fallback for agents without HTTP MCP | `electron/subagents/stdio-proxy.ts`        | Same shim, different URL                               |
| Bind token to session id                   | `bindSession`                              | Same                                                   |
| Release on session close                   | `releaseSessionMcp`                        | Same, plus closing every page the session owns         |
| Wiring into `session/new`                  | `AgentConnectionManager.sessionMcpServers` | Chain a second `attachMcpServers` call after subagents |

Proposed files:

- `electron/mcp/mcp-http-server.ts`: move the existing server here and make it
  shared. `SERVER_INFO` becomes a per-endpoint value so `pipper-subagents` and
  `pipper-browser` identify separately, and `McpToolResult.content` gains
  `{ type: "image", data, mimeType }` for screenshots.
- `electron/browser/browser-service.ts`: page pool, sessions, limits, lifecycle.
- `electron/browser/browser-page.ts`: one hidden page and its CDP wrapper.
- `electron/browser/snapshot.ts`: accessibility tree → compact text with refs.
- `electron/browser/widget-preview.ts`: `preview_widget` on top of the pool.
- `electron/browser/browser-tools.ts`: MCP tool definitions and argument
  validation.

Run one HTTP server for both endpoint types if the generalization stays small;
otherwise one instance each. Either way, tokens and endpoints stay per session.

## Engine

Each page is a hidden `BrowserWindow`:

```ts
new BrowserWindow({
  show: false,
  width: 1280,
  height: 800,
  webPreferences: {
    partition: `browser:${sessionId}`, // not persist:, so nothing touches disk
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    javascript: true,
    backgroundThrottling: false,
    offscreen: false,
  },
});
```

- **CDP without a port:** `webContents.debugger.attach("1.3")`, then
  `sendCommand` for `Accessibility.getFullAXTree`, `Input.dispatchMouseEvent`,
  `Runtime.evaluate`, `Network.*`, `Emulation.setEmulatedMedia`, etc.
- **Screenshots:** `webContents.capturePage()`, PNG, downscaled to at most
  1280px wide before returning.
- **Console:** the `console-message` event, ring-buffered per page (200 entries).
- **Network:** `Network.requestWillBeSent` / `responseReceived` /
  `loadingFailed`, ring-buffered (500 entries). Bodies are fetched only on
  request with `Network.getResponseBody`.
- **Isolation:** each ACP session gets its own in-memory partition. Agents never
  share cookies with each other or with Pipper's UI windows.

## Tools

Tool results are text unless noted. Every page-scoped tool takes an optional
`page_id`; without it the session's most recent page is used.

| Tool                                                  | Does                                                  | Returns                                    |
| ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `browser_open`                                        | Opens a URL in a new or existing page                 | `page_id`, final URL, title, HTTP status   |
| `browser_snapshot`                                    | Accessibility tree with refs; `interactive_only` flag | Text tree, e.g. `- button "Save" [ref=e4]` |
| `browser_click`                                       | Clicks a ref                                          | Short result plus any navigation           |
| `browser_type`                                        | Types into a ref; optional `submit`                   | Short result                               |
| `browser_press`                                       | Presses a key or chord                                | Short result                               |
| `browser_scroll`                                      | Scrolls page or ref                                   | New scroll position                        |
| `browser_screenshot`                                  | Viewport, full page or one ref                        | Image content                              |
| `browser_console`                                     | Console entries since last call; `level` filter       | Text lines                                 |
| `browser_network`                                     | Requests since last call; `failed_only` filter        | Text lines                                 |
| `browser_eval`                                        | Runs a JS expression; returns JSON                    | JSON, truncated to 8 KB                    |
| `browser_back` / `browser_forward` / `browser_reload` | History                                               | URL and title                              |
| `browser_close`                                       | Closes a page                                         | —                                          |
| `preview_widget`                                      | See `tool-descriptions.md`                            | Screenshots, size, console, blocked, lint  |

Refs are valid until the next navigation or snapshot. A stale ref returns an
error telling the agent to snapshot again, never a click on the wrong element.

Snapshot output targets 200–400 tokens for a typical page: roles and names
only, collapsed generic containers, text runs truncated at 80 characters,
hidden nodes dropped.

## Widget preview path

`preview_widget` doesn't go through the general tools. It keeps one or two warm
pages that already have the widget frame loaded (`widget-frame.html` with
`widget-frame.css`, fonts and icons), so a preview only swaps content:

1. Post the widget code into the warm frame.
2. Wait for fonts, scripts, then two animation frames.
3. Read the measured size from the frame's `ResizeObserver`.
4. Capture with `data-workspace-theme="light"`, flip to `"dark"`, capture again.
5. Collect console errors, failed requests and lint results.
6. Reset the frame for the next call.

Target: under 300 ms per preview with a warm page. The page is recreated after
50 previews or any crash.

## Limits

Defaults, configurable in settings:

| Limit                     | Default                                         |
| ------------------------- | ----------------------------------------------- |
| Pages per session         | 4                                               |
| Pages across all sessions | 12 (excluding warm preview pages)               |
| Idle page timeout         | 5 min                                           |
| Navigation timeout        | 30 s                                            |
| Tool call timeout         | 30 s (matches the MCP server's request timeout) |
| Renderer memory per page  | Close and report an error over 1 GB             |
| Screenshot size           | 1280 px wide, PNG under 1.5 MB                  |

When a limit is hit, the tool returns an error naming the limit and what to do
(for example "Close a page with browser_close"), never a silent failure.

## Safety

- **Blocked schemes:** `file:`, `chrome:`, `devtools:`, `about:` other than
  `about:blank`, and Pipper's own origins. Enforced in `will-navigate`,
  `setWindowOpenHandler` and `session.webRequest.onBeforeRequest`.
- **Local addresses:** `localhost` and private ranges are allowed, since agents
  need to test dev servers, but each is shown in the thread with its port.
- **Downloads:** cancelled by default; an agent asks through Pipper's existing
  permission coordinator (`electron/permission-coordinator.ts`) to allow one.
- **Permissions:** camera, mic, location, notifications and clipboard are denied
  via `setPermissionRequestHandler`.
- **Popups:** `setWindowOpenHandler` opens them as new hidden pages in the same
  session, counted against the page limit.
- **Credentials:** the service never fills saved passwords. Typing into a
  password field is allowed only when the agent's own text is the value.
- **Audit:** every navigation and tool call is recorded on the thread, so the
  user can see what an agent did.

## Lifecycle invariants

- **Trusted state:** `BrowserService.sessions: Map<token, { sessionId, pages }>`.
- **Writers:** `attachMcpServers` (create), `bindSession` (assign session id),
  tool calls (add and remove pages), `releaseSessionMcp` and `dispose` (destroy).
- **Session close or agent crash:** `releaseSessionMcp` closes every page,
  detaches the debugger and clears the partition before unregistering the
  token.
- **Pipper quit:** `dispose` runs inside `bounded-shutdown.ts` with a 2 s
  budget; pages are destroyed, not closed gracefully.
- **Renderer crash (`render-process-gone`):** the page is removed and the next
  call returns "page crashed; open it again". The session stays usable.
- **Reconnect and resume:** a resumed ACP session gets a new token and starts
  with no pages. Pages are never carried across a reconnect.
- **Unbound tokens:** a token never bound to a session is released after 60 s.

## Tests

Behaviour-level, in line with `AGENT.md`:

- A session's pages close when the session closes or its agent crashes.
- Two sessions can't see each other's cookies or storage.
- Blocked schemes and Pipper origins can't be opened, including via redirects
  and popups.
- Hitting the page limit returns an actionable error and leaves existing pages
  working.
- A stale ref errors instead of clicking another element.
- `preview_widget` reports a console error, a blocked script and a hardcoded
  colour from a deliberately broken widget.
- Agents without HTTP MCP reach the same tools through the stdio shim.

## Open questions

1. Should `browser_*` tools be on by default for every agent, or enabled per
   project?
2. Should a browser pane in the UI mirror an agent's page live, or only show
   screenshots?
3. Should sessions be allowed to keep sign-in state across turns (a persistent
   partition per project), and if so, how does the user clear it?

## Implementation notes

Where the code differs from the design above:

- **Built:** every `browser_*` tool in the table, plus `browser_pages`;
  `widget_guide` and `preview_widget` on the same endpoint; per-session
  endpoints with the stdio fallback; limits; idle and memory sweeps; blocked
  schemes, Pipper's dev renderer origin, permissions and popups; crash handling;
  per-session call serialization; stale-ref errors.
- **Shown widgets:** `show_widget` stores the code in the `inline_widgets` table
  and returns `pipper-widget:<id>` as the first line of its result. The renderer
  (`src/lib/inline-widgets.ts`) finds widgets two ways, because ACP adapters
  report MCP calls differently:
  - **By id:** when the adapter forwards the MCP result, the marker reaches the
    tool call's output preview.
  - **By input:** some adapters never forward MCP results (Gemini via
    Antigravity puts the model's own label in the output). Every adapter keeps
    the call's input, so a completed `show_widget` call is matched by its title
    and code within the thread. Main stores a hash of the original input
    (`input_hash`), so the match survives `update_widget`.

  Widgets show between the turn's text, in order. `update_widget` replaces the
  code and emits a `widget-updated` event so the frame reloads in place.

- **Server instructions:** the MCP `initialize` result carries `instructions`
  (`BROWSER_SERVER_INSTRUCTIONS` in `electron/browser/browser-tools.ts`): use a
  widget for anything visual, the widget tool order, and not to write HTML or
  Markdown report files instead of showing a widget.
- **Thread frame:** `src/components/inline-widget.tsx` loads the document from
  `widgets:getDocument` into an `<iframe sandbox="allow-scripts">` (opaque
  origin, no navigation or popups). It accepts only resize, ready, openLink
  (https, after a confirm dialog) and sendPrompt. The frame runtime sends
  `sendPrompt` only during a click or keypress. Theme and shape changes are
  posted to the frame without reloading it.
- **Not built yet:** a browser pane; deleting a thread doesn't yet delete its
  widget rows.
- **Settings:** Settings → Browser (`browser.json` in userData): on/off, pages per
  session (1–8), idle timeout (1–60 min), downloads ask/block. Turning it off
  closes open pages and makes further calls return an error. The total page
  cap, timeouts and screenshot sizes stay as code defaults.
- **Downloads:** a download is saved into a per-session temp folder, paused,
  and resumed only after the user answers a permission prompt in the thread
  (through `PermissionCoordinator`). With downloads set to block, nothing is
  asked. The agent learns the outcome and saved path on its next call. The
  folder is deleted when the session closes.
- **Timeouts:** a timed-out call returns an error, but the session's next call
  waits until that call's work settles. If it is still running 15 s after the
  timeout, its page is closed as wedged and the agent is told.
- **Widget preview:** previews share one hidden page in its own partition,
  recycled every 50 renders, outside the per-session page limits. Each render
  loads the frame fresh (a data: URL), renders light then dark, and takes about
  250–450 ms. The frame inlines `src/index.css` tokens and the Phosphor icon
  font, so it needs no network. Fonts use Inter / JetBrains Mono when
  installed, otherwise system fonts.
- **Storage clearing:** releasing a session clears cookies and cache only.
  Clearing DOM storage on an in-memory partition blocks Electron's main thread
  (Electron 42), so it's skipped. Partition names are unique per token and
  never reused, so leftover DOM storage is unreachable until Pipper quits.
- **CDP needs a document:** a window that has never loaded ignores CDP
  commands, so each page loads `about:blank` before attaching the debugger and
  clears that entry from history after its first real navigation.
- **Quitting on Windows/Linux:** hidden agent windows count as open windows, so
  `main.ts` now quits when the last non-agent window closes
  (`isAgentBrowserWindow`), not only on `window-all-closed`.
- **Shared MCP server:** `electron/subagents/{mcp-http-server,stdio-proxy}.ts`
  moved to `electron/mcp/`. Each server instance has its own `serverInfo`, and
  results can carry image content.
