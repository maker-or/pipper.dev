import { describe, expect, test } from "vitest";
import {
  composeOrchestrationPrompt,
  emptyOrchestrationDraft,
  isSubagentTrigger,
  newAssignment,
  validateOrchestrationDraft,
} from "./subthread-orchestration.ts";

const AGENTS = [
  { id: "claude-agent-acp", displayName: "Claude" },
  { id: "codex-acp", displayName: "Codex" },
];

describe("/subagent trigger", () => {
  test("matches the bare command and command-with-text, not lookalikes", () => {
    expect(isSubagentTrigger("/subagent")).toBe(true);
    expect(isSubagentTrigger("  /subagent build the thing")).toBe(true);
    expect(isSubagentTrigger("/subagents")).toBe(false);
    expect(isSubagentTrigger("tell me about /subagent")).toBe(false);
    expect(isSubagentTrigger("")).toBe(false);
  });
});

describe("draft validation", () => {
  test("auto mode requires a goal", () => {
    const draft = emptyOrchestrationDraft();
    expect(validateOrchestrationDraft(draft)).toMatch(/goal/i);
    draft.goal = "Ship the feature";
    expect(validateOrchestrationDraft(draft)).toBeNull();
  });

  test("manual mode requires at least one task with an agent picked", () => {
    const draft = emptyOrchestrationDraft();
    draft.mode = "manual";
    expect(validateOrchestrationDraft(draft)).toMatch(/task/i);

    draft.assignments = [{ ...newAssignment(), task: "audit the auth flow" }];
    expect(validateOrchestrationDraft(draft)).toMatch(/agent/i);

    draft.assignments = [{ ...newAssignment("codex-acp"), task: "audit the auth flow" }];
    expect(validateOrchestrationDraft(draft)).toBeNull();
  });

  test("manual mode ignores empty leftover rows", () => {
    const draft = emptyOrchestrationDraft();
    draft.mode = "manual";
    draft.assignments = [
      { ...newAssignment("codex-acp"), task: "do the thing" },
      newAssignment(), // untouched extra row
    ];
    expect(validateOrchestrationDraft(draft)).toBeNull();
  });
});

describe("orchestration prompt", () => {
  test("auto mode tells the orchestrator to fan out via start_subthread around the goal", () => {
    const draft = emptyOrchestrationDraft();
    draft.goal = "Migrate the settings page to the new design system";
    const prompt = composeOrchestrationPrompt(draft, AGENTS, 4);

    expect(prompt).toContain("start_subthread");
    // Receipts arrive as notes; there is no tool to wait on.
    expect(prompt).toContain("end your turn and pick up from the notes");
    expect(prompt).not.toContain("wait_for_tasks");
    expect(prompt).toContain("Migrate the settings page to the new design system");
    // The user's parallel pick is a hard cap on how many auto-mode starts.
    expect(prompt).toMatch(/at most 4/);
    expect(prompt).toMatch(/up to 4/);
    expect(prompt).toMatch(/Do not start more than 4/);
    // The orchestrator decides the split — no fabricated assignments.
    expect(prompt).not.toContain("<assignments>");
    // Subthreads share no context: the prompt must say tasks are self-contained.
    expect(prompt).toMatch(/self-contained/i);
    expect(prompt).toMatch(/parallel/i);
  });

  test("manual mode enumerates every filled assignment with its exact agent_id", () => {
    const draft = emptyOrchestrationDraft();
    draft.mode = "manual";
    draft.goal = "Fix login end to end";
    draft.assignments = [
      { ...newAssignment("codex-acp"), task: "Fix the backend session bug" },
      { ...newAssignment("claude-agent-acp"), task: "Update the login form UI" },
      newAssignment(), // empty row must not leak into the prompt
    ];
    const prompt = composeOrchestrationPrompt(draft, AGENTS);

    expect(prompt).toContain("1. Codex (agent_id: codex-acp) — Fix the backend session bug");
    expect(prompt).toContain("2. Claude (agent_id: claude-agent-acp) — Update the login form UI");
    expect(prompt).toContain("<goal>\nFix login end to end\n</goal>");
    expect(prompt).toMatch(/parallel/i);
    expect(prompt).toMatch(/synthesize/i);
    expect(prompt).not.toMatch(/3\./);
  });

  test("manual mode without a goal omits the goal block entirely", () => {
    const draft = emptyOrchestrationDraft();
    draft.mode = "manual";
    draft.assignments = [{ ...newAssignment("codex-acp"), task: "run the tests" }];
    const prompt = composeOrchestrationPrompt(draft, AGENTS);
    expect(prompt).not.toContain("<goal>");
  });

  test("unknown agent ids still render an explicit agent_id for the tool call", () => {
    const draft = emptyOrchestrationDraft();
    draft.mode = "manual";
    draft.assignments = [{ ...newAssignment("gemini-acp"), task: "profile startup" }];
    const prompt = composeOrchestrationPrompt(draft, AGENTS);
    expect(prompt).toContain("agent_id: gemini-acp");
  });
});
