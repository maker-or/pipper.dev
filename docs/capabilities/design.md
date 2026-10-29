# Capabilities

Agents get tools for what Pipper itself owns — threads, workspaces, its
settings, connectors and remote access — and nothing the harness already does.
Each of those operations is defined once and reachable from both the renderer
(IPC) and agents (MCP). What agents do shows up through UI Pipper already has:
nested threads, ACP plans and permission prompts, inline widgets and cards.

Status: steps 1 and 2 of _Migration_ are built (`electron/operations/`), and
part of step 3; the rest is proposed. Agent tasks (`docs/agent-tasks/design.md`) are the first piece; this
design extends them to the rest of Pipper's own state.

## What gets a tool

A tool belongs to Pipper only if Pipper owns the thing it acts on. Everything
else the harness already does, and a second tool for it would only add to the
agent's context.

| Pipper owns it → tool                                 | The harness already has it → no tool                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Threads: start, message, read, move, cancel, delete   | Shell, files, git, web: the harness's native tools                            |
| Workspaces: create, list, delete                      | Terminals: ACP `terminal/*`, which Pipper serves through its terminal manager |
| Settings: read and change                             | Plans and todo lists: ACP plan updates, which Pipper already draws            |
| Connectors: MCP servers now, plugins (Gmail, …) later | Asking the user: ACP permission requests, which Pipper already shows          |
| Remote access: pair a phone                           | Subagents inside one harness: the harness's own                               |
| The end-of-turn card (`wrap_up`), widgets, browser    |                                                                               |

Not exposed: window control (tabs, the diff view, file preview: an agent names
a file or thread in its reply instead), and secrets. An agent can start a
sign-in, but tokens, passwords and pairing codes stay in Pipper and never
appear in a tool result.

## Pipper sits on top of harnesses

Pipper is not a harness. Claude Code, Codex, OpenCode, Gemini and the rest
run the model loop, own the system prompt and native tools, and decide when to
call a tool. Pipper is the ACP client around them. Every decision here has to
hold for agents Pipper doesn't control.

1. **Few tools.** Every tool's name, description and schema sits in the
   agent's context for the whole session, and Pipper runs whatever model the
   user picked, down to small free ones. The set stays around sixteen tools
   (see _Tools_), with few required inputs and errors that say how to fix the
   call.
2. **Rules cover Pipper's tools only.** A `git push` or `rm -rf` from the
   harness's shell is governed by the harness's own permission mode, which
   Pipper sees as an ACP permission request like any other.
3. **Steer through descriptions and results.** Not every harness passes MCP
   `instructions` to the model, so each tool's description carries the rule
   needed to use it, and results say what to do next. Anything every agent
   must manage keeps a fallback that needs no tool, like the task `STATUS:`
   line.
4. **The tool list is fixed for a session.** Harnesses read `tools/list` once
   (`listChanged: false`). Which tools a thread sees depends only on what is
   stable for the session — agent, project, depth, settings at session start.
   Anything that changes mid-session is checked when the tool is called, with
   an error that says why.
5. **No call blocks.** Agents now run long-horizon work, and MCP timeouts
   differ per harness. No Pipper tool holds a call open waiting for another
   thread or for the user. Threads report back when they finish (see _When a
   thread finishes_); a call that needs the user's confirmation returns at
   once with `awaiting_confirmation`, and Pipper runs the operation itself
   when the user confirms and tells the agent in a note, so nothing runs
   twice.
6. **No double prompts.** A harness may ask permission before calling an MCP
   tool, and Pipper is the client that answers. Pipper allows requests for
   its own tools without asking the user, because its tiers already decide
   what needs the user, and never auto-allows anything else. How each harness
   names the server in a permission request is still to verify; when Pipper
   can't tell, it shows the request as usual.
7. **Don't duplicate the harness.** A Pipper thread started by an agent is for
   what a harness's own subagents can't do: run another harness or model, give
   the work a thread the user can see and talk to, put it in its own worktree,
   survive a restart. Tool descriptions say so.
8. **Record per-harness differences.** A per-agent profile in
   `electron/agents/` records what each harness does: HTTP or stdio MCP,
   whether MCP results reach the transcript (Gemini via Antigravity doesn't
   forward them), whether `instructions` reach the model, how permission
   requests name MCP tools, whether it can load or resume sessions. Behaviour
   that depends on these reads the profile.
9. **A thread outlives its session.** A thread can switch agent, resume or
   reconnect, and gets a new MCP token each time. Ownership and parent links
   are keyed by Pipper's thread id, never the harness session id.

