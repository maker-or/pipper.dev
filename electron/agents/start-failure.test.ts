import { describe, expect, test } from "vitest";
import { classifyAgentStartFailure } from "./start-failure.ts";

/** Errors and stderr shaped like what real agents produced when they failed to start. */
describe("classifyAgentStartFailure", () => {
  test("npx refusing to run in a project folder is a package install failure", () => {
    expect(
      classifyAgentStartFailure({
        error: new Error("ACP connection closed"),
        stderr: "npm error code EBADDEVENGINES\nnpm error EBADDEVENGINES Invalid devEngines",
        exitCode: 1,
      }),
    ).toBe("package_install_failed");
  });

  test("a half-installed Codex package is a package install failure, not a sign-in problem", () => {
    expect(
      classifyAgentStartFailure({
        error: Object.assign(new Error("Codex process has exited with code 1"), { code: 1001 }),
        stderr:
          "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
      }),
    ).toBe("package_install_failed");
  });

  test("a missing command is not installed", () => {
    expect(classifyAgentStartFailure({ error: new Error("spawn devin ENOENT") })).toBe(
      "not_installed",
    );
    expect(
      classifyAgentStartFailure({ error: new Error("Devin is not installed. Install the CLI.") }),
    ).toBe("not_installed");
  });

  test("an agent asking for a login is auth required", () => {
    expect(
      classifyAgentStartFailure({
        error: Object.assign(new Error("Authentication required"), { code: -32000 }),
      }),
    ).toBe("auth_required");
    expect(
      classifyAgentStartFailure({
        error: new Error("exited (code 1)"),
        stderr: '403 "unauthorized: not authorized to use this Copilot feature"',
        exitCode: 1,
      }),
    ).toBe("auth_required");
  });

  test("a handshake that never answers is a timeout", () => {
    expect(
      classifyAgentStartFailure({ error: new Error("agent/initialize timed out after 120000ms") }),
    ).toBe("timeout");
  });

  test("other JSON-RPC errors are protocol errors", () => {
    expect(
      classifyAgentStartFailure({
        error: Object.assign(new Error("Invalid params"), { code: -32602 }),
      }),
    ).toBe("protocol_error");
  });

  test("a process that dies without a known cause exited early", () => {
    expect(
      classifyAgentStartFailure({ error: new Error("ACP connection closed"), exitCode: 139 }),
    ).toBe("exited_early");
  });

  test("anything else is unknown", () => {
    expect(classifyAgentStartFailure({ error: new Error("something odd") })).toBe("unknown");
    expect(classifyAgentStartFailure({ error: "not an error" })).toBe("unknown");
  });
});
