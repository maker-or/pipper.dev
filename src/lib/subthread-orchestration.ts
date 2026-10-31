import type { AcpAgentDescriptor } from "../../contracts/acp.ts";

/**
 * Client-side `/subagent` composer logic: the draft the morphed composer
 * edits, its validation, and the single orchestration prompt composed for
 * the orchestrator thread on submit. The orchestrator starts each subthread
 * as a task thread through the client-hosted `pipper-agents` MCP tools
 * (docs/agent-tasks/design.md); nothing here talks to subthreads directly.
 */

export const SUBAGENT_COMMAND = "subagent";

export interface SubthreadAssignment {
  /** Stable row key for the composer UI. */
  id: string;
  agentId: string;
  task: string;
}

export interface OrchestrationDraft {
  /** auto: the orchestrator splits the goal; spawn count is capped by maxConcurrent. */
  mode: "auto" | "manual";
  /** The overall goal (required in auto mode, optional in manual). */
  goal: string;
  assignments: SubthreadAssignment[];
}

let assignmentCounter = 0;

export function newAssignment(agentId = ""): SubthreadAssignment {
  assignmentCounter += 1;
  return { id: `assignment-${assignmentCounter}`, agentId, task: "" };
}

export function emptyOrchestrationDraft(): OrchestrationDraft {
  return { mode: "auto", goal: "", assignments: [newAssignment()] };
}

/** True when the composer input is the /subagent trigger (with or without a remainder). */
export function isSubagentTrigger(input: string): boolean {
  const [token] = input.trim().split(/\s+/);
  return token === `/${SUBAGENT_COMMAND}`;
}

/** Human-readable reason the draft can't be submitted yet, or null when valid. */
export function validateOrchestrationDraft(draft: OrchestrationDraft): string | null {
  if (draft.mode === "auto") {
    if (!draft.goal.trim()) return "Describe the goal so the orchestrator can split the work.";
    return null;
  }
  const filled = draft.assignments.filter((a) => a.task.trim());
  if (filled.length === 0) return "Add at least one subthread task.";
  const missingAgent = filled.find((a) => !a.agentId);
  if (missingAgent) return "Pick an agent for every task.";
  return null;
}

function agentLabel(
  agentId: string,
  agents: ReadonlyArray<Pick<AcpAgentDescriptor, "id" | "displayName">>,
): string {
  const match = agents.find((agent) => agent.id === agentId);
  return match ? `${match.displayName} (agent_id: ${match.id})` : `agent_id: ${agentId}`;
}

const ORCHESTRATOR_PREAMBLE =
  "You are acting as an orchestrator. The pipper-agents MCP server lets you start other " +
  "coding agents in subthreads: `start_subthread` opens a thread for one agent and returns at once, " +
  "and its description lists the agents available. When a subthread stops, Pipper adds a note " +
  "to your thread with its receipt, so start them all, then end your turn and pick up from the notes. " +
  "Subthreads share none of your context, so every brief must be fully self-contained: " +
  "include the background, relevant file paths, constraints, and the exact output you " +
  'expect back. Give tasks that change files in parallel `workspace: "new"` so each gets ' +
  "its own worktree.";

/**
 * Compose the single prompt sent to the orchestrator thread. Pure so the
 * exact delegation contract stays testable without any UI.
 */
export function composeOrchestrationPrompt(
  draft: OrchestrationDraft,
  agents: ReadonlyArray<Pick<AcpAgentDescriptor, "id" | "displayName">>,
  maxConcurrent?: number,
): string {
  const goal = draft.goal.trim();
  const parallelCap =
    typeof maxConcurrent === "number" && Number.isFinite(maxConcurrent)
      ? Math.max(1, Math.min(8, Math.round(maxConcurrent)))
      : null;

  if (draft.mode === "auto") {
    const split =
      parallelCap != null
        ? `Decide how to split the goal below into at most ${parallelCap} subthread task${parallelCap === 1 ? "" : "s"}: ` +
          `start up to ${parallelCap} subthread${parallelCap === 1 ? "" : "s"} ` +
          `(running independent tasks in parallel). Do not start more than ${parallelCap}. `
        : "Decide how to split the goal below into subthread tasks: start as many subthreads as " +
          "genuinely help (running independent tasks in parallel), ";
    return [
      ORCHESTRATOR_PREAMBLE,
      split +
        "pick whichever available agent fits each task, then verify their reports against " +
        "each other and synthesize one final answer. Do the work yourself only where " +
        "delegation adds nothing.",
      `<goal>\n${goal}\n</goal>`,
    ].join("\n\n");
  }

  const filled = draft.assignments.filter((a) => a.task.trim());
  const taskList = filled
    .map((a, index) => `${index + 1}. ${agentLabel(a.agentId, agents)} — ${a.task.trim()}`)
    .join("\n");

  return [
    ORCHESTRATOR_PREAMBLE,
    "The user assigned the following subthreads. Start each with start_subthread, using the " +
      "listed agent_id, and run independent tasks in parallel. Enrich each brief with any " +
      "context the subthread will need before delegating it.",
    `<assignments>\n${taskList}\n</assignments>`,
    goal ? `<goal>\n${goal}\n</goal>` : null,
    "When every receipt has arrived in a note, verify the results against the facts in each " +
      "receipt, resolve any conflicts between them, and synthesize a single final answer for " +
      "the user.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
