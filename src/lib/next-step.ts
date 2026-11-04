import { WRAP_UP_TOOL_NAME, parseNextStep, type NextStep } from "../../contracts/next-step.ts";

/**
 * The next-step card for an assistant turn: the input of its last completed
 * `wrap_up` call. Read from the call's input rather than its result, since
 * some adapters (Gemini via Antigravity) never forward MCP results. A call
 * main rejected fails, so its input never reaches the card.
 */
export function nextStepFromParts(parts: unknown[]): NextStep | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] as
      | { type?: unknown; name?: unknown; status?: unknown; args?: unknown }
      | null
      | undefined;
    if (!part || part.type !== "toolCall" || part.status !== "completed") continue;
    if (typeof part.name !== "string" || !WRAP_UP_TOOL_NAME.test(part.name.trim())) continue;
    const step = wrapUpInput(part.args);
    if (step) return step;
  }
  return null;
}

/** The call's input, flat or nested under `arguments`/`input`. */
function wrapUpInput(args: unknown): NextStep | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const candidate of [record, record.arguments, record.input]) {
    const parsed = parseNextStep(candidate);
    if (parsed.ok) return parsed.value;
  }
  return null;
}
