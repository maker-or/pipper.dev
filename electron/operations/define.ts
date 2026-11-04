import { z } from "zod";

/**
 * One definition per operation on Pipper's own state, called by the renderer
 * (IPC) and by agents (the `pipper-agents` MCP server) alike. The tier decides
 * what an agent call may do without the user; the user's own clicks are never
 * gated. See docs/capabilities/design.md.
 */

export type OperationTier = "read" | "local" | "grant" | "destructive";

export type Caller = { kind: "user" } | { kind: "agent"; threadId: string };

export interface OperationContext {
  caller: Caller;
}

/** What the confirm card shows for a destructive call. */
export interface Confirmation {
  /** "Delete workspace feature-auth". */
  title: string;
  /** The hold button's verb: "Hold to delete". */
  verb: string;
  /** What is lost, computed by Pipper; never taken from the agent. */
  impact: string[];
  /**
   * Counts behind `impact`. When the user confirms, Pipper measures again and
   * asks for a new hold if any count grew.
   */
  measures: Record<string, number>;
}

/**
 * What the one-click card shows for a `grant` call: a change that widens what
 * agents can do. Each grant is its own decision; there's no "allow for this
 * thread".
 */
export interface Grant {
  /** "Change Pipper settings". */
  title: string;
  /** One line per widening change, written by Pipper: "Browser for agents: off → on". */
  changes: string[];
}

export interface Operation<I, O> {
  id: string;
  tier: OperationTier;
  input: z.ZodType<I>;
  /**
   * Agent calls only: a reason the call can never run, whatever the user
   * says (deleting the caller's own thread). Null when it may run.
   */
  forbid?: (input: I, ctx: AgentContext) => Promise<string | null>;
  /** Destructive agent calls: true when the caller owns all it would destroy. */
  owned?: (input: I, ctx: AgentContext) => Promise<boolean>;
  /** Destructive agent calls on what the caller doesn't own: the card. */
  describe?: (input: I, ctx: AgentContext) => Promise<Confirmation>;
  /**
   * Agent calls only: raises a `local` call to `grant` from its input. The
   * card to show, or null when nothing in the input widens anything.
   */
  grant?: (input: I, ctx: AgentContext) => Promise<Grant | null>;
  run: (input: I, ctx: OperationContext) => Promise<O>;
}

export interface AgentContext extends OperationContext {
  caller: { kind: "agent"; threadId: string };
  /** The caller's thread, then its parent, its parent's parent, … */
  lineage: string[];
  /**
   * True for the caller's own thread and its descendants (child threads,
   * their children, …). False for null: what no thread created is the user's.
   */
  owns: (threadId: string | null) => boolean;
}

export function defineOperation<I, O>(operation: Operation<I, O>): Operation<I, O> {
  return operation;
}

/** Bad input, worded for whoever sent it; agents read it and call again. */
export class OperationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationInputError";
  }
}

export function parseWith<I>(schema: z.ZodType<I>, raw: unknown): I {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new OperationInputError(z.prettifyError(parsed.error));
  return parsed.data;
}

export function parseInput<I>(operation: Operation<I, unknown>, raw: unknown): I {
  return parseWith(operation.input, raw);
}

/** The user's own call: validated, never gated. */
export async function runAsUser<I, O>(operation: Operation<I, O>, raw: unknown): Promise<O> {
  return operation.run(parseInput(operation, raw), { caller: { kind: "user" } });
}

export type AgentCallOutcome<O> =
  | { status: "done"; result: O }
  | { status: "needs_confirmation"; input: unknown; confirmation: Confirmation }
  | { status: "needs_grant"; input: unknown; grant: Grant };

/**
 * An agent's call. `read` and `local` run. `grant`, or a `local` call whose
 * input widens something, returns the one-click card to show. `destructive`
 * runs when the caller owns everything it would destroy; otherwise it returns
 * the hold-to-confirm card. The caller of this function asks the user (see
 * AgentTaskService) and then calls `operation.run` itself.
 */
export async function callAsAgent<I, O>(
  operation: Operation<I, O>,
  raw: unknown,
  ctx: AgentContext,
): Promise<AgentCallOutcome<O>> {
  const input = parseInput(operation, raw);
  const forbidden = await operation.forbid?.(input, ctx);
  if (forbidden) throw new OperationInputError(forbidden);
  const grant =
    operation.tier === "grant" || operation.tier === "local"
      ? ((await operation.grant?.(input, ctx)) ??
        (operation.tier === "grant" ? { title: operation.id, changes: [] } : null))
      : null;
  if (grant) return { status: "needs_grant", input, grant };
  if (operation.tier === "destructive" && !(await operation.owned?.(input, ctx))) {
    if (!operation.describe) {
      throw new Error(`${operation.id} is destructive but has no confirmation to show`);
    }
    return {
      status: "needs_confirmation",
      input,
      confirmation: await operation.describe(input, ctx),
    };
  }
  return { status: "done", result: await operation.run(input, ctx) };
}

/** True when any count behind a confirmation grew since the user saw it. */
export function confirmationGrew(seen: Confirmation, now: Confirmation): boolean {
  return Object.entries(now.measures).some(([key, value]) => value > (seen.measures[key] ?? 0));
}

/** An MCP tool's JSON Schema from its zod input. */
export function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return json;
}
