# Agent tasks

A client-hosted MCP server (`pipper-agents`) that lets any ACP agent start
other agents as **tasks**: real Pipper threads, nested under the thread that
started them, optionally in their own worktree. It replaces the old
`pipper-subagents` server (`spawn_subagent`).

Status: implemented in `electron/agent-tasks/`.

## First principles

| #   | Principle                                  | What it rules out                                                       |
| --- | ------------------------------------------ | ----------------------------------------------------------------------- |
| A   | A task is a durable thread, not a function | Hidden, in-memory runs whose transcript is thrown away                  |
| B   | Asynchronous by default                    | One `tools/call` held open for minutes, retry-attachment workarounds    |
| C   | The parent chooses where a task works      | Parallel writers silently sharing one folder without anyone choosing it |
| D   | Contract in, receipt out                   | Trusting the model's own summary for facts Pipper can compute           |
| E   | Permissions follow a policy                | Auto-approving whatever option the agent listed first                   |
| F   | Pipper enforces budgets                    | Unbounded fan-out, runaway parent/child loops                           |
| G   | Tasks are conversations                    | One-shot runs that can't be followed up or ask a question               |
| H   | State survives restarts                    | Losing every running task when Pipper quits                             |

The old design's assumptions were the opposite of each row: a blocking call,
an in-memory run with a 300-character preview, auto-approved permissions, one
shot, a shared folder and free-text results.

## Where it lives

| File                                         | Role                                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| `electron/agent-tasks/agent-task-store.ts`   | SQLite schema and queries for `agent_tasks`                 |
| `electron/agent-tasks/agent-task-config.ts`  | `agent-tasks.json` settings, sanitized                      |
| `electron/agent-tasks/agent-task-tools.ts`   | MCP tool definitions, server instructions, argument parsing |
| `electron/agent-tasks/agent-task-service.ts` | Endpoints, tool handling, approvals, policy, budgets, notes |
| `electron/agent-tasks/agent-task-receipt.ts` | Report extraction and receipt formatting                    |

`AgentConnectionManager` implements the service's small `AgentTaskHost`
delegate (create thread, send prompt, cancel, read the last turn, ask for
approval), so the service never imports the manager and tests drive it with
a fake host.

The MCP transport is the shared `electron/mcp/mcp-http-server.ts` on
`127.0.0.1:0` with a per-session token, plus the stdio shim for agents
without HTTP MCP.

## Tools

| Tool               | Does                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `list_agents`      | Agents the user allows as tasks: id, name, description                 |
| `start_task`       | Creates a child thread, sends the brief, returns at once with ids      |
| `wait_for_tasks`   | Blocks up to 240 s until any/all listed tasks settle; returns receipts |
| `get_task`         | One task's receipt, live status included                               |
| `list_tasks`       | Every task this thread started, newest first                           |
| `message_task`     | Follow-up (queued after the current turn) or steer (interrupts it)     |
| `cancel_task`      | Stops the task's current turn; the thread stays for the user           |
| `create_workspace` | New worktree and branch in the caller's project                        |
| `list_workspaces`  | The project's worktrees, for `start_task`'s `workspace` path           |

`start_task.workspace` is `"shared"` (default: the caller's own folder),
`"new"` (a fresh worktree, source-only unless `install_dependencies`), or an
absolute path to one of the project's worktrees.

`request_key` makes `start_task` idempotent per parent thread: a retried call
with the same key returns the first call's task instead of starting another.

## Lifecycle

```
start_task ─► approval? ─► workspace ─► child thread ─► brief sent ─► running
                                                                      │
          message_task ◄──── idle (receipt ready) ◄── turn settles ◄──┘
```

Status is one of `starting`, `running`, `idle`, `failed`, `cancelled`,
`timed_out`, `interrupted`. A task is `idle` after any turn settles; its
receipt carries the child's declared outcome (`done`, `blocked`,
`needs_input`) from the final `STATUS:` line the brief asks for, `done` when
the line is missing. `message_task` on an idle, interrupted or timed-out task
starts another turn.

## Receipts

Computed by Pipper, not taken from the model:

- `report`: the last turn's assistant text, at most 6,000 characters
- `outcome`: from the turn's `wrap_up` (`blocked` → `needs_input`, else
  `done`), falling back to the parsed `STATUS:` line
- `recap`, `ask`, `suggested_answers`: the turn's `wrap_up`, when it called one
- `files_changed`: for tasks in their own worktree, `git status --porcelain`
  plus commits since the start commit (`start_sha`)
- `tool_calls`: count by ACP tool kind for the last turn
- `turns`, `duration_ms`, `workspace_path`, `branch`, `stop_reason`, `error`

## Wrap-up and the next-step card

`wrap_up` is on the `pipper-agents` server for every thread, even with agent
tasks turned off (then it is the only tool listed). An agent calls it once at
the end of a turn that did work, with a `recap`, and an `ask` plus one or two
`actions` when the user has a decision to make; `blocked` says it can't go on
without the answer. Main validates the input (`contracts/next-step.ts`) and
rejects what the card can't show, so the agent can call again.

- The renderer reads the turn's last completed `wrap_up` call input back from
  the thread and draws a native card under the reply. A button sends its
  message as the user's reply; only the latest turn's card can be answered.
- In a task thread the same call is the structured half of the receipt, the
  recap leads the parent note and the task chip, and `ask` is shown as
  `Asks:`. A later turn without `wrap_up` clears it.

## Reporting back

When a child's turn settles:

1. A `wait_for_tasks` call covering it resolves with the receipt.
2. Otherwise, if `notifyParent` is on, a short note is queued into the parent
   thread as a follow-up prompt. Notes for children that settle within 1.5 s
   are batched into one prompt.

Loop guard: Pipper counts consecutive parent turns started by notes. Once it
reaches `maxAutomatedTurns` (default 5), notes stop until the user sends the
parent a message; the tasks stay listed with their receipts.

## Approvals and permissions

- **Starting work** (`start_task`, `create_workspace`): with `startApproval:
"ask"` (default) the user approves in the parent thread through
  `PermissionCoordinator`: once, always for this thread, or deny. With
  `"allow"` no prompt is shown, except during a turn that a note started:
  automated turns always ask, so chains can't grow on their own.
- **Child permissions**: children are visible threads, so their requests show
  in their own thread like any other. With `childPermissions: "workspace"`
  (default), read, search, think and edit requests whose locations are all
  inside the child's workspace are allowed once; everything else (execute,
  delete, move, fetch, paths outside, unknown) asks the user. With `"ask"`
  every request asks. Pipper never falls back to the first listed option.

## Budgets

| Limit                           | Default | Range     |
| ------------------------------- | ------- | --------- |
| Running tasks per parent        | 4       | 1–8       |
| Running tasks across the app    | 8       | 1–16      |
| Depth (user thread is 0)        | 1       | 1–3       |
| Turn timeout per task           | 30 min  | 1–120 min |
| Automated parent turns in a row | 5       | 1–20      |

A limit returns an error naming it and what to do, never a silent queue.

## Restart and failure

- Rows in `starting` or `running` when Pipper starts become `interrupted`.
  The child thread is an ordinary thread, so `message_task` (or the user)
  resumes it through the normal session load path.
- A failed workspace or thread creation rolls back only what that call made.
- Deleting a parent thread cancels its running children and keeps their
  threads; deleting a child thread marks its task `cancelled`.

## Not built

- Token budgets: ACP's `usage` reports context-window use, not cumulative
  spend, so there is nothing reliable to cap on yet.
- Forking a parent's conversation into a child: ACP has no cross-agent fork.
  The brief is the only context a child gets.
