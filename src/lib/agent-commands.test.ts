import { describe, expect, test } from "vitest";
import {
  commandsFromAvailable,
  formatCommandInsert,
  matchAgentCommands,
  mergeAgentCommands,
} from "./agent-commands";

describe("agent slash commands", () => {
  test("maps agent-advertised commands and appends the client-side ones", () => {
    const commands = mergeAgentCommands([
      { name: "compact", description: "agent compact" },
      { name: "explain", description: "Explain the current code", input: { hint: "topic" } },
    ] as never);

    expect(commands).toEqual([
      {
        name: "compact",
        description: "agent compact",
        inputHint: null,
        source: "agent",
      },
      {
        name: "explain",
        description: "Explain the current code",
        inputHint: "topic",
        source: "agent",
      },
      {
        name: "subagent",
        description: "Orchestrate subthreads across your installed agents",
        inputHint: null,
        source: "client",
      },
      {
        name: "continue",
        description: "Continue this conversation with another agent",
        inputHint: null,
        source: "client",
      },
    ]);
    expect(commandsFromAvailable([])).toEqual([]);
  });

  test("a client command shadows a same-named agent command", () => {
    const commands = mergeAgentCommands([
      { name: "subagent", description: "agent-side variant" },
    ] as never);
    const subthread = commands.filter((command) => command.name === "subagent");
    expect(subthread).toHaveLength(1);
    expect(subthread[0]!.source).toBe("client");
  });

  test("matches case-insensitively and ranks prefix matches before substring matches", () => {
    const commands = [
      { name: "recompact", description: "", source: "agent" as const },
      { name: "compact", description: "", source: "agent" as const },
      { name: "compare", description: "", source: "agent" as const },
    ];

    expect(matchAgentCommands(commands, "comp").map((command) => command.name)).toEqual([
      "compact",
      "compare",
      "recompact",
    ]);
    expect(matchAgentCommands(commands, "PACT").map((command) => command.name)).toEqual([
      "recompact",
      "compact",
    ]);
  });

  test("formatCommandInsert adds trailing space when input hint exists", () => {
    expect(formatCommandInsert({ name: "web", description: "", source: "agent" })).toBe("/web");
    expect(
      formatCommandInsert({ name: "web", description: "", inputHint: "query", source: "agent" }),
    ).toBe("/web ");
  });
});
