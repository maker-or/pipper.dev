import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BUILTIN_ACP_AGENTS,
  listRegisteredAgents,
  probeAgentAvailability,
  resolveAgentSpawn,
} from "./registry.ts";

describe("ACP agent registry", () => {
  test("catalog includes Cursor, Codex, Claude, Gemini, Copilot, Devin, and Antigravity adapters", () => {
    const ids = BUILTIN_ACP_AGENTS.map((a) => a.id);
    expect(ids).toContain("cursor-acp");
    expect(ids).toContain("codex-acp");
    expect(ids).toContain("claude-agent-acp");
    expect(ids).toContain("gemini-acp");
    expect(ids).toContain("copilot-acp");
    expect(ids).toContain("devin-acp");
    expect(ids).toContain("antigravity-acp");

    const cursor = BUILTIN_ACP_AGENTS.find((a) => a.id === "cursor-acp")!;
    expect(cursor.command).toBe("agent");
    expect(cursor.args).toEqual(["--yolo", "acp"]);
    expect(cursor.docsUrl).toContain("cursor.com/docs/cli/acp");

    const codex = BUILTIN_ACP_AGENTS.find((a) => a.id === "codex-acp")!;
    expect(codex.npmPackage).toBe("@agentclientprotocol/codex-acp");
    expect(codex.installKind).toBe("npx");
    expect(codex.detectCommands).toContain("codex-acp");
    expect(codex.docsUrl).toContain("codex-acp");

    const claude = BUILTIN_ACP_AGENTS.find((a) => a.id === "claude-agent-acp")!;
    expect(claude.npmPackage).toBe("@agentclientprotocol/claude-agent-acp");
    expect(claude.docsUrl).toContain("claude-agent-acp");

    const gemini = BUILTIN_ACP_AGENTS.find((a) => a.id === "gemini-acp")!;
    expect(gemini.command).toBe("gemini");
    expect(gemini.args).toEqual(["--acp"]);
    expect(gemini.npmPackage).toBe("@google/gemini-cli");
    expect(gemini.docsUrl).toContain("geminicli.com/docs/cli/acp-mode");

    const copilot = BUILTIN_ACP_AGENTS.find((a) => a.id === "copilot-acp")!;
    expect(copilot.command).toBe("copilot");
    expect(copilot.args).toEqual(["--acp", "--stdio"]);
    expect(copilot.npmPackage).toBe("@github/copilot");
    expect(copilot.docsUrl).toContain("copilot-cli-reference/acp-server");

    const antigravity = BUILTIN_ACP_AGENTS.find((a) => a.id === "antigravity-acp")!;
    expect(antigravity.npmPackage).toBeUndefined();
    expect(antigravity.command).toBe("agy_acp_server.par");
    expect(antigravity.installKind).toBe("binary");
    expect(antigravity.env).toBeUndefined();
    expect(antigravity.detectCommands).toEqual(["agy_acp_server.par", "agy_acp_server.exe"]);
    expect(antigravity.docsUrl).toContain("antigravity.google");

    const devin = BUILTIN_ACP_AGENTS.find((a) => a.id === "devin-acp")!;
    expect(devin.command).toBe("devin");
    expect(devin.args).toEqual(["acp"]);
    expect(devin.installKind).toBe("binary");
    expect(devin.detectCommands).toContain("devin");
    expect(devin.docsUrl).toContain("docs.devin.ai/desktop/acp");
  });

  test("npx-backed agent resolution is idempotent across repeated re-probes", () => {
    // resolveAgentSpawn re-probes an already-probed descriptor to pick up fresh
    // PATH state; the npx `-y <pkg>` prefix must not accumulate across re-probes.
    // Use claude-agent-acp: it has no globally installed `claude-agent-acp` binary
    // on PATH, so it reliably exercises the npx branch rather than the binary branch.
    const claude = BUILTIN_ACP_AGENTS.find((a) => a.id === "claude-agent-acp")!;
    let probed = probeAgentAvailability(claude);
    for (let i = 0; i < 3; i++) {
      probed = probeAgentAvailability(probed);
    }
    const pkgOccurrences = probed.args.filter(
      (a) => a === "@agentclientprotocol/claude-agent-acp",
    ).length;
    expect(pkgOccurrences).toBeLessThanOrEqual(1);
    expect(probed.args.filter((a) => a === "-y").length).toBeLessThanOrEqual(1);
  });

  test("listRegisteredAgents probes availability without throwing", () => {
    const agents = listRegisteredAgents();
    expect(agents.length).toBeGreaterThanOrEqual(3);
    for (const agent of agents) {
      expect(typeof agent.available).toBe("boolean");
      expect(agent.displayName.length).toBeGreaterThan(0);
    }
    const mock = agents.find((a) => a.id === "pipper-mock");
    expect(mock?.available).toBe(true);
  });

  test("probeAgentAvailability marks mock as always available", () => {
    const mock = BUILTIN_ACP_AGENTS.find((a) => a.id === "pipper-mock")!;
    const probed = probeAgentAvailability(mock);
    expect(probed.available).toBe(true);
  });

  test("resolveAgentSpawn for mock returns node + mock-agent.mjs", () => {
    const mock = listRegisteredAgents().find((a) => a.id === "pipper-mock")!;
    const spawn = resolveAgentSpawn(mock);
    expect(spawn.args.some((a) => a.includes("mock-agent.mjs"))).toBe(true);
  });

  test("resolveAgentSpawn for codex-acp resolves via npx or detected binary", () => {
    const codex = listRegisteredAgents().find((a) => a.id === "codex-acp");
    if (!codex?.available) return; // skip if neither codex-acp nor npx is on PATH
    const spawn = resolveAgentSpawn(codex);
    if (/(?:^|[/\\])npx(?:\.cmd)?$/i.test(spawn.command)) {
      // npx fallback path: args must contain -y and the package name exactly once
      expect(spawn.args).toContain("-y");
      expect(spawn.args).toContain("@agentclientprotocol/codex-acp");
    } else {
      // detectCommands found a codex-acp binary directly (e.g. global install or node_modules/.bin)
      expect(spawn.command).toMatch(/codex-acp/);
    }
    // Must never set Electron-specific env vars (no longer bundled)
    expect(spawn.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(spawn.env.ELECTRON_NO_ASAR).toBeUndefined();
    expect(spawn.env.CODEX_PATH).toBeUndefined();
  });

  test("codex-acp npx resolution is idempotent across repeated re-probes", () => {
    const codex = BUILTIN_ACP_AGENTS.find((a) => a.id === "codex-acp")!;
    let probed = probeAgentAvailability(codex);
    for (let i = 0; i < 3; i++) {
      probed = probeAgentAvailability(probed);
    }
    const pkgOccurrences = probed.args.filter((a) => a === "@agentclientprotocol/codex-acp").length;
    expect(pkgOccurrences).toBeLessThanOrEqual(1);
    expect(probed.args.filter((a) => a === "-y").length).toBeLessThanOrEqual(1);
  });

  test("resolveAgentSpawn for missing binary agent throws with install hint", () => {
    const fake: (typeof BUILTIN_ACP_AGENTS)[number] = {
      id: "missing-binary-agent",
      name: "missing",
      displayName: "Missing Binary",
      command: "definitely-not-a-real-acp-binary-xyz",
      args: ["acp"],
      installKind: "binary",
      detectCommands: ["definitely-not-a-real-acp-binary-xyz"],
      installHint: "Install the missing binary first.",
    };
    expect(() => resolveAgentSpawn(fake)).toThrow(/Install the missing binary first/);
  });

  describe("cursor-acp binary resolution ignores unrelated `agent` CLIs", () => {
    let dir: string;
    let originalPath: string | undefined;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "pipper-agent-detect-"));
    });

    afterEach(() => {
      if (originalPath !== undefined) process.env.PATH = originalPath;
    });

    test("skips a foreign `agent` binary earlier on PATH and finds the real Cursor CLI", () => {
      // On Windows, resolution only probes PATHEXT-suffixed names (agent.exe,
      // agent.cmd, ...), never the bare filename — match that shape here.
      // Put the real CLI under a path containing "cursor" so looksLikeCursorAgentBinary
      // accepts it without needing a symlink (Windows CI often lacks symlink privilege).
      const ext = process.platform === "win32" ? ".cmd" : "";
      const fakeDir = join(dir, "fake-bin");
      const realDir = join(dir, "cursor-bin");
      mkdirSync(fakeDir, { recursive: true });
      mkdirSync(realDir, { recursive: true });

      const fakeAgent = join(fakeDir, `agent${ext}`);
      writeFileSync(fakeAgent, "#!/bin/sh\necho fake\n");
      chmodSync(fakeAgent, 0o755);

      const realAgent = join(realDir, `agent${ext}`);
      writeFileSync(realAgent, "#!/bin/sh\necho real\n");
      chmodSync(realAgent, 0o755);

      originalPath = process.env.PATH;
      process.env.PATH = [fakeDir, realDir].join(process.platform === "win32" ? ";" : ":");

      const cursor = BUILTIN_ACP_AGENTS.find((a) => a.id === "cursor-acp")!;
      const probed = probeAgentAvailability(cursor);

      expect(probed.available).toBe(true);
      expect(probed.resolvedCommand).toBe(realAgent);
      expect(existsSync(fakeAgent)).toBe(true);
    });
  });
});
