import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import { probeAgentById, probeAgentHandshake } from "./handshake-probe.ts";

function writeScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/** A descriptor that runs `node <script>` directly, bypassing PATH detection entirely. */
function nodeScriptDescriptor(scriptPath: string): AcpAgentDescriptor {
  return {
    id: "test-agent",
    name: "test-agent",
    displayName: "Test Agent",
    command: process.execPath,
    args: [scriptPath],
    installKind: "binary",
  };
}

/** Minimal agent script: initialize + session/new (+ optional auth fail). */
function scriptedAgentBody(opts: {
  authMethodsOnInit?: boolean;
  sessionNewAuthRequired?: boolean;
  sessionNewOk?: boolean;
}): string {
  const authMethods = opts.authMethodsOnInit
    ? `authMethods: [{ id: "login", name: "Log in" }],`
    : `authMethods: [],`;
  const sessionHandler = opts.sessionNewAuthRequired
    ? `
        if (msg.method === "session/new") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: "Authentication required" },
          }) + "\\n");
          return;
        }
      `
    : opts.sessionNewOk === false
      ? `
        if (msg.method === "session/new") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32001, message: "session boom" },
          }) + "\\n");
          return;
        }
      `
      : `
        if (msg.method === "session/new") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessionId: "probe-session-1" },
          }) + "\\n");
          return;
        }
        if (msg.method === "session/close") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: null,
          }) + "\\n");
          return;
        }
      `;

  return `
      import { createInterface } from "node:readline";
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: 1,
              ${authMethods}
            },
          }) + "\\n");
          return;
        }
        ${sessionHandler}
      });
      `;
}

describe("probeAgentHandshake", () => {
  test("pipper-mock reports ready after initialize + session/new", async () => {
    const result = await probeAgentById("pipper-mock");
    expect(result.status).toBe("ready");
  });

  test("descriptor already marked unavailable short-circuits to needs-install without spawning", async () => {
    const result = await probeAgentHandshake({
      id: "missing-agent",
      name: "missing-agent",
      displayName: "Missing Agent",
      command: "definitely-not-a-real-binary-xyz",
      args: [],
      available: false,
      installHint: "Install the thing first.",
    });
    expect(result.status).toBe("needs-install");
    expect(result.message).toContain("Install the thing first");
  });

  test("agent reporting supported authMethods is still classified ready when session/new succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipper-probe-"));
    const script = writeScript(
      dir,
      "auth-methods-ok-agent.mjs",
      scriptedAgentBody({ authMethodsOnInit: true, sessionNewOk: true }),
    );

    const result = await probeAgentHandshake(nodeScriptDescriptor(script));
    expect(result).toEqual({ agentId: "test-agent", status: "ready" });
  });

  test("session/new auth_required is classified as needs-auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipper-probe-"));
    const script = writeScript(
      dir,
      "auth-required-session-agent.mjs",
      scriptedAgentBody({ authMethodsOnInit: true, sessionNewAuthRequired: true }),
    );

    const result = await probeAgentHandshake({
      ...nodeScriptDescriptor(script),
      authHint: "Run login first.",
    });
    expect(result.status).toBe("needs-auth");
    expect(result.message).toContain("Run login first");
  });

  test("session/new non-auth failure is classified as error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipper-probe-"));
    const script = writeScript(
      dir,
      "session-fail-agent.mjs",
      scriptedAgentBody({ sessionNewOk: false }),
    );

    const result = await probeAgentHandshake(nodeScriptDescriptor(script));
    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });

  test("agent that never responds is classified as an error after the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipper-probe-"));
    const script = writeScript(
      dir,
      "silent-agent.mjs",
      `
      // Never responds to stdin; just idles.
      setInterval(() => {}, 1000);
      `,
    );

    const result = await probeAgentHandshake(nodeScriptDescriptor(script), { timeoutMs: 300 });
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/did not respond/i);
  });

  test("agent that crashes immediately is classified as an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipper-probe-"));
    const script = writeScript(
      dir,
      "crashing-agent.mjs",
      `
      console.error("boom: missing dependency");
      process.exit(1);
      `,
    );

    const result = await probeAgentHandshake(nodeScriptDescriptor(script));
    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });

  test("probes of accounts of one driver never run at the same time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipper-probe-"));
    const log = join(dir, "log.txt");
    // Logs when it starts and right before it answers session/new, after a
    // delay long enough that two overlapping probes would interleave.
    const script = writeScript(
      dir,
      "slow-agent.mjs",
      `
      import { appendFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      const name = process.argv[2];
      appendFileSync(${JSON.stringify(log)}, "start " + name + "\\n");
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, authMethods: [] } }) + "\\n");
        } else if (msg.method === "session/new") {
          setTimeout(() => {
            appendFileSync(${JSON.stringify(log)}, "end " + name + "\\n");
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s" } }) + "\\n");
          }, 200);
        }
      });
      `,
    );
    const account = (id: string): AcpAgentDescriptor => ({
      ...nodeScriptDescriptor(script),
      id,
      driverId: "slow-driver",
      args: [script, id],
    });

    const results = await Promise.all([
      probeAgentHandshake(account("slow-driver:a")),
      probeAgentHandshake(account("slow-driver:b")),
    ]);

    expect(results.map((r) => r.status)).toEqual(["ready", "ready"]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "start slow-driver:a",
      "end slow-driver:a",
      "start slow-driver:b",
      "end slow-driver:b",
    ]);
  });

  test("a failed probe does not block the next probe of the same driver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipper-probe-"));
    const crash = writeScript(dir, "crash.mjs", `process.exit(1);`);
    const ok = writeScript(dir, "ok.mjs", scriptedAgentBody({}));
    const first = probeAgentHandshake({
      ...nodeScriptDescriptor(crash),
      id: "same:a",
      driverId: "same",
    });
    const second = probeAgentHandshake({
      ...nodeScriptDescriptor(ok),
      id: "same:b",
      driverId: "same",
    });
    expect((await first).status).toBe("error");
    expect((await second).status).toBe("ready");
  });

  test("the agent runs in the home directory, not the app's working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipper-probe-"));
    const out = join(dir, "cwd.txt");
    const script = writeScript(
      dir,
      "cwd-agent.mjs",
      `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(out)}, process.cwd());
      ${scriptedAgentBody({})}
      `,
    );

    const result = await probeAgentHandshake(nodeScriptDescriptor(script));
    expect(result.status).toBe("ready");
    expect(realpathSync(readFileSync(out, "utf8"))).toBe(realpathSync(homedir()));
  });

  test("probeAgentById returns an error for an unknown agent id", async () => {
    const result = await probeAgentById("not-a-real-agent-id");
    expect(result.status).toBe("error");
  });
});