## Tools

One `pipper` server, sixteen tools. The browser and widget tools are listed
only when the browser is turned on, as now.

| Tool                  | Tier          | What it does                                                            | Change from today                                                                           |
| --------------------- | ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `wrap_up`             | read          | Fills the next-step card; in a child thread, the structured report      | —                                                                                           |
| `start_subthread`     | local         | Nested thread for a piece of the caller's job; reports to the caller    | Was `start_task`; description carries agents, models and the routing guide; model validated |
| `create_thread`       | local         | Top-level thread in a new tab, for a task the user will own             | New                                                                                         |
| `message_thread`      | local         | Send any thread a message, with the sender stated by Pipper             | Was `message_task`; any thread, including a child to its parent                             |
| `get_thread`          | read          | A thread's status, last turn and `wrap_up`; a receipt for child threads | Was `get_task`; any thread                                                                  |
| `list_threads`        | read          | The caller's child threads; `scope: "project"` lists every thread       | Adds `scope`                                                                                |
| `cancel_thread`       | local         | Stop a thread's current turn                                            | Any thread, never needs approval                                                            |
| `delete_thread`       | destructive   | Delete a thread                                                         | New                                                                                         |
| `move_thread`         | local         | Move a thread to another workspace, from its next turn                  | New                                                                                         |
| `create_workspace`    | local         | New worktree and branch                                                 | —                                                                                           |
| `list_workspaces`     | read          | A project's worktrees                                                   | —                                                                                           |
| `delete_workspace`    | destructive   | Remove a worktree and its threads                                       | New                                                                                         |
| `get_settings`        | read          | Pipper's settings, connectors and remote-access state                   | New                                                                                         |
| `update_settings`     | local / grant | Change settings                                                         | New                                                                                         |
| `add_connector`       | grant         | Add an MCP server (later: a plugin) and start its sign-in               | New                                                                                         |
| `show_remote_pairing` | grant         | Show a phone-pairing card with a QR code and steps                      | New                                                                                         |

Gone: `list_agents` (see _Choosing the agent and model_) and `wait_for_tasks`
(see _When a thread finishes_).

Every tool speaks of threads: `start_task`, `list_tasks`, `cancel_task`,
`message_task` and `get_task` became `start_subthread`, `list_threads`,
`cancel_thread`, `message_thread` and `get_thread`. "Task" and "subagent"
are no longer Pipper concepts (see _Subthreads and new threads_).

## Subthreads and new threads

Pipper can start work on any harness — Claude Code, Codex, Gemini, Cursor,
Antigravity — which a harness's own subagents can't. Over ACP every thread is
started the same way: `session/new` with a working directory and Pipper's MCP
servers, `session/set_config_option` for the model, `session/prompt` with the
brief. The harness can't tell a subthread from a new thread and doesn't need
to. The difference lives entirely in Pipper's layer, as properties of the
thread.

Both start with a fresh context: the brief is all they see. What differs is
who the result is for and who owns the thread afterwards.

|                    | `start_subthread`                              | `create_thread`                                                                                 |
| ------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| For                | A piece of the caller's job                    | A task of its own, for the user                                                                 |
| `parent_thread_id` | The caller                                     | The caller, kept as an origin link only                                                         |
| Visibility         | Nested: no tab, reached from the parent        | Top level: opens a tab (in the background)                                                      |
| Owner              | The parent agent; it can delete without asking | The user                                                                                        |
| Reporting          | Completion notes and messages to the parent    | None by default; `notify_creator: true` sends one note when it first finishes                   |
| Who decides        | The agent                                      | `initiation: "user_asked"` starts it now; `"propose"` shows a card the user starts or dismisses |
| In the caller      | An inline card with live status and recap      | A line linking to the new tab                                                                   |

