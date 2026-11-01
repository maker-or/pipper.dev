# Harness differences

Pipper runs many agent harnesses over ACP (Claude Code, Codex, OpenCode,
Gemini via Antigravity, Cursor, …). They all speak the protocol, but they
differ in what they do with MCP servers, tool results and sessions. A feature
that works in one harness can silently do nothing in another. This file lists
the differences we've hit and the rules that follow. Read it before building
anything that depends on how a harness treats MCP tools, and add to it when
you find a new one.

Design principle 8 in `docs/capabilities/design.md` calls for a per-harness
profile in code. Only one entry exists so far (`sharesMcpServersPerDirectory`
in `electron/agent-tasks/tool-call-match.ts`). Until the rest exist, this file
is the record.

## Known differences

| Difference                                        | Harnesses                                                                                                            | What breaks if you assume otherwise                                                                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP tool results don't reach the transcript       | Gemini via Antigravity                                                                                               | The tool call's `outputPreview` is the model's own label ("Connect PostHog"), not the result. Anything that reads an id from the result finds nothing.             |
| MCP server `instructions` may not reach the model | Varies; don't count on any                                                                                           | Rules only in `instructions` are never seen. The agent answers from its tool list instead.                                                                         |
| MCP servers shared per directory, not per session | OpenCode                                                                                                             | Re-adding a server replaces the directory's client, closing calls in flight. Give the directory one token; match calls to sessions by the tool call each reported. |
| No HTTP MCP                                       | Harnesses that don't advertise `mcpCapabilities.http`                                                                | HTTP servers are dropped. Serve them through the stdio shim (`ensureStdioProxyScript`).                                                                            |
| Tool list read once per session                   | All (`listChanged: false`)                                                                                           | Tools added later (a new connector, a setting turned on) don't appear until the session reloads.                                                                   |
| Session load / resume                             | Varies (Antigravity advertises both)                                                                                 | `reloadThreadSession` falls back to a new session. A harness that can't load or resume loses the conversation on reload or move.                                   |
| Tool names in the transcript                      | Varies: `add_connector`, `pipper-agents_add_connector`, `mcp__pipper-agents__add_connector`, `Running add_connector` | Exact name matches miss. Match the name's end: `/(?:^\|[^a-z])tool_name$/i`.                                                                                       |

## Rules

1. **A card or link drawn from a tool call needs two ways to find its
   record.** First by an id in the result (the result's first key, so it
   survives into `outputPreview`). Then by the call's input, which every
   harness keeps: the renderer sends the thread id and the input, and main
   finds the matching record in that thread. Widgets
   (`src/lib/inline-widgets.ts`) and connector requests
   (`src/lib/connector-request-links.ts`) do both.
2. **Put the rule in the tool description, not only in server
   `instructions`.** Every harness shows the model tool descriptions.
   `instructions` are a bonus.
3. **Never assume the tool list is current.** If an agent might need to know
   about something added after its session started, give it a tool that reads
   the live state (`get_settings` for connectors), and say so in that tool's
   description.
4. **Test with the harness that's most different,** usually Antigravity and
   OpenCode, not only Claude Code.

## Known gaps

These still find their record only by the id in the result, so they don't
show in Antigravity threads:

- Thread proposal cards (`threadProposalFromToolPart` in
  `src/lib/thread-links.ts`).
- Settings-change cards (`src/lib/settings-change-links.ts`).
- Links to threads an agent started (`threadLinkFromToolPart`).
