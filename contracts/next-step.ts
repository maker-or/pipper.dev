/**
 * The next-step card: what an agent leaves at the end of a turn through the
 * `wrap_up` tool on the `pipper-agents` MCP server. The renderer draws it
 * under the agent's reply, and a task's wrap-up becomes the structured part
 * of the receipt its parent agent reads (docs/agent-tasks/design.md).
 *
 * Main validates the tool call with `parseNextStep`; the renderer reads the
 * same call's input back from the thread with it, so the two never disagree.
 */

/** A button on the card. Clicking it sends `message` as the user's reply. */
export interface NextStepAction {
  label: string;
  message: string;
}

export interface NextStep {
  /** What is true now and what is not done or verified. */
  recap: string;
  /** The one decision the user has to make, if any. */
  ask: string | null;
  /** Answers to `ask`, recommended first. Empty without an ask. */
  actions: NextStepAction[];
  /** The agent can't continue until the user answers. */
  blocked: boolean;
}

export const NEXT_STEP_LIMITS = {
  recap: 600,
  ask: 160,
  label: 32,
  message: 600,
  actions: 2,
} as const;

/**
 * A valid next step from raw tool input, or an error saying what is wrong
 * (sent back to the agent so it can call again).
 */
export function parseNextStep(
  input: unknown,
): { ok: true; value: NextStep } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "input must be an object" };
  const raw = input as Record<string, unknown>;
  const recap = typeof raw.recap === "string" ? raw.recap.trim() : "";
  if (!recap) return { ok: false, error: "recap is required" };
  if (recap.length > NEXT_STEP_LIMITS.recap) {
    return { ok: false, error: `recap must be at most ${NEXT_STEP_LIMITS.recap} characters` };
  }
  if (raw.ask != null && typeof raw.ask !== "string")
    return { ok: false, error: "ask must be a string" };
  const ask = typeof raw.ask === "string" && raw.ask.trim() ? raw.ask.trim() : null;
  if (ask && ask.length > NEXT_STEP_LIMITS.ask) {
    return { ok: false, error: `ask must be at most ${NEXT_STEP_LIMITS.ask} characters` };
  }
  if (raw.actions != null && !Array.isArray(raw.actions)) {
    return { ok: false, error: "actions must be an array" };
  }
  const actions: NextStepAction[] = [];
  for (const item of (raw.actions as unknown[] | undefined) ?? []) {
    const action = (item ?? {}) as Record<string, unknown>;
    const label = typeof action.label === "string" ? action.label.trim() : "";
    if (!label) return { ok: false, error: "every action needs a label" };
    if (label.length > NEXT_STEP_LIMITS.label) {
      return {
        ok: false,
        error: `action labels must be at most ${NEXT_STEP_LIMITS.label} characters`,
      };
    }
    const message =
      typeof action.message === "string" && action.message.trim() ? action.message.trim() : label;
    if (message.length > NEXT_STEP_LIMITS.message) {
      return {
        ok: false,
        error: `action messages must be at most ${NEXT_STEP_LIMITS.message} characters`,
      };
    }
    actions.push({ label, message });
  }
  if (actions.length > NEXT_STEP_LIMITS.actions) {
    return { ok: false, error: `at most ${NEXT_STEP_LIMITS.actions} actions` };
  }
  if (actions.length > 0 && !ask) return { ok: false, error: "actions answer an ask; add the ask" };
  if (raw.blocked != null && typeof raw.blocked !== "boolean") {
    return { ok: false, error: "blocked must be a boolean" };
  }
  const blocked = raw.blocked === true;
  if (blocked && !ask) return { ok: false, error: "blocked needs an ask saying what you need" };
  return { ok: true, value: { recap, ask, actions, blocked } };
}

/** A tool name that is the wrap_up tool, however the adapter prefixes it. */
export const WRAP_UP_TOOL_NAME = /(?:^|[^a-z])wrap_up$/i;
