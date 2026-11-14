import { describe, expect, test } from "vitest";
import { agentAnalyticsIdentity, sanitizeAnalyticsProperties } from "./analytics-sanitize.ts";

describe("analytics properties", () => {
  test("agent start failures and their repairs reach PostHog", () => {
    expect(
      sanitizeAnalyticsProperties({
        failure_reason: "package_install_failed",
        recovery_action: "purge_npx_cache",
        recovery_outcome: "recovered",
        recovery_retried: true,
        start_context: "readiness_check",
        exit_code: 1,
        total_duration_ms: 4913,
        selected_agents: ["codex-acp", "claude-agent-acp"],
        selected_agent_count: 2,
      }),
    ).toEqual({
      failure_reason: "package_install_failed",
      recovery_action: "purge_npx_cache",
      recovery_outcome: "recovered",
      recovery_retried: true,
      start_context: "readiness_check",
      exit_code: 1,
      total_duration_ms: 4913,
      selected_agents: ["codex-acp", "claude-agent-acp"],
      selected_agent_count: 2,
    });
  });

  test("values outside the known categories are dropped, not sent as free text", () => {
    const sanitized = sanitizeAnalyticsProperties({
      failure_reason: "/Users/me/secret" as never,
      recovery_action: "rm -rf" as never,
      recovery_outcome: "maybe" as never,
      start_context: "elsewhere" as never,
      exit_code: Number.NaN,
    });
    expect(sanitized).toEqual({});
  });

  test("account names never leave the machine, in any agent field", () => {
    const sanitized = sanitizeAnalyticsProperties({
      agent_id: "codex-acp:pujitha",
      active_agent_id: "claude-agent-acp:work",
      from_agent_id: "codex-acp:pujitha",
      to_agent_id: "codex-acp",
      selected_agents: ["codex-acp:pujitha", "codex-acp"],
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/pujitha|work/);
    expect(sanitized.agent_id).toBe("codex-acp");
    expect(sanitized.selected_agents).toEqual(["codex-acp"]);
    expect(agentAnalyticsIdentity("codex-acp:pujitha", "codex-cli")).toEqual({
      agent_id: "codex-acp",
      agent_name: "codex-cli",
      agent_account: "additional",
    });
    expect(agentAnalyticsIdentity("codex-acp").agent_account).toBe("default");
  });
});
