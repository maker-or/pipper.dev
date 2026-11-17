import { describe, expect, test } from "vitest";
import { AGENT_TASK_SERVER_INSTRUCTIONS } from "../agent-tasks/agent-task-tools.ts";
import { BROWSER_SERVER_INSTRUCTIONS } from "../browser/browser-tools.ts";

// Claude Code cuts each MCP server's instructions at about 2,000 characters and
// appends "[truncated]", so rules past that never reach the model. Every
// request also carries them, so each character costs tokens on every turn.
const CLAUDE_INSTRUCTIONS_LIMIT = 2000;

describe("MCP server instructions", () => {
  test.each([
    ["pipper-agents", AGENT_TASK_SERVER_INSTRUCTIONS],
    ["pipper-browser", BROWSER_SERVER_INSTRUCTIONS],
  ])("%s reaches the model whole", (_name, instructions) => {
    expect(instructions.length).toBeLessThanOrEqual(CLAUDE_INSTRUCTIONS_LIMIT);
  });

  test("every rule area survives the cut", () => {
    for (const rule of ["wrap_up", "create_thread", "start_subthread", "add_connector"]) {
      expect(AGENT_TASK_SERVER_INSTRUCTIONS).toContain(rule);
    }
    for (const rule of ["widget_guide", "preview_widget", "show_widget", "browser_open"]) {
      expect(BROWSER_SERVER_INSTRUCTIONS).toContain(rule);
    }
  });
});
