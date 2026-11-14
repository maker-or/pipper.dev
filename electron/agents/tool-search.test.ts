import { describe, expect, test } from "vitest";
import { applyToolSearchEnv } from "./tool-search.ts";

describe("applyToolSearchEnv", () => {
  test("Claude sessions send tool names instead of every schema", () => {
    const env: Record<string, string> = {};
    applyToolSearchEnv("claude-agent-acp", env);
    expect(env.ENABLE_TOOL_SEARCH).toBe("true");
  });

  test("keeps the user's own choice", () => {
    const env: Record<string, string> = { ENABLE_TOOL_SEARCH: "false" };
    applyToolSearchEnv("claude-agent-acp", env);
    expect(env.ENABLE_TOOL_SEARCH).toBe("false");
  });

  test("leaves other agents alone", () => {
    const env: Record<string, string> = {};
    applyToolSearchEnv("codex-acp", env);
    expect(env).toEqual({});
  });
});
