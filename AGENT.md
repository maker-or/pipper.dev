# Pipper

This is an Electron desktop client for ACP-based coding agents.

## What this repo is

Pipper provides ACP chat, projects, threads, terminals, worktrees, diffs, and MCP integrations. The codebase is early-stage, so prefer changes that improve long-term structure, reliability, and maintainability.

## Task completion checklist

Before marking any task complete, run and fix issues from:

- `bun run doctor`
- `bun run lint`
- `bun run build`
- `bun run fmt`
- `bun run test`

## Core priorities

1. Performance first
2. Design first
3. Reliability first
4. Predictable behavior under load and during failures

When there is a tradeoff, choose correctness and robustness over short-term convenience.

## Maintainability rules

- Prefer shared logic over duplicated logic.
- If new behavior can be extracted into a reusable module, do that.
- Don’t solve a problem with ad hoc local code if a shared abstraction makes sense.
- Large refactors are acceptable when they improve the codebase long term.

## UI / design rules

- Always follow `DESIGN.md`.
- Always use the built-in UI components in the repo.
- Use `@/` imports first; they resolve to `src/` first, then shared `/@/` components.
- Use `<Elevated offset={N}>` as the outer wrapper for floating surfaces like cards, popovers, dropdowns, dialogs, tooltips, and sheets.
- Do not hardcode surface background classes for floating UI.
- Compound items must receive consecutive `index` props for correct hover/proximity behavior.
- Use only icons from `@phosphor-icons/react`.
- for any custom components that you are creating never hardcode the values and use elevated as mentioned because we have both dark and light modes

## Implementation expectations

- Preserve predictable behavior during reconnects, session restarts, and partial streams.
- Prefer small, composable components.
- Reuse existing patterns before introducing new ones.
- Keep application UI in the electron-vite renderer; there is no packaged guest application or mutable active workspace.
- When reviewing or changing complex flows, proactively audit the invariants before relying on symptoms or happy paths: list the trusted state, every reader, every writer, every transition, and every crash/restart or async boundary. Check whether stale state, partial failure, retries, or out-of-band changes can break the invariant, and ensure errors only claim what the code proves.

## core architecture

The agentic core is built on the **Agent Client Protocol (ACP)**, not pi-sdk (pi-sdk is legacy/deprecated — see `contracts/agent.ts`.

- Agents are external CLI processes speaking ACP over stdio JSON-RPC (`@agentclientprotocol/sdk`). Pipper connects to them as a client.
- `electron/agents/registry.ts` is the catalog of supported agents (Cursor, Codex, Claude Code and many more), with PATH/npx probing and spawn resolution. `electron/agents/config.json` overrides/extends the built-in catalog and sets the default agent.
- `electron/agent-connection-manager.ts` owns the actual ACP connections; `electron/agent.ts` re-exports it as `AgentManager` for backwards compatibility during the migration off the old pi-sdk-based manager.
- Renderer-side session state is derived via `src/lib/acp-session-reducer.ts`.

- Harnesses differ in what they do with MCP tools: some never forward tool results to the transcript, some ignore server `instructions`, OpenCode shares MCP servers per directory. Read `docs/harness-differences.md` before building anything that depends on MCP tool results, tool lists or sessions, and add any new difference you find.

Before making any changes to the agentic core, first understand how ACP works and how it's implemented in this app (start with `electron/agent-connection-manager.ts` and `electron/agents/registry.ts`)

Do not rewrite working code unless there is a measurable architectural benefit.

## Things to know

- If a user want to adding a new view , check whether that view is going to be like thread-specific , project-specific, or global-specific
- the example of the thread-specific view can be like a diff view (how we use 40:60 ratio 40% for the agent and other 60% for the diff or any other view that you want to add)
- the example of the project-specific view can be like a plan view
- the global view can be like a existing terminal view or something like a browser view
- When writing tests, focus on behavior and the end result, not test coverage or UI details. Test what the system achieves, not how it gets there.
- Always spend time understanding the existing implementation before making changes.
- Also make sure that whenever you create a new feature or update the existing feature, read that corresponding test file and make sure that does this test need any improvement because you have added a new feature and there would be cases where as you haven't updated the test, all the tests may fail
