import { z } from "zod";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import { NEXT_STEP_LIMITS } from "../../contracts/next-step.ts";
import type { McpToolDefinition } from "../mcp/mcp-http-server.ts";
import { toolInputSchema } from "../operations/define.ts";

export const AGENT_TASK_SERVER_NAME = "pipper-agents";

/** Longest a single wait_for_tasks call blocks; under common MCP client limits. */
export const MAX_WAIT_SECONDS = 240;
export const DEFAULT_WAIT_SECONDS = 120;

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
  "Tasks (when start_task is listed). Each task is a real thread the user can see, nested under yours.",
  "- start_task returns at once. Keep working, then call wait_for_tasks to collect receipts. If you finish your turn instead, Pipper adds a short note to your thread when a task stops.",
  "- A task shares none of your context. Its brief must say everything: goal, relevant paths, constraints, and what you expect back. Use done_when for checks that define success.",
  '- workspace: "shared" (default) works in your folder; use it for reading, research and small edits. Use "new" when tasks change files in parallel, so each gets its own worktree and branch.',
  "- A receipt's report comes from the task; files_changed and tool_calls come from Pipper. Check the facts before relying on the report.",
  "- An idle task is a conversation: message_task asks a follow-up or answers its question (outcome needs_input).",
  "- Don't start a task for something you can do in a few tool calls yourself.",
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
  const taskId = { type: "string", description: "A task_id from start_task or list_tasks." };
  return [
    {
      name: "list_agents",
      description: "List the coding agents you may start as tasks, with ids and descriptions.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "start_task",
      description:
        "Start another coding agent on a task in a new thread nested under yours. Returns " +
        "immediately with task_id and thread_id; the task runs in the background. Collect the " +
        "result with wait_for_tasks or get_task.\n\nAvailable agents:\n" +
        catalog,
      inputSchema: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "Which agent runs the task.",
            enum: agents.map((a) => a.id),
          },
          title: { type: "string", description: "Short thread title, under 60 characters." },
          task: {
            type: "string",
            description: "Complete, self-contained brief. The task sees nothing else.",
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
          model: { type: "string", description: "Optional model id inside the agent." },
          request_key: {
            type: "string",
            description:
              "Optional idempotency key. Retrying with the same key returns the same task.",
          },
        },
        required: ["agent_id", "title", "task"],
        additionalProperties: false,
      },
    },
    {
      name: "wait_for_tasks",
      description:
        `Block until tasks stop (up to ${MAX_WAIT_SECONDS} s) and return their receipts. ` +
        "Without task_ids, waits on every running task you started. If it times out, the tasks " +
        "keep running; call it again.",
      inputSchema: {
        type: "object",
        properties: {
          task_ids: { type: "array", items: { type: "string" } },
          until: {
            type: "string",
            enum: ["all", "any"],
            description: "Return when all (default) or any of the tasks stop.",
          },
          timeout_seconds: {
            type: "number",
            description: `Default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}.`,
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_task",
      description: "Return one task's receipt: status, outcome, report and the facts Pipper saw.",
      inputSchema: {
        type: "object",
        properties: { task_id: taskId },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "list_tasks",
      description: "List the tasks you started, newest first, with status and outcome.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "message_task",
      description:
        "Send a task a message. follow_up (default) runs after its current turn, or now if it " +
        "is idle; steer interrupts the current turn. Returns at once.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: taskId,
          message: { type: "string" },
          mode: { type: "string", enum: ["follow_up", "steer"] },
        },
        required: ["task_id", "message"],
        additionalProperties: false,
      },
    },
    {
      name: "cancel_task",
      description: "Stop a task's current turn. Its thread stays for the user to read.",
      inputSchema: {
        type: "object",
        properties: { task_id: taskId },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "create_workspace",
      description:
        "Create a new worktree and branch in your project. Returns its path for start_task's " +
        "workspace, so several tasks can share it.",
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