**When to use which** (the tools' descriptions say this): a subthread when the
result feeds what the caller is doing now; a new thread when the work stands
on its own — it ends in its own branch or PR, or the user will want to open,
steer or review it separately. `user_asked` only when the user asked for it in
words; otherwise `propose`.

**One operation underneath.**

```ts
threads.create({
  agent,
  model,
  workspace,
  brief,
  project,
  parent, // the caller's thread id
  visibility, // "nested" | "tab"
  owner, // "parent" | "user"
  reportTo, // "parent" | "none" | "first_finish"
  initiation, // "agent" | "user_asked" | "propose"
});
```

It makes the ACP calls once and writes these properties to the thread row.
The two MCP tools are presets over it, so the model chooses by name rather
than by setting flags. The user's "New thread" in the UI is the same operation
with no parent.

**Promotion.** "Open in tab" on a subthread sets its visibility to `tab` and
its owner to the user: no new session, the conversation continues. The parent
keeps its origin link but stops receiving completion notes and can no longer
delete it without asking. Typing in a subthread offers the same promotion, so
work the user takes over becomes theirs.

**Proposals.** `initiation: "propose"` creates nothing in ACP yet: the caller
gets a card ("New thread: _Fix billing tests_ · Codex · Opus — Start /
Dismiss") and the call returns at once. **Start** runs `threads.create`;
cards nobody answers expire after a week.

### Showing subthreads

Subthreads never take a tab. They are reached from their parent:

1. **An inline card in the parent's conversation**, where `start_subthread`
   was called: title, agent and model, live status (running, needs you,
   finished) and, once done, the `wrap_up` recap. It stays in the transcript,
   so the parent's history shows what it delegated and what came back.
2. **Opening a subthread stays in the parent's tab.** The panel shows the
   child with a breadcrumb (_Build auth › Pick a DB_); back returns to the
   parent. **Open in tab** promotes it (above).
3. **Attention.** When a subthread needs the user (a confirm card, or blocked
   with a question), its card in the parent turns to "Needs you" and the
   parent's tab gets a badge, so nothing waits unseen in a hidden thread.
4. **The strip above the composer** (`AgentTaskActivity` today) becomes a
   compact summary — "2 running · 1 needs you" — that scrolls to the cards.
5. **Sidebar and thread dropdown.** Subthreads nest under their parent,
   collapsed by default, with a status dot; deeper levels nest the same way.
6. **In the subthread**, the origin line (`AgentTaskOrigin` today) links back
   to the parent.

Messages between threads link both ways: the recipient's bubble links to the
sender, and the sender's `message_thread` call links to the recipient.

**Cross-project calls are allowed.** Every tool that acts on a project takes
an optional `project` (path or id) and defaults to the caller's own. The same
tiers and ownership rules apply in every project.

## When a thread finishes

There is no waiting tool. A thread an agent starts runs for as long as its work
takes — minutes or hours — and the parent learns it finished from Pipper.

- **The signal.** Every ACP turn ends with the `session/prompt` response and
  its `stopReason`. Pipper already sees it for every thread (it is what
  settles a task today, `onTurnSettled`), so no polling is involved.
- **The parent is told.** When a child thread's turn ends, Pipper queues a
  note into the parent thread: which thread, how it ended, its `wrap_up`
  recap and ask, and the `get_thread` id for the full receipt. If the parent
  is idle, the note starts a new parent turn; if it is busy, the note runs
  after its current turn. Children that finish close together share one
  note.
- **The parent never blocks.** After `start_subthread` it carries on with its own
  work or ends its turn. Its thread shows the children it is waiting on (the
  `AgentTaskActivity` chips), so the user can see why it is quiet.
- **Checking in is a read.** `get_thread` returns a running child's status and
  latest output at any time, without waiting.
- **Children are never stopped by the parent's timing.** Nothing about the
  parent's turn, its MCP call or its harness's timeout affects a child; only
  `cancel_thread`, the user, or the child's own turn budget stops it.
- **The loop guard stays.** Parent turns started by notes count toward
  `maxAutomatedTurns`; past it, notes wait until the user speaks in the
  parent.

This replaces `wait_for_tasks` and its 240 s cap.

## Messages between threads

Any thread can message any other thread with `message_thread`: a parent its
child, a child its parent, two siblings, or an agent a thread the user
started. A child that hits a question its brief doesn't answer asks its parent
directly instead of stopping or guessing.

- **Addressing.** By thread id. Every child's brief names its parent's id,
  and `get_thread` returns a thread's `parent_thread_id` and children, so an
  agent can always find who to talk to. Cross-project messages are allowed.
- **The sender is Pipper's to state.** The recipient sees the message as
  "[Message from _Pick a DB_ (Codex), thread 7f3…]" followed by the text.
  Pipper writes the header from the caller's token, so a thread can't pose as
  another thread or as the user.
- **Delivery never blocks either side.** `message_thread` returns as soon as
  the message is queued. If the recipient is idle, the message starts its next
  turn; if it is busy, it runs after the current turn (`mode: "steer"`
  interrupts the current turn instead, for "stop, the API changed").
- **Replies are messages too.** A child that asks its parent a question ends
  its turn (its `wrap_up` can say `blocked`). The parent's answer arrives as a
  message that starts the child's next turn. Nobody waits inside a tool call.
- **The user sees the conversation.** In the recipient thread the message
  shows as its own bubble, labelled with the sender and linking to it; in the
  sender thread it shows as the `message_thread` call. The user can reply in
  either thread as usual.
- **Loops are bounded.** Turns started by messages from other threads count
  toward the recipient's `maxAutomatedTurns`, like notes. Two agents can't keep
  each other running past it; the thread then waits for the user.
- **Who can message whom.** Any thread, any thread: messaging loses nothing
  and every message is visible, so it is `local` and never asks. Deleted
  threads and threads whose agent can't start return an error the sender can
  read.

## Choosing the agent and model

When an agent starts a thread, it does the whole job: it picks the agent, the
model, the workspace and the brief. The user's preferences for that choice
come from a routing guide the user writes.

**What `list_agents` returned, and why it goes.** It listed the user's enabled
agent accounts (`listAgentInstanceDescriptors`, or the raw catalog before any
accounts exist), minus unavailable ones, the mock agent and anything outside
the Agent tasks allow-list: `id`, display name and description. It gave no
models, and "available" only meant launchable — an `npx` agent counts as
available whenever `npx` exists, signed in or not. `start_subthread`'s description
already listed the same agents and constrained `agent_id` to them, and the
tool list is fixed for the session, so `list_agents` could never add anything.

**How a model is set over ACP.** `session/new` (SDK 1.4.0) takes only `cwd`,
`additionalDirectories`, `mcpServers` and `_meta`; there is no model field.
The response's `configOptions` normally include a `model` option, and the
client sets it with `session/set_config_option`. Pipper's `createThread`
already does this before the first prompt, and synthesises a model option
from its cached catalog when an agent returns none (`withModelOption`).

**`start_subthread`'s description** is built at session start from:

1. **Agents and models.** Each allowed agent with its id, name, description,
   and its models from Pipper's model catalogs (id and name), plus whether
   Pipper has seen it sign in. Agents whose catalog is unknown say so.
2. **The routing guide**, verbatim, under a heading like "The user's
   preferences for choosing an agent and model".

**The routing guide.** Plain markdown the user writes, for example:

```markdown
- Back end, APIs, data, migrations → Claude, Opus.
- UI, visual design, CSS → Gemini.
- Quick mechanical edits → the cheapest available model.
- Never use Cursor for tasks that touch billing.
```

- Stored per user (`routing.md` in userData), edited in Settings → Agent
  tasks or through `update_settings`, with an optional per-project override
  (`.pipper/routing.md` in the project, which can be committed and shared).
- It is guidance, not policy. The agent reads the task and the guide and
  chooses; Pipper never overrides the choice. Hard limits stay in settings
  (the allow-list), not in prose.
- It reaches every harness because it travels in a tool description. Harness
  skills (Claude Code skills, `AGENTS.md`) reach only their own harness, and
  routing between harnesses is Pipper's job.
- Like any description, it is read when a session starts: edits apply to new
  threads.
- Pipper's bundled skills (`skills/`, attached to prompts like Save changes)
  are written by us and fixed at build time; the routing guide is the first
  user-written one, read at runtime.

**Pipper checks the choice.**

- An unknown `model` fails the call with the valid ids for that agent.
  Today a bad id is swallowed: the seed fails with a log warning and the
  thread runs on the default model.
- An agent that fails to start (not installed, not signed in) fails
  `start_subthread` with the reason, so the caller can pick another.
- The receipt records the agent and model that actually ran, so the user can
  see whether the guide was followed.

## Settings, connectors and remote access

The user should be able to say "turn off the browser for agents", "connect my
Gmail" or "how do I use Pipper on my phone?" in any thread and have the agent
do it. These are Pipper's own state, so they get tools. What they share is
that some changes widen what agents or other devices can do, so those need
the user's yes — the `grant` tier.

### Settings

- `get_settings` returns Pipper's settings as one JSON object grouped by
  area (agent tasks, browser, workspaces, appearance, notifications, …), plus
  the connectors list and remote-access state. Secrets are never included.
- `update_settings` takes a partial object in the same shape. Each setting
  declares its tier in the settings schema:
  - **local**, applied at once: appearance, notifications, workspace
    auto-install, the routing guide, budgets that only _tighten_.
  - **grant**, confirmed by the user: anything that widens what agents can do
    — the agent-task allow-list, `startApproval`, `childPermissions`, deeper
    or larger budgets, turning the browser on for agents.
- The result says what changed and when it applies. Settings that add or
  remove tools apply to new threads (the tool list is fixed per session) and
  the result says so.
- Every change shows as a line in the thread ("Claude turned off the browser
  for agents"), with an undo link for local ones.

### Connectors

A connector is a source of new tools for agents: an MCP server today, a
plugin (Gmail, Calendar, …) later. Mid-task an agent may decide the best path
is through one the user hasn't connected; it can propose it instead of giving
up.

- `add_connector` takes `{ kind: "mcp", name, transport, command | url, … }`
  (later `kind: "plugin", id`). It is `grant`: the user sees a card in the
  thread that shows exactly what will be added — the command and arguments it
  runs, or the URL it talks to — and why the agent wants it, with **Connect**
  and **Don't connect**.
- **Sign-in happens in the card.** When the connector needs OAuth, the card's
  **Sign in** button opens the provider's page; Pipper receives and stores the
  token. The agent only learns "connected" or "not connected". Tokens never
  appear in a tool result or the transcript.
- **Saved like the user's own.** The connector is saved through the same path
  as Settings → MCP (`mcp:create` today), so it shows in settings, can be
  edited or removed there, and is available to every thread.
- **When it becomes usable.** The tool list is fixed per session, so the new
  tools reach new threads at once. For the asking thread, Pipper reloads its
  session with the new server at the end of the turn, the same way
  `move_thread` reloads at a new directory, and tells the agent: "Gmail is
  connected; its tools are available from your next turn."
- **Removing a connector** is the user's, in settings. Agents can't remove
  or edit connectors.

### Remote access

`show_remote_pairing` answers "how do I use Pipper on my phone?" with a card
in the thread:

- The card shows a fresh pairing QR code (from `remote:createPairing`), the
  steps to follow on the phone, and the devices already paired. It updates
  when the phone connects and expires with the pairing.
- **The QR code never reaches the agent.** It is a pairing secret, so Pipper
  draws it in its own card; the tool result says only "pairing card shown",
  and later "iPhone paired" or "pairing expired".
- It is `grant`: if remote access is off, the card first asks the user to
  turn it on, and showing the code is the user's act of pairing.
- Revoking a device stays with the user, in settings.

## Moving a thread to another workspace

Today a thread is pinned to the workspace it was created in:
`threads.worktree_path` is set at creation, and the session's working
directory comes from it (`resolveThreadCwd`). `worktrees:switch` changes which
workspace the user is looking at — it opens or creates a thread there — but
never moves a thread. An agent asked to "work in feature-auth" can only `cd`
in its shell, and Pipper doesn't notice: the thread row, the session, the
tab, the header, the diff view and the file tree all stay on the old
workspace, a resume puts the agent back there, and a child thread's isolation
check refuses the next prompt because the session's directory and the
thread's worktree disagree.

`move_thread` is one operation for the UI and agents that moves a thread and
everything that hangs off it.

```ts
export const moveThread = defineOperation({
  id: "threads.move", // IPC "threads:move", MCP "move_thread"
  input: z.object({
    workspace: z.string(), // path from list_workspaces or create_workspace
    thread: z.string().optional(), // default: the calling thread
  }),
  tier: "local",
  surfaces: ["ipc", "mcp"],
  // ...
});
```

**Who can move what.** An agent can move its own thread (whoever created it)
and threads it owns. Moving another thread is refused with an error; it would
change where someone else's work runs mid-conversation. The user can move any
thread from the UI. A thread can only move within its project, to a live
workspace; a project's root counts as a workspace.

**What changes, in order.**

1. **The thread row.** `threads.worktree_path` is written first and is the
   single source of truth; everything below derives from it. A thread with a
   running turn is marked `pending_move` instead, and steps 2–5 run when the
   turn settles.
2. **The session.** A session's working directory is fixed when it starts and
   can't change mid-turn, so the move applies at turn end: Pipper reloads the
   session at the new directory (`sessionLoad` / `sessionResume` already take
   a `cwd`). The conversation carries over. For a harness that can't load or
   resume sessions (its profile says so), the move needs a fresh session and
   says before moving that the history won't reach the agent; the transcript
   stays visible to the user.
3. **Child threads.** A moved child thread's workspace path updates, so its
   isolation check passes on the next prompt. The MCP endpoint is rebound to
   the new session; ownership and parent links are keyed by thread id, so
   nothing else moves.
4. **The UI.** One `threads:changed` event; the renderer re-reads the thread.
   Its tab moves to the new workspace's tab group, and the header branch, diff
   view and file tree follow. If it is the thread the user is looking at, the
   workspace selection follows too, so the user lands where the thread went.
5. **Terminals.** Open terminals stay in the old directory; new ones open in
   the new one.

**What doesn't move.** Files. Uncommitted changes the thread made stay in the
old workspace; `move_thread`'s result lists them when there are any, so the
agent can commit, stash or redo them deliberately.

**What the agent is told.** The call usually comes mid-turn, so the result
says when it takes effect: "Moved to feature-auth. From your next turn you work
in /…/feature-auth; for the rest of this turn, use paths inside it." The user
sees the same as a line in the thread.

**The silent `cd`.** An agent may still change directory in its shell without
calling the tool. ACP tool calls report the files they touch; when edits land
in another of the project's workspaces, Pipper shows a hint in the thread
offering to move it there. It never moves a thread on its own.

## How it shows up

Each thing an agent does appears through what Pipper already draws. The new
pieces are variants of existing cards.

| What happens                           | Where the user sees it                                                               | Exists today                       |
| -------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- |
| An agent starts a subthread            | An inline card in the parent; nested in the sidebar; no tab                          | Partly (`AgentTaskActivity` strip) |
| A subthread finishes or asks           | The card shows the `wrap_up` recap or "Needs you"; a note in the parent; a tab badge | Partly                             |
| An agent creates a thread              | A new background tab; a linking line in the caller                                   | New                                |
| An agent proposes a thread             | A card in the caller: Start / Dismiss                                                | New                                |
| The agent's plan                       | ACP plan updates, drawn in the panel                                                 | Yes                                |
| A turn ends                            | The next-step card (`wrap_up`)                                                       | Yes                                |
| Rich output                            | Inline widgets                                                                       | Yes                                |
| The agent runs a command               | ACP terminal output, through Pipper's terminal manager                               | Yes                                |
| A `grant` call                         | `AgentQuestionCard`, showing exactly what is granted                                 | Yes (used by `start_subthread`)    |
| A destructive call on someone else's   | `AgentQuestionCard`, destructive variant: red hold-to-confirm button                 | New variant                        |
| A connector needs sign-in              | `AgentQuestionCard` with a **Sign in** button                                        | New variant                        |
| Phone pairing                          | A pairing card: QR code, steps, paired devices                                       | New card                           |
| A setting changes                      | A line in the thread, with undo for local changes                                    | New                                |
| An agent creates a thread or workspace | Appears in the sidebar without taking focus                                          | Yes                                |
| A thread moves to another workspace    | Its tab, header, diff view and file tree follow the thread row; a line in the thread | New (`threads:changed`)            |

## Permission tiers

| Tier          | Meaning                                     | Agent call                                              |
| ------------- | ------------------------------------------- | ------------------------------------------------------- |
| `read`        | No side effects                             | Runs                                                    |
| `local`       | Changes Pipper's state; nothing lost        | Runs                                                    |
| `grant`       | Widens what agents or other devices can do  | User confirms with one click in a card                  |
| `destructive` | Loses work or state that can't be recreated | Runs on what the caller owns; otherwise hold to confirm |

The user's own clicks are never gated. A tool can raise its tier from its
input (`update_settings` is `local` or `grant` per setting). `cancel_thread` is
always `local`: stopping a turn loses nothing that can't be resumed. A child
thread's rules are its parent's, never looser; budgets (depth, concurrency)
stay in the task service.

`grant` cards have no "allow for this thread": each grant is its own decision.

## Confirming a destructive call

A destructive call on something the caller doesn't own goes through the
existing path: a permission request through `PermissionCoordinator`, shown in
the calling thread by `AgentQuestionCard`. It is marked
`kind: "destructive"`, and the card draws its destructive variant:

```
┌──────────────────────────────────────────────────────────────┐
│ Claude wants to delete workspace feature-auth                │
│                                                              │
│ This removes:                                                │
│   · 3 threads                                                │
│   · uncommitted changes in 4 files                           │
│   · 2 unpushed commits on feature-auth                       │
│                                                              │
│ [ ████████░░░░░░  Hold to delete ]   [ Don't allow ]         │
└──────────────────────────────────────────────────────────────┘
```

- **Impact** is computed by Pipper when the request is made (thread count,
  `git status`, commits not on the upstream), not taken from the agent. If
  Pipper can't check something it says so. The card itself shows only the
  title and the buttons; the impact goes back to the agent in the
  `awaiting_confirmation` result and decides whether a confirm needs a new
  hold.
- **The red button**, labelled `Hold to <verb>`: hold for **800 ms** while a
  fill sweeps across; releasing early drains it. Holding Space or Enter works
  the same; key repeat doesn't restart it. A plain click only shows "Press and
  hold to confirm". With `prefers-reduced-motion` the fill steps instead of
  animating. `Button` has no red variant today; this adds `destructive`.
- **Don't allow** is one ordinary click.
- **No "allow for this thread".** Every destructive call on someone else's
  work gets its own card. Owned resources never show one, so it stays rare.
- **After the answer** the card shows the outcome, and the agent gets the
  result as a note (the call itself returned `awaiting_confirmation`).
- **Stale cards.** The card stays answerable after the turn ends. Pipper
  recomputes the impact when the hold completes; if it grew, the card updates
  and asks for a new hold. It is withdrawn if the resource is gone or the
  thread is deleted.
- **Child threads.** A child's card shows in its own thread; the parent can't
  answer it, and the parent's note says the child is waiting for the user.

## Ownership

```
provenance(kind, resource_id, created_by_thread, created_at)
  kind: "thread" | "workspace" | "connector"
```

Rows are written when a tool creates a thread, workspace or connector; user
actions write `created_by_thread = NULL`.

1. A thread owns what it created and what its child threads created, so a
   parent can clean up after its children.
2. Destructive calls on owned resources run; on anything else they confirm.
3. An agent can't delete the thread it runs in, its parent, or a project root
   workspace, even with confirmation.
4. Deleting a workspace deletes its threads. If any aren't owned by the
   caller, the card lists them and the whole call confirms.
5. Resources older than the table have no row and count as the user's.

`agent_tasks.created_workspace` becomes a provenance row.

## One definition per operation

Thread, workspace, settings, connector and remote-access operations are
inline IPC handlers in `electron/main.ts` today (`worktrees:delete` cancels
setup, removes the worktree, closes tabs, deletes threads and broadcasts), and
the task service reimplements parts of them. Each operation moves into one
definition that both the IPC handler and the MCP tool call:

```ts
export const deleteWorkspace = defineOperation({
  id: "workspaces.delete", // IPC "workspaces:delete", MCP "delete_workspace"
  input: z.object({ path: z.string(), project: z.string().optional() }),
  tier: "destructive",
  surfaces: ["ipc", "mcp"],
  describe: async (input, ctx) => ({
    title: `Delete workspace ${basename(input.path)}`,
    verb: "delete",
    resource: { kind: "workspace", id: input.path },
    impact: await workspaceImpact(input.path, ctx),
  }),
  async run(input, ctx, services) {
    // The body that is inline in main.ts today, moved here unchanged.
  },
});
```

The caller comes from the call: `{ kind: "user" }` over IPC, or the thread
behind the MCP endpoint's per-session token, so an agent can't claim another
identity. The scope is the operations in _Tools_ plus the IPC-only handlers
next to them, not every IPC handler in Pipper.

| File                                | Role                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| `electron/operations/define.ts`     | `defineOperation`, call context, tier and ownership checks |
| `electron/operations/provenance.ts` | The `provenance` table                                     |
| `electron/operations/threads.ts`    | Thread operations                                          |
| `electron/operations/workspaces.ts` | Workspace operations, moved out of `main.ts`               |
| `electron/operations/settings.ts`   | Settings, with a tier per setting                          |
| `electron/operations/connectors.ts` | Connectors (MCP servers, later plugins) and sign-in        |
| `electron/operations/remote.ts`     | Pairing                                                    |
| `electron/agent-tasks/`             | Child threads, built on the thread operations              |
| `src/components/agent-question.tsx` | Gains the destructive and sign-in variants                 |

## Schema library

Decision: **zod 4**. One schema gives the TypeScript type, validation with
readable errors for the agent, and the MCP `inputSchema` (`z.toJSONSchema`,
built in). Effect Schema is as capable but comes with the `effect` package and
pays off when the surrounding code is written in Effect; worth revisiting only
if Pipper adopts Effect more broadly.

## Migration

1. **Built.** Add zod, `defineOperation` and provenance. Move workspace
   operations out of `main.ts`; add `delete_workspace` with the destructive
   card. The renderer keeps calling `window.omni.worktrees.*`.
   - `electron/operations/define.ts` (tiers, `callAsAgent`, `runAsUser`),
     `provenance.ts`, `workspaces.ts` (list, create, delete; the delete body
     moved from `main.ts` unchanged). `create_workspace`, `list_workspaces`
     and `start_task`'s workspaces run through them.
   - `create_workspace` is `local`, so it no longer asks even with
     `startApproval: "ask"`; that setting now covers starting tasks only.
   - The workspace tools stay behind the Agent tasks setting, as before; they
     move to the always-on list with the single `pipper` server (step 7).
   - Confirmations ride on `PermissionCoordinator` with no timeout
     (`AcpPermissionRequest.confirm`). A user's Stop or a closed session
     withdraws the card, and the agent gets a "withdrawn" note.
   - On the phone (remote permissions) the card's options show as plain
     buttons; the hold applies on the desktop only.
2. **Built.** Move thread operations; rename the task tools to thread names
   (see _Tools_) and widen `message_thread`, `get_thread`, `list_threads` and
   `cancel_thread` to any thread; add `delete_thread` and `move_thread` (with a "Move to
   workspace" action on threads in the UI, through the same operation).
   - `electron/operations/threads.ts` holds `threads.delete` and
     `threads.move`; `threads:delete` and the new `threads:move` IPC run them.
     The other thread tools stay in the task service, addressed by
     `thread_id`.
   - `start_task` is `start_subthread` already; its description is rebuilt in
     step 3, which also drops `wait_for_tasks` and `list_agents`.
   - A subthread's brief names its parent's `thread_id`. Messages carry a
     Pipper-written sender line. The loop guard exempts a parent messaging its
     own subthread, whose every turn is automated; budgets bound that instead.
   - `get_thread` reads any thread; only the parent gets a subthread's
     receipt.
   - A move lands when the thread's turn settles: the row changes, a
     `thread-updated` event refreshes the renderer's caches, the selection
     follows if the thread is on screen, and the session reopens in the new
     directory (`reloadThreadSession`; load, then resume, then a fresh
     session). The UI action is a right-click menu on thread tabs.
   - Not built yet: the warning before moving a thread whose harness can't
     load sessions (needs the per-harness profile) and the hint after a
     silent `cd`.
   - **OpenCode keeps MCP servers per directory, not per session.** Every
     session it opens re-adds the servers it's given, and re-adding one
     replaces the directory's client under that name. That closes any call in
     flight ("Connection closed") and sends every session's calls through the
     newest token. So for OpenCode, `pipper-agents` and `pipper-browser` use
     one token per connection and directory. Only the directory's first live
     session is given the servers, and each call is matched to its session by
     the tool call that session's agent reported over ACP. Browser sessions
     still keep their own pages and storage. `sharesMcpServersPerDirectory`
     in `tool-call-match.ts` is the first per-harness profile entry.
   - A lost reply makes agents retry. `create_thread` and `start_subthread`
     return the first result for the same title within one turn, rather than
     starting a second thread.
3. Rebuild the task service on `threads.create`, with `start_subthread` and
   `create_thread` as presets, promotion, proposal cards and the subthread
   UI (inline card, breadcrumb, badge, summary strip). Rename the remaining
   `subagent-*` files. Drop `wait_for_tasks`
   and `list_agents`; parents learn of finished children only through notes.
   Build `start_subthread`'s description from agents, models and the routing
   guide; validate `model`; record agent and model in the receipt.
   - **Built:** `create_thread` for `initiation: "user_asked"`. It opens a
     background tab, has no parent link, depth limit or receipt, and is
     refused in a turn another thread started. A `"new"` workspace it creates
     belongs to the user. The turn that started a thread links to it.
   - **Built:** `threads.create` in `electron/operations/threads.ts`. It
     resolves the workspace (`"new"` through `workspaces.create`, a path, or
     the root), creates the thread, and rolls back a new workspace if that
     fails. `start_subthread`, `create_thread` and the renderer's
     `threads:create` and `agent:createThread` all run it. It is narrower
     than the sketch above: what differs between the presets (the task row
     and brief, the background tab, who owns a new workspace) stays in the
     task service.
   - **Built:** `wait_for_tasks` and `list_agents` are gone. A parent hears of
     a finished subthread only through the note Pipper adds to its thread,
     and `get_thread` shows status on demand. `start_subthread`'s
     description lists the agents.
   - Still to come with this step: `"propose"` cards, the routing guide and
     `model` check, the subthread UI and the `subagent-*` renames.
     `notify_creator` waits until it proves needed.
4. Settings with per-setting tiers, `get_settings` / `update_settings`.
5. Connectors: `add_connector`, the sign-in card, session reload at turn end.
6. Remote access: `show_remote_pairing` and the pairing card.
7. Merge `pipper-browser` into `pipper`.

## Open questions

- **Guide length.** The routing guide sits in every session's context. Cap
  it (a few hundred words) and say so in the editor.
- **Plugins.** What a plugin is beyond an MCP server (bundled auth, a curated
  catalog, skills) decides `add_connector`'s `kind: "plugin"` shape.
