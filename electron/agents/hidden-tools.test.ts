import { describe, expect, test } from "vitest";
import { HIDDEN_CLAUDE_TOOLS, sessionMeta } from "./hidden-tools.ts";

describe("sessionMeta", () => {
  test("Claude sessions start without the tools Pipper covers itself", () => {
    expect(sessionMeta("claude-agent-acp")).toEqual({
      _meta: { claudeCode: { options: { disallowedTools: [...HIDDEN_CLAUDE_TOOLS] } } },
    });
    expect(HIDDEN_CLAUDE_TOOLS).toContain("EnterWorktree");
  });

  test("keeps the core coding tools", () => {
    for (const tool of ["Bash", "Read", "Edit", "Write", "Agent", "Skill", "ToolSearch"]) {
      expect(HIDDEN_CLAUDE_TOOLS).not.toContain(tool);
    }
  });

  test("other agents get no Claude options", () => {
    expect(sessionMeta("codex-acp")).toEqual({});
  });
});
