import { z } from "zod";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import { NEXT_STEP_LIMITS } from "../../contracts/next-step.ts";
import type { McpToolDefinition } from "../mcp/mcp-http-server.ts";
import { toolInputSchema } from "../operations/define.ts";

export const AGENT_TASK_SERVER_NAME = "pipper-agents";

export const AGENT_TASK_SERVER_INSTRUCTIONS = [
  "This client (Pipper) shows a next-step card under your reply, and lets you start other coding agents as tasks.",
  "",
  "Ending a turn:",
  "- In every turn where you changed files, ran commands or did multi-step work, call wrap_up once when the work is done, then write your closing message. Skip it for short answers and pure conversation.",
  "- Also skip it when a Pipper tool returned awaiting_confirmation this turn: the confirm card Pipper shows is the end of the turn, and a recap would only repeat it. Write one short line saying it's waiting for the user, and stop.",
  "- recap: two or three sentences on what is now true, including what is not done or not verified. It is also the thread's status, so it must make sense on its own.",
  "- ask and actions: only when the user has a decision to make or a step to take. One short question, and one or two buttons that answer it, your recommendation first. Leave the question out of your closing message; the card shows it.",
  "- blocked: true when you can't continue without the answer.",
  "",
  "Threads (when start_subthread is listed). Every thread is one the user can see and talk to; address them by thread_id.",
  '- Pick the tool by who the work is for. The user asks for a new, separate or another thread ("start a thread for X", "open a thread that does Y"): create_thread, never start_subthread. You hand off part of your own job and need the result back: start_subthread.',
  "- start_subthread runs another agent on a piece of your job in a thread nested under yours, and returns at once. Keep working, or end your turn: when a subthread stops, Pipper adds a note to your thread with its receipt, after your current turn if one is running. Don't poll; get_thread shows a subthread's status if you need it sooner.",
  "- A subthread shares none of your context. Its brief must say everything: goal, relevant paths, constraints, and what you expect back. Use done_when for checks that define success.",
  '- workspace: "shared" (default) works in your folder; use it for reading, research and small edits. Use "new" when subthreads change files in parallel, so each gets its own worktree and branch.',
  "- A receipt's report comes from the subthread; files_changed and tool_calls come from Pipper. Check the facts before relying on the report.",
  "- create_thread starts a top-level thread the user owns, in its own tab. It isn't nested, has no depth limit and doesn't report back, so don't wait for it; tell the user it started.",
  "- message_thread talks to any thread: a subthread you started, the thread that started you, or another thread in list_threads. Pipper states who sent it. It never waits for a reply; the reply arrives as a message.",
  "- move_thread moves your own thread (or one you started) to another workspace from its next turn.",
  "- Don't start a subthread for something you can do in a few tool calls yourself.",
].join("\n");

export const WRAP_UP_TOOL: McpToolDefinition = {
  name: "wrap_up",
  description:
    "End a turn that did work: fills the next-step card Pipper draws under your reply. Call it " +
    "once, when the turn's work is done, then write your closing message. In a task thread, the " +
    "recap and ask also go to the agent that started the task. Don't call it in a turn where a " +
    "Pipper tool returned awaiting_confirmation: the confirm card already ends that turn.",
  inputSchema: {
    type: "object",
    properties: {
      recap: {
        type: "string",
        maxLength: NEXT_STEP_LIMITS.recap,
        description:
          "Two or three short sentences: what is now true or changed, then what is not done or " +
          "not verified. Must stand on its own; never point at the rest of the conversation.",
      },
      ask: {
        type: "string",
        maxLength: NEXT_STEP_LIMITS.ask,
        description:
          "Only when the user must decide or act: the one decision, as a short question, with no " +
          "reason or recommendation and without listing the options the buttons give.",
      },
      actions: {
        type: "array",
        maxItems: NEXT_STEP_LIMITS.actions,
        description:
          "Buttons that answer ask, your recommendation first. A click sends message as the " +
          "user's reply.",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              maxLength: NEXT_STEP_LIMITS.label,
              description: "Button text, one to three words.",
            },
            message: {
              type: "string",
              maxLength: NEXT_STEP_LIMITS.message,
              description: "What the click sends, in the user's voice. Defaults to the label.",
            },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
      blocked: {
        type: "boolean",
        description: "True when you can't continue until the user answers ask.",
      },
    },
    required: ["recap"],
    additionalProperties: false,
  },
};

