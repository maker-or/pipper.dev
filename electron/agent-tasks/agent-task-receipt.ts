import type { AcpSessionSlice } from "../../src/lib/acp-session-reducer.ts";
import type { AgentTaskOutcome, AgentTaskStatus } from "../../contracts/agent-tasks.ts";
import type { AgentTaskRow } from "./agent-task-store.ts";

/** Longest report stored on a task row and returned in a receipt. */
export const MAX_REPORT_CHARS = 6_000;
const MAX_FILES_LISTED = 50;

/** What one settled turn left behind, read from the child's session slice. */
export interface TurnSummary {
  text: string;
  toolCalls: Record<string, number>;
}

/**
 * The last turn of a session: assistant text and tool calls after the final
 * user message. ACP text chunks are transport fragments, so they are joined
 * without separators.
 */
export function summarizeLastTurn(slice: AcpSessionSlice): TurnSummary {
  let start = 0;
  for (let i = slice.entries.length - 1; i >= 0; i--) {
    if (slice.entries[i].type === "user_text") {
      start = i + 1;
      break;
    }
  }
  let text = "";
  const toolCalls: Record<string, number> = {};
  for (const entry of slice.entries.slice(start)) {
    if (entry.type === "agent_text") text += entry.text;
    else if (entry.type === "tool_call") {
      const kind = slice.toolCalls[entry.toolCallId]?.kind ?? "other";
      toolCalls[kind] = (toolCalls[kind] ?? 0) + 1;
    }
  }
  return { text: text.trim(), toolCalls };
}

const STATUS_LINE = /^\s*STATUS:\s*(done|blocked|needs_input)\s*$/im;

/** The outcome the child declared, or "done" when it didn't say. */
export function parseOutcome(report: string): AgentTaskOutcome {
  const lines = report.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const match = STATUS_LINE.exec(lines[i]);
    if (match) return match[1].toLowerCase() as AgentTaskOutcome;
  }
  return "done";
}

export function clip(text: string, max: number): string {
  // Copy the prefix: V8 sliced strings can keep a multi-MiB report alive.
  return text.length <= max
    ? text
    : `${text
        .slice(0, max - 1)
        .split("")
        .join("")}…`;
}

/** First message a task's thread receives: the contract plus the brief. */
export function composeBrief(input: {
  parentTitle: string | null;
  task: string;
  doneWhen: string[];
  workspacePath: string;
  ownWorkspace: boolean;
}): string {
  const lines = [
    `You were started as a task by another agent in Pipper${
      input.parentTitle ? ` (from the thread "${input.parentTitle}")` : ""
    }. The user can see this thread and may reply here.`,
    `Work in ${input.workspacePath}.${
      input.ownWorkspace
        ? " This is your own worktree and branch; commit your work there when it is complete."
        : " This folder is shared with other agents; change only what the task needs."
    }`,
    "",
    "<task>",
    input.task,
    "</task>",
  ];
  if (input.doneWhen.length > 0) {
    lines.push("", "<done_when>", ...input.doneWhen.map((item) => `- ${item}`), "</done_when>");
  }
  lines.push(
    "",
    "When you stop, call wrap_up: its recap and ask go to the agent that started you. Set blocked when you need an answer to continue, and put the question in ask.",
    "Then end with a self-contained report (what you did or found, file paths, anything left open), and a last line that is exactly one of:",
    "STATUS: done",
    "STATUS: blocked",
    "STATUS: needs_input",
    "Use needs_input when you need an answer to continue; ask the question in the report.",
  );
  return lines.join("\n");
}

export interface ReceiptFacts {
  waitingForPermission: boolean;
  filesChanged: string[] | null;
  toolCalls: Record<string, number> | null;
  durationMs: number | null;
}

/** Plain-object receipt returned to the parent agent as JSON. */
export function buildReceipt(task: AgentTaskRow, facts: ReceiptFacts): Record<string, unknown> {
  const receipt: Record<string, unknown> = {
    task_id: task.id,
    thread_id: task.childThreadId,
    title: task.title,
    agent_id: task.agentId,
    status: facts.waitingForPermission ? "waiting_for_permission" : task.status,
    outcome: task.outcome,
    turns: task.turns,
    workspace: task.workspaceMode,
    workspace_path: task.workspacePath,
  };
  if (task.branch) receipt.branch = task.branch;
  if (task.stopReason) receipt.stop_reason = task.stopReason;
  if (task.error) receipt.error = task.error;
  if (facts.durationMs != null) receipt.duration_ms = facts.durationMs;
  if (facts.toolCalls && Object.keys(facts.toolCalls).length > 0) {
    receipt.tool_calls = facts.toolCalls;
  }
  if (facts.filesChanged) {
    receipt.files_changed = facts.filesChanged.slice(0, MAX_FILES_LISTED);
    if (facts.filesChanged.length > MAX_FILES_LISTED) {
      receipt.files_changed_total = facts.filesChanged.length;
    }
  }
  if (task.nextStep) {
    receipt.recap = task.nextStep.recap;
    if (task.nextStep.ask) receipt.ask = task.nextStep.ask;
    if (task.nextStep.actions.length > 0) {
      receipt.suggested_answers = task.nextStep.actions.map((action) => action.message);
    }
  }
  if (task.report) receipt.report = task.report;
  return receipt;
}

const SETTLED: ReadonlySet<AgentTaskStatus> = new Set([
  "idle",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

export function isSettled(status: AgentTaskStatus): boolean {
  return SETTLED.has(status);
}

export function isActive(status: AgentTaskStatus): boolean {
  return status === "starting" || status === "running";
}

/** One note for the parent thread covering every task that just settled. */
export function composeParentNote(tasks: AgentTaskRow[]): string {
  const lines = [
    tasks.length === 1
      ? "[Pipper] A task you started has stopped."
      : `[Pipper] ${tasks.length} tasks you started have stopped.`,
  ];
  for (const task of tasks) {
    const outcome = task.status === "idle" ? (task.outcome ?? "done") : task.status;
    const preview =
      task.nextStep?.recap ??
      (task.report ? clip(task.report.replace(/\s+/g, " "), 280) : task.error);
    lines.push(`- ${task.title} (task_id ${task.id}, ${task.agentId}): ${outcome}`);
    if (preview) lines.push(`  ${preview}`);
    if (task.nextStep?.ask) lines.push(`  Asks: ${task.nextStep.ask}`);
  }
  lines.push(
    "Call get_task for the full receipt, message_task to follow up, or carry on with your work.",
  );
  return lines.join("\n");
}
