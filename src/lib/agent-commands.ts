import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { SUBAGENT_COMMAND } from "./subthread-orchestration";

export interface AgentCommand {
  name: string;
  description: string;
  inputHint?: string | null;
  source: "agent" | "client";
}

/** Client command: fork this conversation onto another agent. */
export const CONTINUE_COMMAND = "continue";

/** Commands the composer handles itself — never forwarded to the agent. */
export const CLIENT_COMMANDS: AgentCommand[] = [
  {
    name: SUBAGENT_COMMAND,
    description: "Orchestrate subthreads across your installed agents",
    inputHint: null,
    source: "client",
  },
  {
    name: CONTINUE_COMMAND,
    description: "Continue this conversation with another agent",
    inputHint: null,
    source: "client",
  },
];

/** Map agent-advertised AvailableCommand[] into UI autocomplete items. */
export function commandsFromAvailable(commands: AvailableCommand[]): AgentCommand[] {
  return (commands ?? []).map((command) => ({
    name: command.name,
    description: command.description ?? "",
    inputHint:
      command.input && typeof command.input === "object" && "hint" in command.input
        ? ((command.input as { hint?: string }).hint ?? null)
        : null,
    source: "agent" as const,
  }));
}

/**
 * Agent-advertised commands plus the client-side ones. A client command wins
 * over a same-named agent command — the composer intercepts its trigger, so
 * the agent variant would be unreachable anyway.
 */
export function mergeAgentCommands(commands: AvailableCommand[]): AgentCommand[] {
  const clientNames = new Set(CLIENT_COMMANDS.map((command) => command.name));
  return [
    ...commandsFromAvailable(commands).filter((command) => !clientNames.has(command.name)),
    ...CLIENT_COMMANDS,
  ];
}

export function matchAgentCommands(commands: AgentCommand[], query: string): AgentCommand[] {
  const normalized = query.toLowerCase();
  return [...commands]
    .sort(
      (a, b) =>
        Number(b.name.toLowerCase().startsWith(normalized)) -
        Number(a.name.toLowerCase().startsWith(normalized)),
    )
    .filter((command) => command.name.toLowerCase().includes(normalized));
}

/** Insert command text for the input box; adds trailing space when input hint exists. */
export function formatCommandInsert(command: AgentCommand): string {
  const base = `/${command.name}`;
  if (command.inputHint) return `${base} `;
  return base;
}