export function agentTaskToolDefinitions(agents: AcpAgentDescriptor[]): McpToolDefinition[] {
  const catalog = agents
    .map((a) => `- ${a.id} (${a.displayName})${a.description ? `: ${a.description}` : ""}`)
    .join("\n");
  return [
    {
      name: "start_subthread",
      description:
        "Start another coding agent on a piece of your job in a new thread nested under yours. " +
        "Returns immediately with thread_id; the subthread runs in the background. When it " +
        "stops, Pipper sends your thread a note with its receipt. Not for when the user asks " +
        "for a new or separate thread: that's create_thread.\n\nAvailable agents:\n" +
        catalog,
      inputSchema: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "Which agent runs the subthread.",
            enum: agents.map((a) => a.id),
          },
          title: {
            type: "string",
            description: "Short thread title, under 60 characters.",
          },
          task: {
            type: "string",
            description: "Complete, self-contained brief. The subthread sees nothing else.",
          },
          done_when: {
            type: "array",
            items: { type: "string" },
            description: "Optional checks that define done, e.g. 'bun run test passes'.",
          },
          workspace: {
            type: "string",
            description:
              '"shared" (default): your own folder. "new": a fresh worktree and branch. ' +
              "Or an absolute path from list_workspaces or create_workspace.",
          },
          install_dependencies: {
            type: "boolean",
            description: 'With workspace "new": install packages first. Default false.',
          },
          model: {
            type: "string",
            description: "Optional model id inside the agent.",
          },
          request_key: {
            type: "string",
            description:
              "Optional idempotency key. Retrying with the same key returns the same subthread.",
          },
        },
        required: ["agent_id", "title", "task"],
        additionalProperties: false,
      },
    },
    {
      name: "create_thread",
      description:
        "Start a new top-level thread for the user: its own tab (opened in the background), " +
        "owned by the user, not nested under yours and not reporting back to you. Use it only " +
        "when the user asked you, in words, for a separate thread, or for work that stands on " +
        "its own (its own branch or PR, something they'll open and steer themselves). For a " +
        "piece of your own job, use start_subthread. The thread sees only your brief. Returns " +
        "at once.\n\nAvailable agents:\n" +
        catalog,
      inputSchema: toolInputSchema(CREATE_THREAD_INPUT),
    },
    {
      name: "get_thread",
      description:
        "Any thread's status, last turn and wrap_up, with its parent and children. For a " +
        "subthread you started, the receipt: outcome, report and the facts Pipper saw. Never waits.",
      inputSchema: toolInputSchema(GET_THREAD_INPUT),
    },
    {
      name: "list_threads",
      description:
        'Your subthreads, newest first, with status and outcome. scope "project" lists every ' +
        "thread in the project instead.",
      inputSchema: toolInputSchema(LIST_THREADS_INPUT),
    },
    {
      name: "message_thread",
      description:
        "Send any thread a message; Pipper states that it came from your thread. follow_up " +
        "(default) runs after its current turn, or now if it is idle; steer interrupts the " +
        "current turn. Returns at once; a reply arrives as a message to your thread.",
      inputSchema: toolInputSchema(MESSAGE_THREAD_INPUT),
    },
    {
      name: "cancel_thread",
      description:
        "Stop another thread's current turn. Its conversation stays; a message starts it again.",
      inputSchema: toolInputSchema(THREAD_ID_INPUT),
    },
    {
      name: "delete_thread",
      description:
        "Delete a thread and its conversation. Runs at once for a subthread you (or your " +
        "subthreads) started. Otherwise it returns awaiting_confirmation: Pipper shows the user " +
        "a confirm card, deletes it if they confirm, and you get the outcome as a note. That " +
        "card ends your turn: don't call wrap_up, don't ask about it, and don't call this again " +
        "for the same thread while it waits. You can't delete your own thread or the thread " +
        "that started you.",
      inputSchema: toolInputSchema(THREAD_ID_INPUT),
    },
    {
      name: "move_thread",
      description:
        "Move a thread to another workspace of its project: your own thread (the default) or " +
        "a subthread you started. It takes effect from the thread's next turn, since a running " +
        "turn can't change directory; files stay where they are, and the result lists " +
        "uncommitted changes left behind.",
      inputSchema: toolInputSchema(MOVE_THREAD_INPUT),
    },
    {
      name: "create_workspace",
      description:
        "Create a new worktree and branch in your project. Returns its path for " +
        "start_subthread's workspace, so several subthreads can share it.",
      inputSchema: toolInputSchema(CREATE_WORKSPACE_INPUT),
    },
    {
      name: "list_workspaces",
      description: "List your project's worktrees with path and branch.",
      inputSchema: toolInputSchema(LIST_WORKSPACES_INPUT),
    },
    {
      name: "delete_workspace",
      description:
        "Delete a worktree, its branch if Pipper created it, and every thread in it. Runs at once " +
        "when you or your tasks created the workspace and its threads. Otherwise it returns " +
        "awaiting_confirmation: Pipper shows the user a confirm card, deletes it if they " +
        "confirm, and you get the outcome as a note. That card ends your turn: don't call " +
        "wrap_up, don't ask about it, and don't call this again for the same workspace while it " +
        "waits; say in one line that it's waiting for the user. You can't delete the project " +
        "root or the workspace your own thread runs in.",
      inputSchema: toolInputSchema(DELETE_WORKSPACE_INPUT),
    },
  ];
}

