import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";
import {
  applyFullAccessEnv,
  fullAccessOption,
  fullAccessPermissionResponse,
} from "./full-access.ts";
import { BUILTIN_ACP_AGENTS } from "./registry.ts";

function request(options: acp.PermissionOption[]): acp.RequestPermissionRequest {
  return {
    sessionId: "s1",
    toolCall: { toolCallId: "t1", title: "Run date" },
    options,
  };
}

const allowOnce = { optionId: "yes", name: "Allow", kind: "allow_once" } as const;
const allowAlways = { optionId: "always", name: "Always", kind: "allow_always" } as const;
const reject = { optionId: "no", name: "Reject", kind: "reject_once" } as const;

describe("full access", () => {
  test("names each mode-switching harness's auto-approve setting", () => {
    expect(fullAccessOption("claude-agent-acp")).toEqual({
      configId: "mode",
      value: "bypassPermissions",
    });
    expect(fullAccessOption("codex-acp")?.value).toBe("agent-full-access");
    expect(fullAccessOption("copilot-acp")).toEqual({ configId: "allow_all", value: "on" });
    expect(fullAccessOption("cursor-acp")).toBeNull();
    expect(fullAccessOption("pipper-mock")).toBeNull();
  });

  test("allows prompts once for harnesses without a setting", () => {
    for (const driver of ["cursor-acp", "opencode-acp", "grok-acp"]) {
      expect(
        fullAccessPermissionResponse(driver, request([reject, allowAlways, allowOnce])),
      ).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    }
    expect(fullAccessPermissionResponse("cursor-acp", request([reject, allowAlways]))).toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    });
  });

  test("leaves prompts to the user otherwise", () => {
    expect(fullAccessPermissionResponse("claude-agent-acp", request([allowOnce]))).toBeNull();
    expect(fullAccessPermissionResponse("cursor-acp", request([reject]))).toBeNull();
  });

  test("opencode allows everything through its inline config, keeping the user's", () => {
    const env: Record<string, string> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "x/y", permission: { bash: "ask" } }),
    };
    applyFullAccessEnv("opencode-acp", env);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ model: "x/y", permission: "allow" });

    const fresh: Record<string, string> = {};
    applyFullAccessEnv("opencode-acp", fresh);
    expect(fresh.OPENCODE_CONFIG_CONTENT).toBe('{"permission":"allow"}');

    const other: Record<string, string> = {};
    applyFullAccessEnv("codex-acp", other);
    expect(other).toEqual({});
  });

  test("Cursor and Grok launch with their auto-approve flags", () => {
    const args = (id: string) => BUILTIN_ACP_AGENTS.find((agent) => agent.id === id)?.args;
    expect(args("cursor-acp")).toEqual(["--yolo", "acp"]);
    expect(args("grok-acp")).toEqual(["agent", "--always-approve", "stdio"]);
  });
});