const PROJECT_INPUT = z
  .string()
  .min(1)
  .optional()
  .describe("Project id or absolute path. Default: your thread's project.");

export const LIST_WORKSPACES_INPUT = z.strictObject({ project: PROJECT_INPUT });

export const CREATE_WORKSPACE_INPUT = z.strictObject({
  name: z.string().trim().min(1).describe("Short name; letters, digits and dashes."),
  install_dependencies: z.boolean().optional().describe("Default false."),
  project: PROJECT_INPUT,
});

const THREAD_ID = z.string().min(1).describe("A thread_id from list_threads or get_thread.");

export const CREATE_THREAD_INPUT = z.strictObject({
  agent_id: z.string().min(1).describe("Which agent runs the thread."),
  title: z.string().trim().min(1).describe("Short thread title, under 60 characters."),
  task: z
    .string()
    .trim()
    .min(1)
    .describe("Complete, self-contained brief. The new thread sees nothing else."),
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe(
      '"shared" (default): your folder. "new": a fresh worktree and branch. Or an absolute ' +
        "path from list_workspaces.",
    ),
  install_dependencies: z.boolean().optional().describe('With workspace "new". Default false.'),
  model: z.string().min(1).optional().describe("Optional model id inside the agent."),
});

export const THREAD_ID_INPUT = z.strictObject({ thread_id: THREAD_ID });

export const GET_THREAD_INPUT = THREAD_ID_INPUT;

export const LIST_THREADS_INPUT = z.strictObject({
  scope: z
    .enum(["subthreads", "project"])
    .optional()
    .describe('"subthreads" (default): the threads you started. "project": every thread.'),
  project: PROJECT_INPUT,
});

export const MESSAGE_THREAD_INPUT = z.strictObject({
  thread_id: THREAD_ID,
  message: z.string().trim().min(1),
  mode: z.enum(["follow_up", "steer"]).optional(),
});

export const MOVE_THREAD_INPUT = z.strictObject({
  workspace: z
    .string()
    .min(1)
    .describe("A workspace path from list_workspaces; the project's root path for main."),
  thread_id: THREAD_ID.optional().describe("Default: your own thread."),
});

export const DELETE_WORKSPACE_INPUT = z.strictObject({
  path: z.string().min(1).describe("The workspace's path, from list_workspaces."),
  project: PROJECT_INPUT,
});

export class ToolInputError extends Error {}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${key} is required and must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (value == null) return null;
  if (typeof value !== "string") throw new ToolInputError(`${key} must be a string`);
  return value.trim() || null;
}

export function optionalStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolInputError(`${key} must be an array of strings`);
  }
  return (value as string[]).map((item) => item.trim()).filter(Boolean);
}
